import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

import {
  apply,
  applySessionText,
  archivedIdsOf,
  createSessionState,
  inflateFrames,
  normalizeColors,
  normalizeGroups,
  parseSession,
  parseSkillFrontmatter,
  readGroups,
  scanUsage,
} from '../index.js';

const line = (event) => `${JSON.stringify(event)}\n`;

const header = {
  type: 'session',
  version: 4,
  id: 'session-aaaa-bbbb',
  createdAt: 1794000000000,
  cwd: 'C:\\work\\demo',
  delegationDepth: 0,
};

const call = (time, name) => ({
  type: 'tool/call',
  seq: time,
  time,
  data: { turn: 1, step: 1, callId: `call_${time}`, name: 'skill', arguments: JSON.stringify({ name }) },
});

test('inflateFrames joins every concatenated frame', () => {
  const chunks = ['{"type":"a"}\n', '{"type":"b"}\n', '{"type":"c"}\n'];
  const buffer = Buffer.concat(chunks.map((chunk) => zstdCompressSync(Buffer.from(chunk, 'utf8'))));
  const { text, consumed } = inflateFrames(buffer);
  assert.equal(text, chunks.join(''));
  assert.equal(consumed, buffer.length);
});

test('a partial trailing frame never fabricates output', () => {
  const first = zstdCompressSync(Buffer.from('{"type":"a"}\n', 'utf8'));
  const second = zstdCompressSync(Buffer.from('{"type":"b"}\n', 'utf8'));
  const { text, consumed, failed } = inflateFrames(Buffer.concat([first, second.subarray(0, second.length - 4)]));
  // Node versions differ: one decodes frame by frame and keeps the prefix, the
  // other fails the whole slice. Neither may invent text, and the next scan
  // re-reads from `consumed` once the writer finishes the frame.
  assert.ok(text === '' || text === '{"type":"a"}\n');
  assert.ok(consumed <= first.length);
  // A tail cut mid-frame is a live file being appended to, not a broken log.
  assert.equal(failed, false);
});

test('a buffer that is not zstd at all reports the failure', () => {
  const { text, consumed, failed } = inflateFrames(Buffer.from('not a zstd frame'));
  assert.equal(text, '');
  assert.equal(consumed, 0);
  assert.equal(failed, true);
});

test('an incomplete last line waits in the tail for its newline', () => {
  const state = parseSession('{"type":"session","id":"s"}\n{"type":"tool/call","data":{"name":"sk');
  assert.equal(state.calls.length, 0);
  assert.ok(state.tail.startsWith('{"type":"tool/call"'));
  applySessionText(state, 'ill","arguments":"{\\"name\\":\\"memory\\"}"},"time":1794000001000}\n');
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].skill, 'memory');
  assert.equal(state.tail, '');
});

test('parseSession counts only skill calls and reads the title', () => {
  const body = [
    line(header),
    line({ type: 'session/title', data: { title: '监督用面板' } }),
    line({ type: 'turn/start', data: { turn: 1 } }),
    line({ type: 'tool/call', data: { name: 'read', arguments: '{"file_path":"x"}' } }),
    line(call(1794000001000, 'memory')),
    line(call(1794000100000, 'bilibili')),
    line({ type: 'tool/call', data: { name: 'skill', arguments: '{not json' } }),
  ].join('');
  const state = parseSession(body);
  assert.equal(state.title, '监督用面板');
  assert.equal(state.turns, 1);
  assert.deepEqual(state.calls.map((entry) => entry.skill), ['memory', 'bilibili']);
  assert.equal(state.skillEvents, 3);
});

test('a corrupt line costs one line, not the file', () => {
  const body = `${JSON.stringify(header)}\n{broken\n${JSON.stringify(call(1794000001000, 'memory'))}\n`;
  const state = parseSession(body);
  assert.equal(state.badLines, 1);
  assert.equal(state.calls.length, 1);
});

test('feeding chunks equals feeding the whole text', () => {
  const body = [
    line(header),
    line(call(1794000001000, 'memory')),
    line(call(1794000002000, 'office')),
  ].join('');
  const whole = parseSession(body);
  const state = createSessionState();
  for (let index = 0; index < body.length; index += 37) {
    applySessionText(state, body.slice(index, index + 37));
  }
  assert.deepEqual(state.calls, whole.calls);
  assert.equal(state.title, whole.title);
  assert.equal(state.tail, '');
});

