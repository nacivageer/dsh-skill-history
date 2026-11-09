/**
 * dsh-skill-history — Host half.
 *
 * Serves one read-only snapshot of skill usage over the local web server:
 *
 *   GET /api/skill-history/data
 *
 * Data: `<DSH_HOME>/sessions/<workspace>/<session>/session.v4.jsonl.zstd`.
 * Only `tool/call` events whose `data.name` is `skill` count, and the skill
 * name is read from `data.arguments.name` (a JSON string, parsed again).
 *
 * The panel exists to supervise, so every number stays traceable to a session
 * file. The zstd file is appended while a session runs, so a 5 s mtime watch is
 * enough for "real time" — no tool hook, no call lost on restart.
 *
 * Two costs shaped this file:
 *
 * 1. A session log is a concatenation of zstd frames (one flush per event, more
 *    or less). The Host's Node v24 stops `zstdDecompress` at the first frame,
 *    so a whole-buffer decode returns just the header line. `inflateFrames`
 *    walks frame by frame instead.
 * 2. Decoding all ~174 files takes ~11 s, and one changed file can take
 *    hundreds of ms — too long to do inside a poll or on a keystroke. So the
 *    scan keeps per-file parse state and decodes only the bytes appended since
 *    the last pass, yielding between files.
 */

import { copyFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import * as zlib from 'node:zlib';

export const name = 'dsh-skill-history';
export const inject = ['webServer'];

/** Exact routes; the SPA fallback never sees them. */
export const ROUTE = '/api/skill-history/data';
export const GROUPS_ROUTE = '/api/skill-history/groups';

/** A fresh-enough snapshot is reused instead of re-statting on every poll. */
const SCAN_TTL_MS = 3_500;
/** The skills catalog changes rarely; refresh it at most this often. */
const CATALOG_TTL_MS = 60_000;
/** The workspace store's archive list is cheap to re-read; keep it short. */
const ARCHIVE_TTL_MS = 2_000;
/** A snapshot older than this makes the next request wait for the scan. */
const STALE_MS = 15_000;
/** Upper bound for that wait: a cold full scan must not hang the poll. */
const STALE_WAIT_MS = 4_000;

/**
 * No starting groups: a group list is personal, and a template naming the
 * author's own skills leaves every other install with four empty groups. The
 * panel works without groups — one "ungrouped" section holds the whole catalog.
 */
export const DEFAULT_GROUPS = {};

/** No template colours either; a saved file always carries its own map. */
export const DEFAULT_COLORS = {};

/** Limits for the one writable file; there is no other write surface. */
const MAX_GROUPS = 50;
const MAX_NAME = 40;
const MAX_SKILLS = 200;
const SKILL_NAME = /^[A-Za-z0-9._-]{1,80}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const MAX_BODY = 32 * 1024;
const KEEP_BACKUPS = 3;

/**
 * Decode every frame of a concatenated zstd buffer.
 *
 * `engine.bytesWritten` is the compressed bytes the decoder consumed for the
 * frame, so the walk ends exactly at EOF. A truncated tail — the writer is
 * appending right now — throws on that last frame: `consumed` then stops before
 * it (or, where the decoder rejects the whole slice, stays where it was), and
 * the next scan retries the same bytes.
 */
/** A zstd frame starts with magic 0xFD2FB528, little-endian on disk. */
function isZstdFrame(buffer) {
  return buffer.length >= 4
    && buffer[0] === 0x28 && buffer[1] === 0xb5 && buffer[2] === 0x2f && buffer[3] === 0xfd;
}

export function inflateFrames(buffer) {
  const parts = [];
  const zstdAvailable = typeof zlib.zstdDecompressSync === 'function';
  let offset = 0;
  let failed = false;
  while (offset < buffer.length) {
    let info;
    try {
      info = zlib.zstdDecompressSync(
        offset === 0 ? buffer : buffer.subarray(offset),
        { info: true },
      );
    } catch {
      // Nothing decoded at offset 0 can mean two different things: the bytes
      // are not a zstd frame at all (unknown log version, or a Node build
      // without zstd), or the file is a zstd frame that is still being written
      // and is momentarily incomplete. The magic number separates them; only
      // the former is a decoding failure worth reporting.
      failed = offset === 0 && (!zstdAvailable || !isZstdFrame(buffer));
      break;
    }
    const consumed = info.engine?.bytesWritten ?? 0;
    if (info.buffer.length > 0) parts.push(info.buffer);
    if (consumed <= 0) break;
    offset += consumed;
  }
  return { text: Buffer.concat(parts).toString('utf8'), consumed: offset, failed };
}

export function createSessionState() {
  return {
    header: null,
    title: null,
    turns: 0,
    calls: [],
    badLines: 0,
    skillEvents: 0,
    /** Bytes of the file already decoded and parsed. */
    consumed: 0,
    /** A line without its newline yet; completed by the next append. */
    tail: '',
  };
}

/**
 * Fold one text chunk into the session state.
 *
 * A corrupt line is expected — a long JSON string can pick up a real newline —
 * so each line parses alone and a failure costs exactly one line. The final
 * fragment is held in `tail` until its newline arrives.
 */
export function applySessionText(state, text) {
  const lines = (state.tail + text).split('\n');
  state.tail = lines.pop() ?? '';
  for (const line of lines) {
    if (line === '') continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      state.badLines += 1;
      continue;
    }
    const type = event.type;
    if (type === 'session') {
      if (state.header === null) state.header = event;
      continue;
    }
    if (type === 'session/title') {
      if (typeof event.data?.title === 'string') state.title = event.data.title;
      continue;
    }
    if (type === 'turn/start') {
      state.turns += 1;
      continue;
    }
    if (type !== 'tool/call') continue;
    const data = event.data;
    if (!data || data.name !== 'skill') continue;
    state.skillEvents += 1;
    let args = data.arguments;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        continue;
      }
    }
    const skill = typeof args?.name === 'string' ? args.name : null;
    if (skill === null || typeof event.time !== 'number') continue;
    state.calls.push({ skill, t: event.time });
  }
  return state;
}

