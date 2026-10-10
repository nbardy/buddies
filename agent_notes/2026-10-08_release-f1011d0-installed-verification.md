# f1011d0 release candidate: exact gates and installed journey

Release Engineer · 2026-10-08 · request post_01a11a6b-0732-767f-92f4-48cbfb0e290a.
Preparation and verification only. No source edits, commits, pushes, tags, uploads or production-backend restarts in this lane. Concurrent main/catalog/client/submodule work excluded.

## Exact artifact

- Cut: `f1011d0b4a954a8bee82292ea212768565baa4b3`, `~/git/_wt/rel-f1011d0`, branch `rel/cand-f1011d0`. Base `4f16903` plus the reviewed five-file blocker fix. Tree clean at the gates and again after packaging.
- DMG: `output/release-f1011d0/keep/Buddies-macos-arm64-f1011d0.dmg`.
- SHA-256: `5962cf177da60e54cc71a7b9578ce55c26afa64461d1e8a2d001b61c0623c473`.
- Build: `pnpm desktop:build`, exit 0, including real staged server/catalog/client/Buddies write/read smoke. Log `output/release-f1011d0/logs/dmg-build.log`.
- Mounted DMG, installed its extractor with `ditto`, then tested the extracted app at `output/release-f1011d0/journey/Applications/Buddies.app`.
- Payload source.json stamps exact f1011d0 and `https://github.com/nbardy/buddies.git`. All five shipped helper files are byte-identical to `git show HEAD:tools/<file>`; hashes in `keep/tool-hashes.json`.
- Gitlink `7a41287033e3fade6bda202117f09ef3dca03bb2`. Ad hoc signed; CFBundleVersion remains `0.0.1`, icon source absent. No notarization/browser-quarantine claim. Details in `keep/provenance.txt`.
- Durable evidence is under `output/release-f1011d0/`, not /tmp. Prior 4f16903 gates remain prior-cut evidence, not attributed to this DMG.

## Gates

`logs/summary.txt`: bootstrap, typecheck, client invariants, client, CLI, tools, desktop (5 + 6), Rust buddies, Rust ingest and build all exit 0 on exact clean f1011d0.

Initial full server suite: exit 1, 302 pass / 1 fail / 19 cancelled / 2 skipped. Auth server startup timed out under concurrent load; missing-provider visible-message assertion failed; queued Ctrl+C adoption timed out. These failures are retained in `logs/server.log`, not silently replaced.

Isolated auth + conversation-runtime + upstream: 71/71, exit 0, no skips/cancellations (`logs/server-targeted.log`). Entire isolated Ctrl+C file: 6 pass / 1 manual skip, exit 0 (`logs/ctrl-c-alone.log`). Full serial server rerun: exit 1, 319 pass / 3 fail / 0 cancelled / 2 skipped (`logs/server-serial.log`). Two run-lease cases fail with EADDRINUSE on fixed ports 7552/7554 while another lane is testing. The thread-model explicit reply times out. With the ports free, complete isolated run-lease file passes 3/3 (`logs/run-lease-alone.log`), and the exact thread-model case passes 1/1 in 727ms (`logs/thread-model-alone.log`). Both exit 0, no skips/cancellations. Every case that failed in either full invocation passed in isolation; neither complete server-suite invocation was green. No test/source change was made to obtain those passes.

## Installed app and native evidence

Fresh app stores: journey/homes/fresh. Local Git mirrors pin A=f1011d0 and B=`01cdcc68da5eb20d8e50cf74c5019240f3484124`; B pins nested marker commit `90f8da9e11d1c6acaa443632e00acf1739b5a134`. Mirrors are a test substitution because the candidate is not on public main. No live stores were copied for this journey.

