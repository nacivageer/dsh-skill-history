# Changelog

## 0.2.0 — 2026-11-09

First public release.

- **Renamed** to `dsh-skill-history` (`dsh-skill-stats` collides with several
  existing repositories). Groups now live in
  `$DSH_HOME/skill-history/groups.json`; a pre-rename
  `$DSH_HOME/skill-stats/groups.json` is still read once, so upgrading keeps
  the groups you already saved.
- **Fixed:** a session file removed from disk kept counting until DSH
  restarted, and inflated `scan.sessions`. The scan cache is now pruned against
  the files actually present.
- **Fixed:** logs that could not be decoded (Node without zstd, unknown log
  version) were reported as “0 calls”. The snapshot now carries
  `scan.failedFiles` and `scan.error`, and the panel shows an error instead of
  a wrong zero.
- **No template groups:** a new install starts with no groups rather than four
  groups naming the author’s own skills. The panel works ungrouped.
- Added MIT license, `engines.dsh` / `engines.node`, `npm test`, CI on Windows
  and Linux, and bilingual README.

## 0.1.1

- Icon redrawn for the dark plugin list; grid dimmed.
- Content column centred to the conversation page’s width.
- “All skills” page grouped by the user’s groups; two-line descriptions with
  click-to-expand.