/** Whole-file convenience, also used by the parser test. */
export function parseSession(text) {
  const state = createSessionState();
  applySessionText(state, text);
  state.consumed = 0;
  return state;
}

/**
 * Minimal SKILL.md front-matter reader: `key: value`, quoted values, and the
 * `|` / `>` block forms. It is not a YAML parser — the panel only needs the
 * two prose fields, and a malformed file may cost a description, never a scan.
 */
export function parseSkillFrontmatter(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return {};
  const out = {};
  let key = null;
  let block = null;
  const flush = () => {
    if (key !== null && block !== null) {
      out[key] = block.join(' ').replace(/\s+/g, ' ').trim();
    }
    key = null;
    block = null;
  };
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '---') {
      flush();
      break;
    }
    if (block !== null) {
      if (line.trim() === '') {
        block.push('');
        continue;
      }
      if (/^\s+/.test(line)) {
        block.push(line.trim());
        continue;
      }
      flush();
    }
    const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (match === null) continue;
    key = match[1];
    let value = match[2].trim();
    if (/^[|>][+-]?$/.test(value)) {
      block = [];
      continue;
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
    key = null;
  }
  flush();
  return out;
}

/** Before this, a timestamp is a placeholder (epoch) rather than a real date. */
const MIN_PLAUSIBLE_MS = Date.UTC(2000, 0, 1);

function plausibleMs(value) {
  return Number.isFinite(value) && value >= MIN_PLAUSIBLE_MS;
}

/**
 * Creation time of a skill file. NTFS keeps the birth time across edits, which
 * is exactly what "when was this skill set up" means; mtime is the fallback for
 * filesystems that report no birth time.
 */
