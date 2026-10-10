# Desktop updater: final candidate 048ec32, new DMG, installed A→B journey

Request: post_01a117e5-c527-72a0-9427-b48e383547fc (Product Development Lead).
Task: task_01a117b8-fee8-742d-a2a4-1eee266b3073. Release Engineer, 2026-10-08.
Scope: preparation and testing only. Nothing pushed, tagged, uploaded or published; local and shared `main` untouched.
The retained A artifact (54b9f1f, DMG 6c4e905e…) was not rebuilt or relabelled.

**Verdict: blocked.** The new DMG's automatic first-launch source setup fails on every launch
(`NODE_ENV=production`, details below). A→B update, reopen activation, data preservation, real Buddy
replies and interrupted/failed-update retention all work once a dev-complete install exists.

## Candidate

| | |
|---|---|
| Commit | `048ec32b491050a01e22a95c59b8b121bf31f699` (branch `rel/updater-cand`, cambium `rel-updater`, `/tmp/unleashd-rel-updater`) |
| Parents | `92a5ea64fa9cff9cf28bfd552f7098883f5ed3a5` (updater tip: 961ec3f gitlink fix + 92a5ea6 visible recovery text) and `b8a1e3d4d1b47a6f4a36f7dd2d69ea4d19ae3341` (live website) |
| Tree | `9127fc3ad80ec607457f30a8aa38977f976c1ef8` |
| Website | `docs/index.html` byte-identical to b8a1e3d (merge adds only that file over a453e61) |
| Gitlink | `vendor/agent-cli-tool` 7a41287033e3fade6bda202117f09ef3dca03bb2 (same as 54b9f1f; on public agent-cli `origin/main`) |
| Public | `github.com/nbardy/buddies` main is still b8a1e3d; 048ec32 is not public, so the shipped clone-at-revision cannot work until it is pushed |

## Committed-cut gates (`/tmp/rel-updater-gates/`)

The tree was clean before and after (`porcelain=[0]`); see `summary.txt`.

| Gate | Exit | Result |
|---|---|---|
| bootstrap | 0 | |
| typecheck | 0 | |
| client invariants | 0 | |
| client tests | 0 | |
| test:desktop | 0 | 5 desktop + 4 managed-source |
| test:tools | 0 | |
| upstream.test | 0 | 7/7 |
| build | 0 | |
| crate buddies | 0 | 80 Rust + 2 node |
| crate ingest | 0 | 60 Rust + 3 node |
| server suite | **1** | 298 pass, 0 fail, **19 cancelled**, 2 skipped |
| auth.test alone | 0 | 23/23 (`auth-alone.log`) |

The server-suite cancellations are the auth suite (boot under load) and the known unresolved Ctrl+C adoption test.

## Artifact

- Built with `pnpm desktop:build` from the clean 048ec32 worktree.
- `/tmp/rel-updater-gates/keep/Buddies-macos-arm64-048ec32.dmg`, SHA-256 `e70c9f304a7ab565e6f5db56f7c13a9ce786c61eab6d462e758975faf53c0f79`.
- Ad hoc signed (unsigned release path). CFBundleVersion is still 0.0.1, and the macOS icon source is missing, as in the 54b9f1f build.
- Payload `source.json` = 048ec32 + `https://github.com/nbardy/buddies.git`. The payload tools match HEAD.

## Host (not a clean Mac)

- Apple M4, macOS 15.5.
- Apple Git 2.39.5, Command Line Tools 16.4, clang 17.
- rustup 1.29.1 / rustc 1.93.0 already installed, with the host cargo registry cache. The helper puts `~/.cargo/bin` on PATH, so the Rust install-from-nothing path was NOT exercised.
- Gatekeeper enabled; the app was installed by `ditto` from the mounted DMG. Browser-download quarantine was not exercised.
- Login-shell PATH had claude/codex. `open --env` also forwarded this shell's environment into the app.
- File list: `/tmp/rel-upd-journey/logs/host-prereqs.txt`.

## Harness (deviations from a real install)

