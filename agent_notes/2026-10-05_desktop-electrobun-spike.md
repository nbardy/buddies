# Desktop spike: Electrobun + bundled CEF around the unmodified server (2026-10-05)

Task: task_01a10b3c (Buddies desktop app), step 1. Branch `desktop-spike`, worktree
`/tmp/unleashd-desktop-spike` off origin/main 6f192a6. Mac arm64 (Darwin 24.5), Electrobun 2.0.2.

**Verdict: works.** An Electrobun app with bundled CEF runs the UNMODIFIED `server/dist/server.js`
on a bundled Node 22.23.3, renders the client, signs in, and a Buddy DM got a Claude reply. The
server code was not modified. No blocker for the macOS path. Three real problems were found and
worked around in the app shell (below). Each one needs a small server-side follow-up before release.

## What was built

```
desktop/
  electrobun.config.ts   mainProcess cottontail, mac.bundleCEF + defaultRenderer cef, createDmg
  hutch.config.ts        pins hutch 0.27.1 / cottontail 0.7.1 / electrobun 2.0.2
  src/main/index.ts      main process: data dirs, auth token, spawn server, window, quit
  src/loading/index.html window content while the server boots
  src/tabs/              tab-bar proof (BUDDIES_DESKTOP_TABS=1)
tools/desktop-build.mjs  `pnpm desktop:build`
```

Main process: picks a spare loopback port and writes `auth-token` (32 random bytes) into the app
data dir. Then it spawns `payload/node/bin/node payload/server/dist/server.js` with
`UNLEASHD_DATA_DIR`, `BUDDIES_HOME`, `UNLEASHD_BUDDIES_DB`, `PORT`, `UNLEASHD_HOST=127.0.0.1`, and
bundled node first on PATH. It opens the CEF window on a bundled loading page, polls
`/api/provider-catalog` with the bearer token, then signs the window in. `before-quit` and
window-close SIGTERM the server. Verified: after Cmd-Q / quit, no `payload/node/bin/node` process
remains.

App state: `BUDDIES_DESKTOP_HOME`, default `~/Library/Application Support/Buddies` (agent-viewer/,
buddies/, desktop.log, server.log, server.err.log). It never touches `~/.agent-viewer` or
`~/.buddies`.

## Payload (what the server needs, found by running it)

`tools/desktop-build.mjs` stages `desktop/stage/payload/` and Electrobun copies it to
`Contents/Resources/app/payload/`:

| Path | Why |
|---|---|
| `server/dist`, `server/package.json`, `server/node_modules` | `pnpm --filter @unleashd/server deploy --prod --config.node-linker=hoisted`. Hoisted means real dirs, no `.pnpm` symlink farm. deploy copies git-tracked files only (src/test, NO dist), so dist is copied in and src/test removed. |
| `node_modules/@unleashd/shared`, `@nbardy/agent-cli` | deploy copied them without `dist` (gitignored); replaced with package.json + dist. |
| `node_modules/@unleashd/buddies-core` | package.json, index.js, index.d.ts, `buddies-core.node` |
| `crates/unleashd-ingest/` | `server/src/conversations/config-records.ts` requires `../../../crates/unleashd-ingest/index.js` BY PATH, so the payload must mirror the repo layout. `node_modules/@unleashd/ingest/index.js` is a one-line re-export of that copy so the addon loads ONCE (two copies of one napi addon = two stores over one SQLite file; cf. store-descriptor isolation). |
| `client/dist` | server serves `../../client/dist` |
| `node/bin/node` | node-v22.23.3-darwin-arm64.tar.gz, sha256-checked against SHASUMS256.txt, cached in `desktop/cache/` |

Payload sizes: node 112M, server 37M (node_modules 34M), crates 7.1M, client 4.5M.

The build script smoke-tests the staged payload before packaging: bundled node,
`PATH=<bundled node>:/usr/bin:/bin`, HOME and all stores in a mktemp dir, spare port; catalog, `/`,
and a Buddies workspace write + read. It listened after ~2.0 s.

## Verification

All runs used temp state; the owner's 7499 server and stores were never touched.

1. **Launch from `open`**: `open -n --env PATH=/usr/bin:/bin --env HOME=<tmp> --env BUDDIES_DESKTOP_HOME=<tmp> Buddies.app`.
   The client rendered: `window-first-launch.png`, `window-warm-launch-signed-in.png`.
2. **Stripped PATH**: server process env read with `ps eww`:
   `PATH=…/payload/node/bin:/usr/bin:/bin`. Rust, pnpm and system node are not reachable. The server
   started, `/api/provider-catalog` returned 200 with the bearer and 401 without.
