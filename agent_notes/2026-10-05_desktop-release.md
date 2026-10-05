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

## Addendum: asset rebuilt from main 14de9f4 (2026-10-05 15:20Z)
- Freed my own build/test dirs, rebuilt with `pnpm desktop:build` from the clean worktree at
  14de9f4 (exit 0; payload smoke "listening after 7652ms", Buddies write+read).
- Installed the new .dmg outside any checkout, launched with Finder PATH and a temp
  BUDDIES_DESKTOP_HOME: server ready +2.7 s, /api/dependencies claude+codex ready,
  "Buddy runner started", new workspace + buddy Pinger (claude/sonnet), DM -> reply `PONG`
  at +4.75 s, run complete. App quit cleanly ("stopping server").
- Replaced the release asset (`gh release upload --clobber`) and the notes' SHA-256.
  GitHub asset digest = local tested build:
  ea5178e4ffa212e1b4b6727b6dafab60fb5041e31cd1b289b9f90346b7504b91.
- The earlier gap ("shipped .dmg predates 5487a28") is closed.

## Addendum: final reconciliation, asset rebuilt from origin/main e09802b (2026-10-06 ~18:05Z)
Request: Development Lead post_01a10d12 (owner thread post_01a10d11 in #unleashd-2): ship the
final pushed source, not 14de9f4. origin/main moved three times during this work, so each
build was pinned to a full sha in the clean worktree /tmp/unleashd-desktop-app (detached HEAD,
`git status --porcelain` empty, submodule 7a41287 on its remote):

| Source | DMG sha256 | Fate |
|---|---|---|
| 14de9f4 | ea5178e4… | was public until 17:41Z |
| afd4f65 | 66c45f60e8c5b2ca… | public 17:41Z–18:05Z; full UI pass |
| 4c3ad21 (+42f6a5a missing-CLI error) | f5f73d0a19115df3… | full pass, not uploaded |
| b2cce9f (+fuzzy channel search) | abe9f2bad32c3706… | full pass, not uploaded |
| **e09802b** (+buddy channel_create, stale-worker badge, launch-final merge) | **0f6e9d06b0e0f4de611d90744b52628fb2823134fb5a0c152ebe6de8c8a0193d** | **public** |

Shipped changes since 14de9f4 include client code (DM open, Task page, channel stars, mobile
setup, missing-CLI DM error), server code (runner spawn_failed, search, MCP channel_create,
ingest list) and the agent-cli submodule. None could be skipped.

Public check: `releases/latest/download/Buddies-macos-arm64.dmg` downloaded in full (HTTP 200,
160915684 bytes) has sha256 0f6e9d06…, equal to the tested file; GitHub's asset digest agrees.
The site and install.html both link that URL. Release notes now name e09802b and the new digest.
The tag desktop-v0.0.1 still points at 14de9f4 (not moved).

### Evidence on the e09802b DMG (installed from the .dmg via ditto, outside any checkout)
Screenshots: `agent_notes/2026-10-06_desktop-release-e09802b/`.
- Happy path: `open -n -g` with Finder PATH (/usr/bin:/bin:/usr/sbin:/sbin), fresh
  BUDDIES_DESKTOP_HOME, real HOME. Server ready +0.97 s; claude + codex ready; "Buddy runner
  started". No key: a headless Chrome with an empty profile loaded http://127.0.0.1:<port>/
  and /api/dependencies with no token and got 200 (local trust), then the Welcome wizard (d1).
  Setup showed both ready (d2). Team step: folder + description, "Kick off my Buddies". First
  Builder text at +6.0 s, Builder completed in 42 s and hired Notes Engineer (codex,
  gpt-6.1-sol) (d3). DM "Reply with exactly the word PONG" -> PONG visible at +7.3 s (d4).
- Missing CLIs (simulated): temp HOME (login shell then resolves only /etc/paths: no claude or
  codex) with pre-created `dependency-setup/*.attempted` markers so no installer ran (temp HOME
  held only `.cache` afterwards). /api/dependencies: claude + codex `missing`, agent `none`.
  Setup shows "No — not installed" with install + login commands (m1). A claude Buddy created
  through the API; a DM shows "Couldn't start claude: the `claude` command was not found on
  this server's PATH. Open Setup to install it, then send your message again." at +2.3 s (m2).
  A small empty Buddy bubble sits above the error line.
- Same passes on the afd4f65, 4c3ad21 and b2cce9f builds (first Builder text 8–10 s, PONG
  7.3–8.4 s).

### Defect found (all builds, including the old public 14de9f4)
The Builder chat shows a "You" message "[Buddy Builder context recovery failed; hidden briefing
removed]" and its replies twice (d3; after reload, afd4f65-builder-after-reload.webp). Cause:
server/src/buddies/turn-policy.ts:104 (3c1d8d6) writes `-->\nWorking directory: …\n\n` after the
envelope, while crates/unleashd-ingest/src/markers.rs:25 expects `-->\n\n`. Task task_01a10d29.
The sidebar also keeps an italic "Creating buddy" row after the Builder finishes.

### Still not verified
- Signing/notarization: the DMG is ad-hoc signed (`codesign -dv`: Signature=adhoc, no
  TeamIdentifier). A browser-downloaded (quarantined) first open was NOT exercised: curl sets
  no quarantine flag. Needs the owner's Apple Developer ID, or the owner trying Open Anyway.
- A real fresh machine without the CLIs: the missing-CLI run is a simulation on this Mac (temp
  HOME, installers suppressed). The first-boot auto-install (npm codex into ~/.local, Claude
  install script) was not run.
- Intel Mac, Windows, Linux/WSL; the Electrobun window itself was driven only through its own
  server port in headless Chrome (same client and server; not the CEF webview).
- Local main is NOT origin/main: 14 behind and 7 ahead with unpushed commits from other sessions,
  including 098c83b (onboarding lands on / with one create-a-workspace form) and 23aab00
  (keyed model retry). They are not in this DMG. If they are launch content, they need a push
  and another rebuild/test.