- `GIT_CONFIG_GLOBAL=/tmp/rel-upd-journey/gitconfig` rewrites both GitHub URLs to local bare mirrors (`protocol.file.allow=always`), because 048ec32 is not public.
- Mirror fixtures:
  - A = 048ec32 (nested 7a41287).
  - B = `c818d2c3383281f5129d70e7b64dc06d8688942b` (outer), pinning nested B `cd629dff475902a861cf571a68a78f6e05128ec2`. Nested B adds `src/release-journey-marker.ts`.
  - B2 = `c597742cfd76d32ee13b07b1fcb554db9f36084c` (docs only).
- `UNLEASHD_BUILD_ROOT=/tmp/rel-upd-journey/build-root`, so the addon cache and cargo target were cold: the managed build really compiled unleashd-buddies (release, 1m18s) and ingest.
- `BUDDIES_DESKTOP_HOME` = temp dirs `s1`, `s3`, `s6`–`s8`. `~/Library/Application Support/Buddies` mtimes are unchanged before vs after; no `~/.buddies` / `~/.agent-viewer` access.
- Native evidence uses window-ID captures only (`screencapture -l`) plus System Events accessibility, so no other screen content was captured.

## Results

### 1. First-launch setup FAILS (blocker)

The automatic setup (`startSetup`) runs the helper with the server `environment`, where serverEnv sets `NODE_ENV=production`:

- `pnpm install --frozen-lockfile` prints "devDependencies: skipped because NODE_ENV is set to production".
- `shared/scripts/build.mjs` then fails with `Cannot find module 'typescript/bin/tsc'`, which surfaces as "Command failed: pnpm build".
- The native Retry setup action reproduces it.
- The bundled runtime keeps serving (HTTP 200).

Logs: `s1/source-update.log`, `s1/source-update.err.log`.

The earlier fresh-clone bootstrap evidence ran the helper outside the app's environment, which is why it missed this.

### 2. Second defect: pnpm purge prompt (non-TTY)

After that production-only install, `pnpm install --frozen-lockfile` without NODE_ENV prints "The modules directories will be removed and reinstalled from scratch. Proceed? › true", then exits 0 having installed NOTHING.

- `--config.confirmModulesPurge=false` performs the reinstall (`logs/manual-install*.log`).
- So a corrected helper must both drop NODE_ENV for its install/build and pass `--config.confirmModulesPurge=false`. Otherwise users whose first setup already failed stay broken.
- The same no-op is why later production-env installs over a dev-complete `node_modules` happen to work.

### 3. Workaround used to continue (labelled deviation)

The shipped helper was run with the server's exact env minus NODE_ENV, plus one purge-confirmed install.

- It cloned A recursively, built, typechecked, staged and smoke-tested (`ok payload: catalog, client, Buddies write + read`).
- It wrote `active-runtime.json` for 048ec32 (`s1/source-update.manual.log`).

### 4. First real Buddy reply, bundled runtime

Workspace "journey" + Buddy "Pinger" (claude) created over HTTP. Owner DM at 20:07:59.959Z; the assistant replied "PONG-A" at 20:08:01.174Z.

### 5. Reopen → runtime A

The second launch spawned `runtimes/048ec32…-eb0f1044…`:

- Buddy and DM history were preserved, after a SIGKILLed first launch.
- The upstream workspace was bootstrapped on the managed checkout.
- `/api/upstream/status` = behind 1 at c818d2c.
- Real reply "PONG-RA" in 5s.

### 6. Owner-requested A→B through the real Release Manager

`POST /api/upstream/update` produced the owner post post_01a11806-b81f; the Release Manager (codex, running with `NODE_ENV=production` in its process env) handled it.

- Fast-forwarded to c818d2c; nested 7a41287 → cd629df, clean.
- Ran `pnpm install && pnpm build`, then `desktop-source.mjs --publish`: build, typecheck, stage, smoke (listening 1853 ms), verified c818d2c.
- Reported in post_01a11807-fd8c in 86.8 s. Status `ready` for B; runtime A retained.
- This worked only because `node_modules` was already dev-complete (defect 2 no-op).

### 7. Reopen → runtime B