export async function skillCreatedAt(file) {
  if (typeof file !== 'string' || file === '') return null;
  try {
    const info = await stat(file);
    if (plausibleMs(info.birthtimeMs)) return Math.round(info.birthtimeMs);
    if (plausibleMs(info.mtimeMs)) return Math.round(info.mtimeMs);
  } catch {
    // Built-in skills live inside app.asar, where stat carries no real date.
  }
  return null;
}

/**
 * A built-in skill ships with the DSH version, so it has no per-skill creation
 * date worth showing; its "created" is the product's, not the user's.
 */
async function catalogCreatedAt(entry) {
  if (entry.source === 'bundled') return null;
  const file = typeof entry.path === 'string' ? entry.path : '';
  if (file === '' || /\.asar([/\\]|$)/i.test(file)) return null;
  return skillCreatedAt(file);
}

function sessionsRoot() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'sessions');
}

/** The workspace store: where archive state actually lives. */
function workspaceStatePath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'storages', 'workspace.json');
}

export function archivedIdsOf(parsed) {
  const list = parsed?.global?.archivedSessionIds;
  return new Set(Array.isArray(list) ? list.filter((id) => typeof id === 'string') : []);
}

let archivedCache = null;
let archivedCacheAt = 0;

/** Archived Sessions are still in the Client list but cannot be selected. */
async function readArchivedIds(force = false) {
  if (!force && archivedCache !== null && Date.now() - archivedCacheAt < ARCHIVE_TTL_MS) {
    return archivedCache;
  }
  try {
    archivedCache = archivedIdsOf(JSON.parse(await readFile(workspaceStatePath(), 'utf8')));
  } catch {
    archivedCache = archivedCache ?? new Set();
  }
  archivedCacheAt = Date.now();
  return archivedCache;
}

/** Local-time day key; the user thinks in local days, not UTC. */
function dayKey(ms) {
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Two-level walk: <workspace>/<session>/session.v4.jsonl.zstd */
async function listSessionFiles(root) {
  const files = [];
  let workspaces;
  try {
    workspaces = await readdir(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    let dirs;
    try {
      dirs = await readdir(join(root, workspace.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      files.push({
        file: join(root, workspace.name, dir.name, 'session.v4.jsonl.zstd'),
        dirName: dir.name,
      });
    }
  }
  return files;
}

function emptySnapshot() {
  return {
    now: Date.now(),
    scan: {
      files: 0,
      sessions: 0,
      calls: 0,
      skillEvents: 0,
      badLines: 0,
      failedFiles: 0,
      error: null,
      ms: 0,
      at: 0,
      ready: false,
    },
    skills: [],
    days: [],
  };
}

/** The only file this plugin writes. */
export function groupsPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'skill-history', 'groups.json');
}

/** The pre-rename location, read once so an upgrade keeps the user's groups. */
export function legacyGroupsPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'skill-stats', 'groups.json');
}

/**
 * Accept only `{ groupName: [skillName, ...] }` within fixed bounds — the
 * route has no other write surface, so the shape is the allow-list.
 */
export function normalizeGroups(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const groups = {};
  let count = 0;
  for (const [rawName, rawSkills] of Object.entries(input)) {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (name === '' || name.length > MAX_NAME) return null;
    if (!Array.isArray(rawSkills) || rawSkills.length > MAX_SKILLS) return null;
    const skills = [];
    for (const item of rawSkills) {
      if (typeof item !== 'string') return null;
      const skill = item.trim();
      if (!SKILL_NAME.test(skill)) return null;
      if (!skills.includes(skill)) skills.push(skill);
    }
    count += 1;
    if (count > MAX_GROUPS) return null;
    groups[name] = skills;
  }
  return groups;
}

/** One file, or null when it is missing or holds a shape we refuse. */
async function readGroupsFile(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    const groups = normalizeGroups(parsed?.groups);
    if (groups !== null) {
      // A colour naming a group that no longer exists is dropped, not fatal:
      // the panel keeps working and the next save rewrites a clean map.
      const colors = normalizeColors(parsed?.colors, groups) ?? {};
      return { groups, colors, defaults: false, updatedAt: parsed?.updatedAt ?? null };
    }
  } catch {
    // Missing or unreadable; the caller decides what that means.
  }
  return null;
}