1. Automatic first launch cloned A recursively, installed its own pnpm, installed development dependencies despite the native parent's production environment, built, typechecked, staged, smoked and selected A in 73 seconds. No manual dependency workaround. Native preparing and Ready dialogs captured. Retry later overwrote the app's source-update.log; initial completion is retained in desktop.log and the exact-A Ready picture, while the retained helper log documents the actual successful Retry build/smoke.
2. Native Quit to reopen stopped the test backend (desktop.log); reopened A spawned the immutable A runtime. Buddy identity and DM history persisted. First Claude attempt hit a session quota error, retained in `journey/logs/pong-a.json`; it is NOT a successful reply. After the quota reset, actual Claude Buddy reply `PONG-RA` arrived in 5.6 seconds (`pong-ra.json`).
3. `POST /api/upstream/update` started the real app Upstream Release Manager (Codex). It fast-forwarded to B and invoked the exact shipped `--publish` helper directly, without preliminary install/build. Helper reconciled the nested gitlink, installed, built, typechecked, staged, smoked, selected B and retained A. Its actual thread report is `update-result.json`; tool inputs are `release-manager-messages.json`. Owner request and report post IDs: post_01a11aa5-4836-76bb-a2fa-00e1da32b6ea / post_01a11aa7-26f5-76bf-80e2-a942b0e05b30.
4. Native B Ready dialog captured; reopen spawned B. Nested `server/node_modules/@nbardy/agent-cli/dist/release-journey-marker.js` exists in B. Same upstream workspace ID, Buddy and DM retained. Actual `PONG-RB` reply in 6.4 seconds (`pong-rb.json`); upstream reports current B (`upstream-b-active.json`).
5. Another real helper publish was SIGKILLed with its own process group during Building the update. B manifest stayed byte-for-byte unchanged (`interruption-result.json`, `active-before-interrupt.json`). Native interrupted dialog captured. Clicking native Retry recovered the dead lock and successfully published B again; Ready captured (`retry-ready.webp`). No agent process was killed for this interruption test.
6. An uncommitted marker edit caused the real helper to refuse publishing. Active selection stayed byte-for-byte unchanged and the test edit was restored exactly (`dirty-result.json`, `dirty-publish.log`).
7. Older failed source 4f16903 under the new bundle built/typechecked but was refused by the bundled ancestry floor. No active manifest was created; source remained at 4f16903. Launching that home selected the bundle and served catalog HTTP 200. The native dialog visibly says to merge the bundled revision into the preserved checkout; `stale-refused.webp`, `stale-helper.log`, `stale-bundle-catalog.json`. View setup logs opened the precise stale home in Finder (`log-folder-ax.txt`).
8. Offline fixture uses the real GitHub URL through a dead loopback proxy, with NO_PROXY for localhost. Git clone fails with connection refusal, releases its lock and leaves no source/active selection. Native failed dialog shows retry guidance; the bundled Welcome screen and catalog HTTP 200 remain available (`offline-failed.webp`, `offline-usable.webp`, `offline-bundle-catalog.json`, offline/source-update.err.log). The first proxy attempt omitted NO_PROXY and blocked the native loopback readiness fetch; that fixture was closed and corrected, not treated as a product offline result.

Native review pictures are WebP q95 in `journey/shots/`. UI actions used cua_repl. No dialogs are generated fixtures.

## Host limits and automation incident

Host: Apple Silicon macOS 15.5, installed Apple CLT/Git/Rust, pnpm/store/addon caches, authenticated Claude/Codex and existing raw harness transcripts. This is real installed-app testing on the development Mac, not a true clean-Mac or browser-quarantined download test. Host evidence: `journey/logs/host-prereqs.txt`. No initial Rust/CLT install-from-nothing proof.

The native tool launched an older local Buddies build when first selected by display name, opening the default `~/Library/Application Support/Buddies` app home and starting a source clone. A later AX query after Quit relaunched the candidate without its test environment. Both were unintended automation side effects. The processes created by these operations were stopped, including the orphan clone; later quit verification used process logs without querying a closed app. Do not claim the default desktop app home was untouched. No default-store rollback or outside SQLite open was attempted, and no original source-checkout backend was restarted. A partial default-home clone may remain for normal cleanup review.

Known PM nonblocking follow-ups remain unchanged: offline deploy delay, symlink guard, pending-dir cleanup and relay survivor task. One relay survived the offline app's quit; that specific test relay was terminated during cleanup. Test app backends were closed. Do not equate successful managed updates with safe database rollback.

## Delivery boundaries

Public main observed at `fee9b120610297be1c3feb9caff07dd146847fef` during this run; f1011d0 is not its ancestor. Local shared main moved concurrently as well. This report and DMG remain solely f1011d0. A tag/branch containing the exact cut must be public for first-launch clone-at-revision; main must not be overwritten with this candidate. Any newly integrated cut needs its own matching gates/artifact.

Owner approval for this exact f1011d0 tag/DMG, conditional on PM acceptance, requested in owner DM `post_01a11ab4-b39e-74dd-8757-ade21bd238fd`; no answer received at handoff. Lead received the complete correlated answer `post_01a11ab4-b5ab-7382-9203-6d00d74c0644`. PM/lead review of the installed evidence and final cut choice remains required. No push/tag/upload authorized or performed here. External clean-Mac/quarantine coverage remains outstanding.