The third launch spawned `runtimes/c818d2c…-47519639…`:

- `server/node_modules/@nbardy/agent-cli/dist/release-journey-marker.js` exists in B and not in A.
- Data preserved; upstream `current` at c818d2c, same workspace id.
- Real reply "PONG-RB" in 5s.

### 8. Interrupted update

- Advanced to B2 and fast-forwarded the managed checkout by hand (standing in for the Release Manager step).
- Ran `--publish` with the production env and SIGKILLed the helper and its children during "Building the update".
- The status reader returns `failed: Setup was interrupted. Retry…`, and the view offers Retry setup/Later/View setup logs. Copy nit: "your current version is still available" is repeated.
- `selectedRuntime` stays B, and a reopen spawned B (reply "PONG-RBI" in 4s).

### 9. Retry after the interruption

Ran the helper without `--publish` (Retry's path) with the app's production env:

- It recovered the dead-owner lock and published B2 c597742 (`s1/retry-b2.log`). The lock was released; A, B and B2 runtimes are all retained.

### 10. Failure retention, each on a fresh home, helper with the app env

| Case | Home | Result |
|---|---|---|
| Missing remote | s6 | git clone fails |
| No network: real GitHub URL, HTTPS proxy on a dead port | s8 | "Failed to connect" |
| Missing Git / Apple CLT: stub `git` first on PATH printing the xcode-select message | s7 | "Command failed: git --version" |

In each case: status `failed` with the command, no partial `source`, no `active-runtime.json`, lock released.

## Native evidence (`/tmp/rel-upd-journey/shots/`)

- `s1-a`: extractor "Installation complete".
- `s1-b`: main window.
- `s1-c` / `s1-d`: failed menu + failed dialog with the recovery text visible.
- `s1-e`: failed again after clicking Retry setup.
- `s1-g` / `s1-h`: menu "Preparing source updates: Building the update…" and the preparing dialog opened from that menu item.
- `s1-f`: the menu label stays stale while a status dialog is open.

Findings from the native leg:

- The modal `showMessageBox` blocks the 1 s refresh, so the label/dialog can show "failed" while a new setup runs. Dismissing the dialog updates it.
- At about 04:17 local the GUI session became unavailable (CGWindowList empty; display asleep or locked). Afterwards every cottontail launch crashed at window creation: `cottontail-2026-10-08-04{1824,2130,2608,2722}.ips` (uncaught NSException in libNativeWrapper `createNSWindowWithFrameAndStyle`).
  - The server child survived each crash, orphaned and still serving.
  - Separately, `buddy-mcp-relay.mjs` survived server SIGTERM (reproduces task_01a10e30).
- Steps 5–10 therefore ran with the shell crashed. Server selection/spawn happens before window creation, so runtime-selection evidence is valid. NOT captured natively: the ready dialog, clicking "Quit to reopen", the native failed dialog for the offline/no-Git cases, and a "View setup logs" click.

## Remaining before sign-off

1. **Product Development Lead (owner of the code):** fix the helper's build environment:
   - Drop NODE_ENV for install/build in `buildSource`.
   - Install with `--config.confirmModulesPurge=false`.
   - Add a regression that runs `prepareSource` with `NODE_ENV=production` through a real `pnpm install`.
   - Consider whether the Release Manager's agent shell should inherit `NODE_ENV=production`.
2. **Release Engineer, on the corrected revision:** rerun the gates, build ONE replacement DMG, and repeat the first-launch leg plus native ready / Quit-to-reopen / offline failed-dialog captures, with the display available.
3. **External:** on a true clean Apple Silicon Mac (no CLT, no Rust, no pnpm, browser-downloaded DMG with quarantine), run first launch → CLT prompt → Rust install → ready → reopen → real reply, after the exact revision and its gitlink are public (owner-authorized push only).
4. Clean up after disposition:
   - `cambium remove rel-updater`.
   - `/tmp/rel-upd-journey` (4 GB; mirrors, runtimes, cold cargo target).
   - Keep `/tmp/rel-updater-gates/keep/` until the DMG is superseded.