export async function readGroups(file) {
  const current = await readGroupsFile(file);
  if (current !== null) return current;
  const legacy = await readGroupsFile(legacyGroupsPath());
  if (legacy !== null) return legacy;
  return { groups: DEFAULT_GROUPS, colors: DEFAULT_COLORS, defaults: true, updatedAt: null };
}

/**
 * `{ groupName: '#rrggbb' }`, only for groups that exist. A colour is
 * cosmetic, so a missing map is `{}`; a malformed one is a client bug and is
 * refused rather than silently half-applied.
 */
export function normalizeColors(input, groups) {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) return null;
  const colors = {};
  for (const [rawName, rawColor] of Object.entries(input)) {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (name === '' || name.length > MAX_NAME) return null;
    if (!Object.hasOwn(groups, name)) return null;
    if (typeof rawColor !== 'string' || !COLOR.test(rawColor)) return null;
    colors[name] = rawColor.toLowerCase();
  }
  return colors;
}

function stamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Keep the newest few backups of the previous groups file. */
async function pruneBackups(file) {
  const dir = dirname(file);
  const prefix = `${basename(file)}.bak-`;
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const backups = names.filter((name) => name.startsWith(prefix)).sort();
  for (const name of backups.slice(0, Math.max(0, backups.length - KEEP_BACKUPS))) {
    try {
      await unlink(join(dir, name));
    } catch {
      // A backup that cannot be pruned is not worth failing the save.
    }
  }
}

/**
 * Write, then read back: "saved" means the file on disk parsed to the same
 * groups, not that writeFile resolved.
 */
async function writeGroups(file, groups, colors) {
  await mkdir(dirname(file), { recursive: true });
  let backedUp = false;
  try {
    await stat(file);
    await copyFile(file, `${file}.bak-${stamp(new Date())}`);
    backedUp = true;
  } catch {
    // First save: nothing to back up.
  }
  const body = JSON.stringify({ version: 1, updatedAt: Date.now(), groups, colors }, null, 2);
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, body, 'utf8');
  await rename(temporary, file);
  await pruneBackups(file);
  const readback = await readGroups(file);
  return { backedUp, groups: readback.groups, colors: readback.colors, updatedAt: readback.updatedAt };
}

/** Let other work run between files: one file is tens of ms of sync decode. */
const yieldTurn = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Walk `<DSH_HOME>/sessions/<workspace>/<session>/session.v4.jsonl.zstd` and
 * decode only the bytes each cached entry has not consumed yet.
 *
 * Two things the panel must never do, and this function is where both are
 * enforced: count a session whose file is gone (the cache is pruned against
 * the files actually on disk), and report "0 calls" when the logs were not
 * decodable at all (`failedFiles` / `error` travel to the UI).
 */