test('archivedIdsOf reads the workspace store shape defensively', () => {
  const store = { global: { archivedSessionIds: ['session-a', 42, 'session-b'] } };
  assert.deepEqual([...archivedIdsOf(store)], ['session-a', 'session-b']);
  assert.deepEqual([...archivedIdsOf({})], []);
  assert.deepEqual([...archivedIdsOf({ global: { archivedSessionIds: 'nope' } })], []);
});

test('normalizeGroups refuses shapes outside the allow-list', () => {
  assert.deepEqual(normalizeGroups({ core: ['memory', 'memory'] }), { core: ['memory'] });
  assert.equal(normalizeGroups(null), null);
  assert.equal(normalizeGroups([]), null);
  assert.equal(normalizeGroups({ '': ['memory'] }), null);
  assert.equal(normalizeGroups({ core: 'memory' }), null);
  assert.equal(normalizeGroups({ core: ['../etc/passwd'] }), null);
  assert.equal(normalizeGroups({ ['x'.repeat(41)]: ['memory'] }), null);
});

test('normalizeColors accepts one hex per existing group', () => {
  const groups = { core: ['memory'], docs: [] };
  assert.deepEqual(normalizeColors({ core: '#7AA2F7' }, groups), { core: '#7aa2f7' });
  assert.deepEqual(normalizeColors(undefined, groups), {});
  assert.deepEqual(normalizeColors(null, groups), {});
  // A colour for a group that does not exist would be orphaned on the next save.
  assert.equal(normalizeColors({ gone: '#7aa2f7' }, groups), null);
  assert.equal(normalizeColors({ core: 'red' }, groups), null);
  assert.equal(normalizeColors({ core: '#7aa2f' }, groups), null);
  assert.equal(normalizeColors([], groups), null);
});

test('parseSkillFrontmatter reads the prose fields a skill list needs', () => {
  const simple = [
    '---',
    'name: memory',
    'description: 读写长期记忆库：捕获新事实到 inbox。',
    'whenToUse: 当用户提到"以前"时。',
    '---',
    '',
    '# body',
  ].join('\n');
  assert.deepEqual(parseSkillFrontmatter(simple), {
    name: 'memory',
    description: '读写长期记忆库：捕获新事实到 inbox。',
    whenToUse: '当用户提到"以前"时。',
  });

  const quoted = '---\nname: x\ndescription: "quoted: with colon"\n---\n';
  assert.equal(parseSkillFrontmatter(quoted).description, 'quoted: with colon');

  const block = '---\nname: x\ndescription: >\n  first line\n  second line\nwhenToUse: after\n---\n';
  assert.equal(parseSkillFrontmatter(block).description, 'first line second line');
  assert.equal(parseSkillFrontmatter(block).whenToUse, 'after');

  assert.deepEqual(parseSkillFrontmatter('# no front matter\n'), {});
  assert.deepEqual(parseSkillFrontmatter(''), {});
});

/* --- scanUsage: what the panel reports is what is on disk --------------- */

async function writeSessionFile(root, workspace, session, events) {
  const dir = join(root, workspace, session);
  await mkdir(dir, { recursive: true });
  const buffer = Buffer.concat(events.map((event) => zstdCompressSync(
    Buffer.from(`${JSON.stringify(event)}\n`, 'utf8'),
  )));
  const file = join(dir, 'session.v4.jsonl.zstd');
  await writeFile(file, buffer);
  return file;
}

const callCount = (cache) => [...cache.values()]
  .reduce((total, entry) => total + entry.state.calls.length, 0);