3. **Buddy DM (real HOME for the Claude login, PATH still /usr/bin:/bin, temp stores)**: Setup
   showed Claude "Answered Yes — ready" (the server itself adds `~/.local/bin`). Created workspace
   "Desktop Spike" (root in tmp) and buddy Pinger (claude/sonnet) through the app's API. The DM
   "Reply with exactly the word PONG" got the reply `PONG` in its thread; run
   `run_01a10b93-69ac…`, `status complete`, 3.2 s from post to reply. Screenshot:
   `window-buddy-dm-pong.png`.
4. **Installed location**: the `.app` copied with `ditto` to `/tmp/buddies-app-install/` (outside
   any git checkout) launched and ran the tab proof (below).

## Measurements

| What | Value |
|---|---|
| `.app` as built / shipped (self-extracting: 760K launcher + zstd tar) | **150 MB** |
| `.dmg` | **153 MB** |
| `.app` after first-launch extraction (in place) | 534 MB (CEF Frameworks 303M, MacOS 74M, payload 155M) |
| First launch, `open` → first paint | ~15.0 s; ~14.6 s of it is self-extraction (an "Installation complete" window, `launcher-window.png`) |
| Warm launch, `open` → loading page painted | 1.4–2.9 s (main process starts ~1–2.4 s after `open`; the loading page paints ~100–300 ms later) |
| Warm launch, `open` → signed-in client dom-ready | ~1.4 s without the loading page; 3.6–3.8 s with it (server boot then competes with CEF startup; server ready 0.25 s alone vs ~1 s alongside) |
| First run with a real HOME | the server answers HTTP at once, but refuses writes (`server_starting`) until ingest finishes: 11,135 existing transcripts in 22.7 s |
| `pnpm desktop:build --skip-build` (stage + smoke + electrobun) | ~61 s (zstd compression of the bundle alone 30.7 s) |

## What broke, and the fix or workaround

1. **First boot ran `brew install rust` against the machine's Homebrew.** The server's dependency
   check auto-installs Rust on first boot (brew, else rustup). `open` passed my shell PATH
   (Homebrew on it), and the temp HOME had no `~/.cargo`, so it spawned
   `brew.rb install rust`. I killed it during the API/bottle download; nothing was installed
   (`brew list --versions rust` is empty). A packaged app never builds from source, so the main
   process now pre-claims the server's own once-per-install marker
   `<data>/dependency-setup/rust.attempted` before spawning. **Server follow-up:** an explicit
   setting (e.g. `UNLEASHD_SOURCE_BUILDS=0`) that both skips the install and drops the Rust row
   from Setup, which still shows "Rust / Cargo — brew install rust" in the app.
2. **Stale auth cookie forced the login page on every launch after the first.** The gate reads
   credentials as header > cookie > query (`server/src/auth/gate.ts`). Cookies ignore the port,
   so an `unleashd_auth` cookie from an earlier server on 127.0.0.1 with another token is rejected
   before the valid `?token=` is read. CDP showed the cookie with `sourcePort 58414` (first run)
   while the window sat at `/?token=…` titled "Buddies — sign in". Electrobun's
   `Session.*.cookies` API does not reach the window's jar: `remove()` returned false with no
   partition, and `get()` saw 0 cookies with `partition: "persist:buddies"`, because the window
   kept using CEF's global context. Fix in the shell: load `/__auth/logout` (public, clears the
   cookie), then on its dom-ready load `/?token=…`. **Server follow-up:** a valid `?token=` on a
   navigation should establish even when a stale cookie is present.
3. **Upstream bootstrap pointed at the owner's real checkout.** When the `.app` sits inside a
   worktree (the spike build dir), `git worktree list` from the payload resolves to
   `~/git/unleashd`. The temp store then got the "unleashd" workspace, and the client showed
   "Unleashd is 2 commits behind origin/main — Update". I did NOT click Update; it would start a
   Release Manager merge turn in the main checkout. Copied outside the repo, no checkout is found
   and no upstream workspace appears. **Follow-up:** the desktop app should disable the upstream
   bootstrap explicitly, not rely on where the bundle happens to sit.

Also observed:
- **Profile path ignores HOME.** CEF's profile lives in the REAL
  `~/Library/Application Support/sh.buddies.desktop/stable/CEF` (and `~/Library/Caches/sh.buddies.desktop`)
  even with `HOME` overridden. These are app-owned dirs created by the spike, left in place.
- **Codex dependency.** Memory review hard-depends on Codex: `spawn codex ENOENT` in
  server.err.log when Codex is absent (same family as todo_57268f4b).