export async function scanUsage(root, cache = new Map()) {
  const files = await listSessionFiles(root);
  const present = new Set();
  const zstdAvailable = typeof zlib.zstdDecompressSync === 'function';
  let attempted = 0;
  let failedFiles = 0;

  for (const entry of files) {
    let info;
    try {
      info = await stat(entry.file);
    } catch {
      continue;
    }
    attempted += 1;
    present.add(entry.file);
    const key = `${info.mtimeMs}:${info.size}`;
    const cached = cache.get(entry.file);
    if (cached !== undefined && cached.key === key) {
      if (cached.undecodable === true) failedFiles += 1;
      continue;
    }

    let buffer;
    try {
      buffer = await readFile(entry.file);
    } catch {
      // Unreadable right now: drop it so the next pass retries, and do not
      // keep serving the old numbers as if the file still existed.
      cache.delete(entry.file);
      continue;
    }
    // Append-only logs: decode from the last consumed byte. A shorter file
    // (rewritten or replaced) falls back to a full parse.
    const resumable = cached !== undefined
      && cached.state.consumed > 0
      && cached.state.consumed <= buffer.length;
    const state = resumable ? cached.state : createSessionState();
    const from = resumable ? state.consumed : 0;
    const { text, consumed, failed } = inflateFrames(from === 0 ? buffer : buffer.subarray(from));
    state.consumed = from + consumed;
    if (text !== '') applySessionText(state, text);

    // A non-empty file that yielded no bytes has never decoded: wrong Node
    // build or an unknown log version. A partial tail after at least one
    // frame is normal for a live session and is not an error.
    const undecodable = failed === true && state.consumed === 0 && buffer.length > 0;
    if (undecodable) failedFiles += 1;

    cache.set(entry.file, {
      key,
      sessionId: typeof state.header?.id === 'string' ? state.header.id : entry.dirName,
      state,
      undecodable,
    });
    await yieldTurn();
  }

  // Deleted sessions must stop counting. A cache entry with no file behind it
  // would otherwise keep feeding both the day table and `scan.sessions`.
  for (const file of [...cache.keys()]) {
    if (!present.has(file)) cache.delete(file);
  }

  let error = null;
  if (!zstdAvailable && attempted > 0) error = 'zstd-unavailable';
  else if (attempted > 0 && failedFiles === attempted) error = 'unreadable-logs';

  return { files: files.length, attempted, failedFiles, error };
}

