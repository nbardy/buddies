# Desktop app: first release (desktop-v0.0.1), 2026-10-05

Owner request: #marketing-website thread post_01a10ac1 ("push and commit", Download for Mac on
the site, Windows/Linux to an install page, no GitHub Actions: build here and push).
Task: task_01a10b3c. Release Engineer.

## What shipped
- Branch integrate/desktop-app (worktree /tmp/unleashd-desktop-app) merged onto origin/main:
  spike notes + screenshots (from desktop-spike 9cf9a3d; the detection branch had imported the
  spike code but not its notes), biome formatting of desktop/ and tools/desktop-build.mjs, the
  site change, and the execution-gate fix below.
- Site: docs/index.html leads with Download for Mac
  (`releases/latest/download/Buddies-macos-arm64.dmg`); docs/install.html has Mac first-open
  steps (not notarized), Linux from source, Windows via WSL.
- Release asset built on this Mac with `pnpm desktop:build` (no Actions), uploaded with
  `gh release create`.

## Bug found during release testing
Current main added the copied-store gate (7c88111): Buddy execution is disabled when
UNLEASHD_BUDDIES_DB / BUDDIES_HOME / UNLEASHD_DATA_DIR point anywhere but the home defaults.
The app's stores live in ~/Library/Application Support/Buddies, so its Buddies never replied
(boot line would be "Buddy runner not started (execution disabled)"). Fix: the app sets
UNLEASHD_BUDDY_EXECUTION=1 (desktop/src/main/server-env.ts); guard
desktop/test/server-env.test.ts runs the server's own decideExecutionGate on the app's env.

## Evidence (packaged app, installed from the .dmg outside any checkout)
- Launched with `open -n --env PATH=/usr/bin:/bin:/usr/sbin:/sbin --env BUDDIES_DESKTOP_HOME=<tmp>`,
  real HOME (for agent logins). desktop.log: login-shell PATH resolved; server ready +1.8 s
  (warm) / +9.2 s (first run).
- /api/dependencies: claude ready, codex ready, no rust row.
- server.log: "Buddy runner started"; upstream: "not a git checkout; no unleashd workspace".
- Created workspace + buddy Pinger (claude/sonnet) through the API, DM "Reply with exactly the
  word PONG" -> reply `PONG` at +4.8 s, run status complete.
- Earlier build (before merging current main): server answered 30/30 checks over 5 min.
- Checks: pnpm typecheck 0, check-client-invariants 0, test:desktop 4/4,
  copied-store-guard + dependencies tests 4/4, desktop:build smoke pass.
- The shipped .dmg is build2 (20:59), which carried the fix inline in index.ts; commit 5487a28
  only moves the same env into server-env.ts (identical values) and adds the guard. A rebuild
  after the refactor failed on a full disk.

## Not verified / known gaps
- Unsigned (ad-hoc), not notarized: Gatekeeper blocks the first open of a downloaded copy; the
  quarantine path was NOT exercised (would put a dialog on the owner's screen). Steps on install.html.
- First launch of my FIRST install: the server exited silently ~3 min in while the disk had
  ~400 MB free (server.err.log empty). Not reproduced with free space; suspect disk.
- Intel Mac, Windows native, Linux/WSL source path: not tested here.
- Disk hit 0 bytes during this work (other sessions growing too); see thread post_01a10c2b.
- Mistake to avoid: a `screencapture -R` region shot captured the owner's screen instead of the
  app window; deleted unviewed-by-anyone-else. Use CDP/headless captures only.