- **Agent CLIs use the login PATH, not the app's.** The server finds Claude in `~/.local/bin`
  itself. Codex under nvm/bun would not be found from a Finder launch; the desktop app may need
  login-shell PATH resolution (as VS Code does) or explicit agent paths.
- **Shared bundle id.** Another session (`~/git/_wt/desktop-agent-detect`) builds an app with the
  same bundle id `sh.buddies.desktop` and therefore the same CEF profile. My tab-proof instance
  received a quit at 10:28:33 as theirs launched. Use per-worktree identifiers for parallel dev
  builds.

## Tab bar proof

`BUDDIES_DESKTOP_TABS=1` loads `views://tabs/index.html`: a 2-button bar and two
`<electrobun-webview renderer="cef">` tags on `/chats` and `/buddies`. Switching calls
`toggleHidden()`, so the page is never reloaded. Screenshot `tabs-chats-active.png`.

- CDP confirms the hidden tab reports `document.visibilityState === "hidden"` and the visible one
  `"visible"`.
- **Both WebSockets stay live while hidden.** Two loopback sockets (:54084, :54085) were
  ESTABLISHED from load (10:24:29) through the last check (10:28:13), ~3.7 min with the Buddies
  tab hidden, while the HTTP polling sockets around them churned. The server's ws heartbeat would
  have terminated a dead peer.
- Not measured: timer throttling inside the hidden page (CDP went away when the other session's
  app quit mine), and whether pushed updates render in the hidden tab. Creating a workspace is not
  pushed over WS, so it was no probe. Next: a conversation-row patch.
- Cookie handoff: both tabs load `?token=`; whichever lands second already has a valid cookie, so
  its URL keeps `?token=` (cosmetic, token visible in that webview's URL only).

## Rebuild

```bash
git cambium add -b desktop-spike -name desktop-spike -ephemeral /tmp/unleashd-desktop-spike origin/main   # or check out desktop-spike
cd /tmp/unleashd-desktop-spike
git submodule update --init vendor/agent-cli-tool   # the ephemeral worktree came without it
pnpm run bootstrap
pnpm desktop:build                 # pnpm build + stage + smoke + electrobun → desktop/build/stable-macos-arm64/Buddies.app, desktop/artifacts/*.dmg
pnpm desktop:build --skip-build    # reuse existing dist
BUDDIES_DESKTOP_CDP=9333 pnpm desktop:build --skip-build   # build with Chromium remote debugging on :9333

# run isolated
T=$(mktemp -d); open -n --env PATH=/usr/bin:/bin --env HOME=$T/home --env BUDDIES_DESKTOP_HOME=$T/state desktop/build/stable-macos-arm64/Buddies.app
```

Electrobun is fetched with `pnpm dlx electrobun@2.0.2`, which downloads Hutch 0.27.1, Cottontail,
the Electrobun core and CEF into `~/.hutch` (created by this spike). `electrobun init` refused to
claim an existing unmarked `~/.hutch`; `build` did not need init.

## Remaining gaps

- **Signing / notarization**: unsigned (ad-hoc) today. Electrobun has `mac.codesign`,
  `mac.notarize` and `entitlements` options; needs a Developer ID cert + notary credentials in CI.
  Unknowns: signing the bundled `node`, the two `.node` addons and CEF helpers (hardened runtime;
  node needs `allow-jit` / `allow-unsigned-executable-memory`). Also whether the in-place
  self-extraction (the launcher unpacks into the bundle on first launch) survives Gatekeeper
  and app translocation from a DMG.
- **x64 Mac**: Electrobun builds only for the host. Needs an Intel runner or a check for an
  `--arch` option, plus the x64 node tarball (the script picks it by `os.arch()`) and both napi
  addons built for `x86_64-apple-darwin`. Universal binaries are not addressed.
- **Windows**: `pnpm desktop:build --win` fails with a TODO. It needs a Windows runner, `win.bundleCEF`,
  node-win-x64.zip (`node.exe`), the addons built for `x86_64-pc-windows-msvc` (today CI builds
  the native addon Linux-only), and a Windows replacement for the `kill(SIGTERM)` shutdown.
- **Auto-update**: Electrobun writes `stable-macos-arm64-update.json` + a tar.zst; `release.baseUrl`
  is unset (no delta patches). GitHub Releases hosting is not wired, and nothing was published.
- **Server-side follow-ups**: the three numbered items above (no-source-builds setting, query token
  over stale cookie, disable upstream bootstrap); Setup copy for desktop users; first-run ingest
  of 22 s on a heavy `~/.claude` blocks writes with no progress shown.
- **Icon**: none (`desktop/icon.iconset` missing; the build warns).