export function apply(ctx) {
  const root = sessionsRoot();
  /** file path -> { key, sessionId, state } */
  const cache = new Map();
  let snapshot = emptySnapshot();
  let scanRunning = null;
  let lastScanAt = 0;
  let catalog = [];
  let catalogAt = 0;

  const readCatalog = async () => {
    if (catalog.length > 0 && Date.now() - catalogAt < CATALOG_TTL_MS) return catalog;
    const byName = new Map();
    const skills = ctx.get('skills');
    if (skills !== undefined) {
      try {
        const list = await skills.list({});
        for (const entry of list) {
          byName.set(entry.name, {
            name: entry.name,
            source: typeof entry.source === 'string' ? entry.source : 'unknown',
            modelInvocable: entry.invocation?.modelInvocable !== false,
            description: typeof entry.description === 'string' ? entry.description : '',
            whenToUse: typeof entry.whenToUse === 'string' ? entry.whenToUse : null,
            createdAt: await catalogCreatedAt(entry),
          });
        }
      } catch {
        // Fall through to the directory scan below.
      }
    }
    // `skills.list()` in a Host context sees the layers it can resolve, which
    // leaves out user skills that were never invoked. Read the user skill
    // directory too, so a skill at zero calls still gets a row — watching for
    // exactly that is the point of this panel.
    try {
      const home = process.env.DSH_HOME || join(homedir(), '.dsh');
      for (const dir of await readdir(join(home, 'skills'), { withFileTypes: true })) {
        if (!dir.isDirectory()) continue;
        const file = join(home, 'skills', dir.name, 'SKILL.md');
        let text;
        try {
          text = await readFile(file, 'utf8');
        } catch {
          continue;
        }
        const meta = parseSkillFrontmatter(text);
        const known = byName.get(dir.name);
        if (known !== undefined) {
          // `skills.list()` summaries carry no `path`, so a user skill that it
          // already lists still needs its file stat for the creation date.
          if (known.createdAt === null) known.createdAt = await skillCreatedAt(file);
          if (known.description === '') known.description = typeof meta.description === 'string' ? meta.description : '';
          if (known.whenToUse === null && typeof meta.whenToUse === 'string') known.whenToUse = meta.whenToUse;
          continue;
        }
        byName.set(dir.name, {
          name: dir.name,
          source: 'user-dsh',
          modelInvocable: true,
          description: typeof meta.description === 'string' ? meta.description : '',
          whenToUse: typeof meta.whenToUse === 'string' ? meta.whenToUse : null,
          createdAt: await skillCreatedAt(file),
        });
      }
    } catch {
      // No user skill directory in this installation.
    }
    // Skills declared by an agent preset (the cordis/dev ones) are mounted per
    // preset and stay out of the global catalog. They ship inside the app
    // archive; the desktop Host can read that path, so show their prose too.
    // Any other layout simply skips this block.
    try {
      const resources = process.resourcesPath;
      if (typeof resources === 'string' && resources !== '') {
        const presetDir = join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-agent-preset', 'skills');
        for (const dir of await readdir(presetDir, { withFileTypes: true })) {
          if (!dir.isDirectory() || byName.has(dir.name)) continue;
          const file = join(presetDir, dir.name, 'SKILL.md');
          let text;
          try {
            text = await readFile(file, 'utf8');
          } catch {
            continue;
          }
          const meta = parseSkillFrontmatter(text);
          byName.set(dir.name, {
            name: dir.name,
            source: 'bundled',
            modelInvocable: true,
            description: typeof meta.description === 'string' ? meta.description : '',
            whenToUse: typeof meta.whenToUse === 'string' ? meta.whenToUse : null,
            createdAt: null,
          });
        }
      }
    } catch {
      // No preset skill directory reachable from this Host.
    }
    catalog = [...byName.values()];
    catalogAt = Date.now();
    return catalog;
  };

  const scan = async () => {
    const started = Date.now();
    const result = await scanUsage(root, cache);
    let calls = 0;
    let skillEvents = 0;
    let badLines = 0;

    const days = new Map();
    const archived = await readArchivedIds();
    for (const entry of cache.values()) {
      const state = entry.state;
      skillEvents += state.skillEvents;
      badLines += state.badLines;
      if (state.calls.length === 0) continue;
      const byDay = new Map();
      for (const call of state.calls) {
        const key = dayKey(call.t);
        let bucket = byDay.get(key);
        if (bucket === undefined) {
          bucket = { calls: 0, bySkill: {}, first: call.t, last: call.t };
          byDay.set(key, bucket);
        }
        bucket.calls += 1;
        bucket.bySkill[call.skill] = (bucket.bySkill[call.skill] ?? 0) + 1;
        if (call.t < bucket.first) bucket.first = call.t;
        if (call.t > bucket.last) bucket.last = call.t;
      }
      const cwd = typeof state.header?.cwd === 'string' ? state.header.cwd : '';
      for (const [key, bucket] of byDay) {
        let day = days.get(key);
        if (day === undefined) {
          day = { date: key, calls: 0, sessions: [] };
          days.set(key, day);
        }
        day.calls += bucket.calls;
        day.sessions.push({
          id: entry.sessionId,
          title: state.title,
          cwd,
          archived: archived.has(entry.sessionId),
          workspace: cwd ? basename(cwd) : '',
          depth: typeof state.header?.delegationDepth === 'number' ? state.header.delegationDepth : 0,
          createdAt: typeof state.header?.createdAt === 'number' ? state.header.createdAt : 0,
          turns: state.turns,
          calls: bucket.calls,
          bySkill: bucket.bySkill,
          first: bucket.first,
          last: bucket.last,
        });
        calls += bucket.calls;
      }
    }

    const list = [...days.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
    for (const day of list) {
      day.sessions.sort((a, b) => b.calls - a.calls || b.last - a.last);
    }

    // Catalog entries stay visible with a zero count: a skill watched for
    // months and never called is exactly what this panel is for.
    const counts = new Map();
    for (const entry of cache.values()) {
      for (const call of entry.state.calls) {
        counts.set(call.skill, (counts.get(call.skill) ?? 0) + 1);
      }
    }
    const known = await readCatalog();
    const seen = new Set();
    const skills = [];
    for (const entry of known) {
      seen.add(entry.name);
      skills.push({ ...entry, count: counts.get(entry.name) ?? 0 });
    }
    for (const [skill, count] of counts) {
      if (seen.has(skill)) continue;
      skills.push({
        name: skill,
        source: 'observed',
        modelInvocable: true,
        description: '',
        whenToUse: null,
        createdAt: null,
        count,
      });
    }
    skills.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    snapshot = {
      now: Date.now(),
      scan: {
        files: result.files,
        sessions: cache.size,
        calls,
        skillEvents,
        badLines,
        failedFiles: result.failedFiles,
        error: result.error,
        ms: Date.now() - started,
        at: Date.now(),
        ready: true,
      },
      skills,
      days: list,
    };
    lastScanAt = Date.now();
    return snapshot;
  };

  const ensureFresh = () => {
    if (scanRunning !== null) return scanRunning;
    if (Date.now() - lastScanAt < SCAN_TTL_MS) return Promise.resolve(snapshot);
    scanRunning = scan()
      .catch((error) => {
        ctx.logger?.warn?.('dsh-skill-history: scan failed: %s', error?.message ?? error);
        return snapshot;
      })
      .finally(() => {
        scanRunning = null;
      });
    return scanRunning;
  };

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ROUTE,
      resource: async (request) => {
        // A page on another site must not read local session statistics.
        if (request.headers.get('sec-fetch-site') === 'cross-site') {
          return new Response('Forbidden', { status: 403 });
        }
        // Kick the refresh in the background; answer with what is ready now so
        // a cold scan can never hang the 5 s poll. After a long idle the old
        // snapshot can be minutes behind, so a stale one waits briefly instead
        // of painting yesterday's numbers on the first click.
        const refresh = ensureFresh();
        if (Date.now() - lastScanAt > STALE_MS) {
          await Promise.race([
            refresh,
            new Promise((resolve) => setTimeout(resolve, STALE_WAIT_MS)),
          ]);
        }
        return new Response(JSON.stringify(snapshot), {
          status: 200,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          },
        });
      },
    }),
    'skill-history: data route',
  );

  const file = groupsPath();

  /** A resource route only answers GET/HEAD, so the write uses a raw handler. */
  const send = (res, status, body) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(body));
  };

  const readBody = (req, limit) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const error = new Error('too large');
        error.status = 413;
        req.destroy();
        reject(error);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: GROUPS_ROUTE,
      handler: async (req, res) => {
        // A page on another site must not edit local configuration.
        if (req.headers['sec-fetch-site'] === 'cross-site') {
          send(res, 403, { error: 'forbidden' });
          return;
        }
        if (req.method === 'GET') {
          send(res, 200, await readGroups(file));
          return;
        }
        if (req.method !== 'POST') {
          res.writeHead(405, { allow: 'GET, POST' });
          res.end();
          return;
        }
        const type = req.headers['content-type'] ?? '';
        if (!String(type).includes('application/json')) {
          send(res, 415, { error: 'expected application/json' });
          return;
        }
        let body;
        try {
          body = await readBody(req, MAX_BODY);
        } catch (error) {
          send(res, error.status ?? 400, { error: error.message });
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          send(res, 400, { error: 'invalid JSON' });
          return;
        }
        const groups = normalizeGroups(parsed?.groups);
        if (groups === null) {
          send(res, 400, { error: 'invalid groups' });
          return;
        }
        const colors = normalizeColors(parsed?.colors, groups);
        if (colors === null) {
          send(res, 400, { error: 'invalid colors' });
          return;
        }
        try {
          const result = await writeGroups(file, groups, colors);
          send(res, 200, { ok: true, ...result });
        } catch (error) {
          // The old file is untouched when this path is reached; report, never retry.
          send(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }),
    'skill-history: groups route',
  );

  // Warm the cache after load rather than inside the first request.
  ctx.effect(() => {
    const timer = setTimeout(() => { void ensureFresh(); }, 500);
    return () => clearTimeout(timer);
  }, 'skill-history: warm scan');

  ctx.logger?.debug?.('dsh-skill-history: scanning %s for %s', root, ROUTE);
}