test('scanUsage counts every session file once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-history-'));
  try {
    await writeSessionFile(root, 'ws', 'a', [header, call(1794000001000, 'memory')]);
    await writeSessionFile(root, 'ws', 'b', [header, call(1794000002000, 'office'), call(1794000003000, 'office')]);
    const cache = new Map();
    const result = await scanUsage(root, cache);
    assert.equal(result.files, 2);
    assert.equal(result.error, null);
    assert.equal(cache.size, 2);
    assert.equal(callCount(cache), 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a deleted session file stops counting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-history-'));
  try {
    await writeSessionFile(root, 'ws', 'a', [header, call(1794000001000, 'memory')]);
    const gone = await writeSessionFile(root, 'ws', 'b', [header, call(1794000002000, 'office')]);
    const cache = new Map();
    await scanUsage(root, cache);
    assert.equal(callCount(cache), 2);

    await unlink(gone);
    const result = await scanUsage(root, cache);

    // `files` counts session directories, not log files: the directory stays.
    assert.equal(result.files, 2);
    assert.equal(cache.size, 1);
    assert.equal(cache.has(gone), false);
    assert.equal(callCount(cache), 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an appended frame is picked up without a full re-read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-history-'));
  try {
    const file = await writeSessionFile(root, 'ws', 'a', [header, call(1794000001000, 'memory')]);
    const cache = new Map();
    await scanUsage(root, cache);
    const consumed = cache.get(file).state.consumed;

    await appendFile(file, zstdCompressSync(Buffer.from(`${JSON.stringify(call(1794000002000, 'office'))}\n`)));
    const result = await scanUsage(root, cache);

    assert.equal(result.files, 1);
    assert.equal(cache.get(file).state.calls.length, 2);
    assert.ok(cache.get(file).state.consumed > consumed);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an undecodable log is reported instead of counted as zero', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-history-'));
  try {
    const dir = join(root, 'ws', 'bad');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), Buffer.from('this is not a zstd frame'));

    const cache = new Map();
    const result = await scanUsage(root, cache);

    assert.equal(result.failedFiles, 1);
    assert.equal(result.error, 'unreadable-logs');
    assert.equal(callCount(cache), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('groups start empty, and a pre-rename file is still read', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-skill-history-home-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const fresh = await readGroups(join(home, 'skill-history', 'groups.json'));
    assert.deepEqual(fresh.groups, {});
    assert.deepEqual(fresh.colors, {});
    assert.equal(fresh.defaults, true);

    await mkdir(join(home, 'skill-stats'), { recursive: true });
    await writeFile(
      join(home, 'skill-stats', 'groups.json'),
      JSON.stringify({ version: 1, groups: { core: ['memory'] }, colors: { core: '#7aa2f7' } }),
    );

    const migrated = await readGroups(join(home, 'skill-history', 'groups.json'));
    assert.deepEqual(migrated.groups, { core: ['memory'] });
    assert.deepEqual(migrated.colors, { core: '#7aa2f7' });
    assert.equal(migrated.defaults, false);
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

/* --- the registered Host routes, through a real apply() ---------------- */

function fakeContext(routes, disposers) {
  return {
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
    },
    get(name) {
      if (name !== 'skills') return undefined;
      return { list: async () => [] };
    },
    webServer: {
      register(spec) {
        routes.set(spec.path, spec);
        return () => routes.delete(spec.path);
      },
    },
    logger: { debug() {}, warn() {} },
  };
}

test('the data route serves the scan, and an unreadable log reaches it', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-skill-history-route-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const routes = new Map();
  const disposers = [];
  try {
    await writeSessionFile(join(home, 'sessions'), 'ws', 'a', [header, call(1794000001000, 'memory')]);
    apply(fakeContext(routes, disposers));
    const route = routes.get('/api/skill-history/data');
    assert.ok(route !== undefined);

    const response = await route.resource({ headers: new Headers() });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.scan.calls, 1);
    assert.equal(body.scan.error, null);
    assert.equal(body.scan.failedFiles, 0);
    assert.equal(body.days.length, 1);
    assert.equal(body.days[0].sessions[0].bySkill.memory, 1);

    // The scan reuses a snapshot for 3.5 s, and the warm-up scan at ~0.5 s
    // resets that clock; step past both before rewriting the log, or the
    // second request would legitimately answer from the cache.
    await new Promise((resolve) => setTimeout(resolve, 4_500));
    // Replace the log with bytes that cannot be a zstd frame: the next scan
    // must say so instead of serving a confident zero. A snapshot younger than
    // 15 s is answered immediately while the refresh runs in the background,
    // so kick the first request, then read the refreshed snapshot.
    await writeFile(join(home, 'sessions', 'ws', 'a', 'session.v4.jsonl.zstd'), Buffer.from('garbage'));
    await route.resource({ headers: new Headers() });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const failed = await (await route.resource({ headers: new Headers() })).json();
    assert.equal(failed.scan.failedFiles, 1);
    assert.equal(failed.scan.error, 'unreadable-logs');
  } finally {
    for (const dispose of disposers) dispose();
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});

test('the groups route answers GET with an empty template by default', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-skill-history-groups-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const routes = new Map();
  const disposers = [];
  try {
    apply(fakeContext(routes, disposers));
    const route = routes.get('/api/skill-history/groups');
    assert.ok(route !== undefined);

    let status = null;
    let payload = '';
    await route.handler(
      { headers: {}, method: 'GET' },
      { writeHead(code) { status = code; }, end(text) { payload = text; } },
    );
    assert.equal(status, 200);
    const body = JSON.parse(payload);
    assert.deepEqual(body.groups, {});
    assert.equal(body.defaults, true);
  } finally {
    for (const dispose of disposers) dispose();
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});
