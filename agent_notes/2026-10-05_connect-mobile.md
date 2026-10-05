# Connect mobile: Setup section, sidebar/gear actions, Home Screen guide (2026-10-05)

Task: task_01a10ab1-5dc7-7464-acb5-37ae756251ad (owner request in #unleashd-2, browser launch).
Commit: main `5b0c956`, a cherry-pick of `07aa6a5` (branch `connect-mobile`). `git diff 07aa6a5 5b0c956 -- client server shared` is empty.

## What shipped
- `GET /api/mobile-access` (`server/src/auth/mobile-access.ts`) returns a sum, `MobileAccess` in
  `shared/src/mobile-access.ts`: `tailscale_missing | tailscale_stopped | access_key_missing |
  serve_missing | ready{url,funnel,key} | failed`. It finds the CLI on PATH, falling back to
  `/Applications/Tailscale.app/Contents/MacOS/Tailscale`.
- A URL is only `ready` when `serve status` has `<current Self.DNSName>:443 /` proxying to loopback on the
  UI port: 7489 in development (Vite), or the built app's own port. A stale-name entry or the 7499 dev API
  counts as `serve_missing`, and the exact command comes back with it.
- Open auth (loopback, no key) is reported before Serve as `access_key_missing{exposed}`. Serve connects
  from 127.0.0.1, so without a key the tailnet gets the app with no sign-in.
- Desktop Setup has a "Connect from mobile" section (`client/src/views/dependencies/ConnectMobile.tsx`).
  It polls every 3 s while open. Two actions reopen Setup scrolled to it, with focus on it: the
  **Connect mobile** footer in the Chats `Sidebar`, and the **gear menu** item on every desktop page
  (Workspaces, workspace rail, Chats). The gear item is hidden on phones by a `[data-device="mobile"]` rule.
- Phone: `HomeScreenGuide` (in `ShellMobile`) shows once per device, after Setup closes, and never on a
  standalone launch (`display-mode: standalone` or `navigator.standalone`). It has iOS / Android /
  generic steps. An iPad sends a Mac user agent, so it is classified by touch points.
- Login page, `apple-mobile-web-app-title`: Buddies. Vite `allowedHosts` is now `.ts.net`; it was the
  owner's own tailnet suffix, so every other install got a 403 in dev. `docs/auth.md` serves 7489 and has a
  table of dev and built ports.

## Bug found while verifying
The app-bundled CLI, run with a scrubbed env, printed "The Tailscale GUI failed to start" and exited 0.
`JSON.parse` inside execFile's callback threw outside the promise and **killed the server**. Now the parse
happens inside the promise and the result is `failed`. Guard: the 3rd test in
`server/test/mobile-access.test.ts`. Mutation check: reverting the try/catch fails that test.

## Evidence (worktree tree == 07aa6a5)
- `pnpm typecheck` exit 0; biome clean on all touched files; `check-client-invariants` 9/9 (G8 13974/13987).
- `server/test/mobile-access.test.ts` 3/3 and `client/test/home-screen-offer.test.ts` 2/2.
- `pnpm test:client` 223/225. The 2 failures (channel-dm harness retry, channel-restored Task filter) also
  fail on main e87841d without this change.
- `pnpm test:server` 243/245, run before the crash fix. The swarm/oompa timing test failed under build load
  and passed 4/4 on rerun.
- Real probe through the module, with this Mac's Tailscale: `ready https://nicholass-macbook-air-2.tail58a146.ts.net/`
  for 7489 (via PATH and via the app-bundle CLI), and `serve_missing` for 7499.
- `curl https://nicholass-macbook-air-2.tail58a146.ts.net/__auth/login` returns 200 with a verified cert;
  `/` returns 401 (the login page) without a cookie.
- Throwaway built server on :7591 with temp data, fake agent CLIs and a temp token file. A headless CDP run
  (session refused no writes) showed:
  the Setup section (`serve_missing` for 7591); the gear and sidebar actions reopen Setup with the section
  focused and visible; phone Setup has no section; the phone guide does not stack on Setup, appears
  after Continue, and stays gone after Got it + reload. The gear item computes `display:none` on phone `/`
  and `/channels`. Unauthenticated `/api/mobile-access` returns 401.

## Not verified / open
- **Live adoption.** The live dev backend still answered 404 for `/api/mobile-access` at the time of
  writing: the dev watcher defers backend reloads while turns run. After it reloads, Setup should show
  `ready` with the URL above.
- **Real phone.** An iOS peer is online on the tailnet, but no agent can drive it. Owner check:
  open the copied URL on the iPhone, sign in with the key (`pbcopy < ~/.agent-viewer/auth-token` on the
  Mac, then the login page's Paste button), see the guide, Add to Home Screen, and confirm whether the
  installed app needs a second sign-in. The guide says "may".
- **Visible rail button in a workspace.** The rail lives in `ChannelBrowser.tsx`, which another session
  has dirty, so this commit reaches it only through the gear menu. Follow-up: a rail-footer button calling
  `openSetupAt('connect-mobile')`.
- Ideas not built: a QR code for the URL, and Android `beforeinstallprompt` one-tap install.

## Completion pass (2026-10-05 ~17:00, Release Engineer)

Integrated on local main, not pushed (origin/main is at 6f192a6 and does not contain fd352c4 or later):

- b5c7d3c: a concurrent palette-trim commit swept in my staged index, so its client/ and
  tools/dependencies-layout.test.mjs content is this work: the Product Development Lead's Setup wizard
  (Welcome → Setup → Create your team, WorkspaceTeamForm, the empty-workspace New Buddy creator) and the
  visible **Connect mobile** button at the bottom of the workspace rail (ChannelBrowser). History was
  not rewritten. 3a6cc84 records the attribution and adds the G8 ceiling.
- 918e316: two defects found while verifying the commit. (1) Connect mobile opened the wizard on
  Welcome, and even on Setup the section stayed below the fold: the child's scroll ran before the
  parent's showModal() effect, and the checks loaded above it. DependenciesPrompt now owns the reveal:
  checks settled → next frame → scroll and focus `#connect-mobile`. (2) Font CSS imported from .tsx
  broke `client/test/dependencies.test.tsx` (ERR_UNKNOWN_FILE_EXTENSION); the imports moved into the CSS.
- 2276d28: --only swept another session's uncommitted +44 ceiling (channel favorites) into 918e316, so
  this commit puts the committed ceiling back to 14315. The working tree keeps 14359 for that session.

Verified in a clean worktree byte-identical to 2276d28 for every changed file:
client `tsc -b` + test tsconfig, the 9 client gates, vite build, and the `dependencies-layout` browser test
(rail + gear entry points land on Setup with the Connect title above the footer). That test fails without
the step fix and without the scroll fix. `pnpm test:client` 212/215; the 3 failures reproduce at parent
fd352c4 (channel-dm retry label, task-page Task filter, chat-message-groups needs the ingest addon in a
fresh worktree). `pnpm test:server` 245 pass / 0 fail / 1 skipped. The earlier "unidentified" server
failure (243/245, run before the crash fix under build load) does not reproduce.
Screenshots: output/connect-mobile-2276d28/.

Live (read-only checks):
- Tailscale Serve: https://nicholass-macbook-air-2.tail58a146.ts.net → 127.0.0.1:7489, tailnet only.
- Through that URL: unauthenticated API 401; key login 302 with a Secure `unleashd_auth` cookie;
  authenticated /api/dependencies 200; page title Buddies.
- `/api/mobile-access` is still **404** on 7499 and 7489. The backend (PID 2862, up since 14:03) reloads
  only when no turn and no scheduled run is active (server/src/lifecycle/shutdown.ts). About ten agent
  turns were running at check time, so it has not been idle. The new server code passes the
  watcher's build check (esbuildCheck ok). Until it reloads, the live Setup section shows a failed check.
- Not done: a forced restart. `pnpm dev:replace` stops running turns, so it is the owner's call.
- Still open: a real iPhone visit, Add to Home Screen and relaunch. No device-control surface is available.
