# Managed desktop source updates — Delivery PM review

Request: post_01a117d4-0dde-764b-b435-dd0d3ebd054b.
Canonical task: task_01a117b8-fee8-742d-a2a4-1eee266b3073, accountable owner Product Development Lead.
Reviewed candidate: 9360fb42fb1cb56e214a98d8dce798d8f4d95937.

Disposition: accept the implemented core for release testing; **hold launch sign-off for this updater cut**. Keep the existing task in review until the gaps below are resolved or the owner explicitly narrows the release promise. This is not a publication approval and does not reject the separately tested 54b9f1f early-access cut.

## Independently observed this review

- Read committed launcher, environment, source setup/publishing, runtime selection, shared staging/smoke, upstream handoff and regression tests at 9360fb4.
- Candidate checkout `output/desktop-source-2026-10-08/candidate` has empty `git status --porcelain`; reviewed files match 9360fb4. Direct commit symbol checks contain the publishing/selection definitions and all handoff wiring. Nested vendor checkout HEAD matches the outer gitlink 7a41287033e3fade6bda202117f09ef3dca03bb2 and its status is clean. (It is a standalone nested checkout; `git submodule status` prints an uninitialized marker.)
- DMG SHA256 independently matches bf61b6df0226c5b2eddf62fe6926983c1b9813772fe690e8c4bc943a5ab2e5e1. Staged payload source.json names 9360fb4 and https://github.com/nbardy/buddies.git. I did not independently extract or launch the DMG this turn.
- Reran `pnpm test:desktop` from that clean candidate: 5 desktop/environment/PATH tests + 2 managed-runtime filesystem/Git tests passed.
- Reran `pnpm exec tsx --test server/test/upstream.test.ts`: 7 passed, none failed/cancelled/skipped. Checks cover fetch-only discovery, canonical workspace bootstrap, deduplication and quoted desktop publish handoff.
- The code stages unique immutable runtimes, smoke-tests before changing selection, retains the prior selected build on failure, and requires reopening. It reuses existing upstream authority rather than adding unattended merges. App stores remain separate from setup/staging. Retaining an old runtime is not database rollback.

## Reported evidence, not rerun this review

Product Development Lead's `agent_notes/2026-10-08_desktop-managed-source-updates.md` reports clean-clone typecheck/build, real fresh recursive clone/bootstrap using bundled Node/npm, payload smoke and native fallback/managed-runtime launches on temporary stores. The fresh-clone test retained the host Rust toolchain. Final 9360fb4 adds only a test to 17f5b8a; the final package reused that compiled application code. These results establish substantial implementation coverage, not a clean-Mac installed update journey or broad all-green release certification.

## Gaps and concrete next actions

1. **Visible setup and recovery — Product Development Lead.** The original proposal in launch-thread post_01a117b2-6164-72e3-866c-1a8cea14b8e3 explicitly included visible progress/failures. Current setup succeeds or fails in logs, with no user-facing readiness/retry/reopen indication. Supply minimal visible status for preparing/ready/failed and a clear recovery/reopen action; capture visible evidence. A large setup panel is not required. Alternatively obtain explicit owner acceptance of a log-only early-access updater and describe that limitation in installation/release copy.
2. **Installed update proof — coordinate with Buddies Release Engineer.** Test the exact DMG on a true clean Apple Silicon Mac: missing Git/Apple tools behavior, source setup from no Rust/pnpm, reopen activation, owner-requested A→B update, runtime revision, preserved app data, and a first real Buddy reply. Exercise offline/failed setup and restart during update; confirm previous runtime stays usable. Current tests cover portions of this, but no single installed journey proves it. Record machine prerequisites, artifacts, commands, revisions and outcomes. Gatekeeper/browser-download behavior remains separately unverified on the unsigned path.
3. **Publication order — release owner, only under owner authorization.** Make the exact bundled source revision and its submodule commit publicly cloneable before uploading this DMG; then verify a fresh recursive public clone can check out the exact metadata revision. Preserve the website commit b8a1e3d and the five dirty client files; build/tag any final integrated revision explicitly. Do not assume local main or the prior 54b9f1f DMG represents this cut.

Until those actions are resolved, label 9360fb4 **implemented; targeted tests verified; local review artifact built; public delivery pending**. Do not call it a finished clean-Mac updater or silently substitute it for the separate 54b9f1f candidate. No pushes/uploads, live-store access, source edits, or peer task status changes performed in this review.

## Follow-up: upstream gitlink changes

Reviewed committed `tools/desktop-source.mjs`, `server/src/upstream/routes.ts`, preflight and build supervisor: initial cloning synchronizes submodules, but the later merge/publish handoff does not explicitly synchronize the new gitlink. A temporary real-Git fixture reproduced ordinary fetch/merge leaving `M vendor/agent-cli-tool` and version A checked out after the outer commit pins B. `git submodule update --init --recursive` made the checkout clean and selected B. Consequently the current publisher's dirty guard safely refuses this update; it does not prove that a stale harness can be published. The manager could repair it manually, but the advertised handoff omits the necessary step.

Product Development Lead next action on the existing updater task: explicitly reconcile committed submodule pins before dependency installation/build, preserve/refuse local submodule edits, and add an A→B gitlink regression through the managed publish boundary. Record the outer and nested revisions in the resulting evidence. No live repository merge or source change was performed by PM.

## Continuation: c1726dd

Owner continuation post_01a117df received. Inspected committed native menu/dialog wiring and persisted status at c1726ddf48f4bb36d5d5ee2840d8b6abaeb59991. It implements preparing, failure/retry, ready/reopen feedback. Reran tools/desktop-source.test.mjs against a temporary git archive of that exact commit: 3 passed, zero failed/cancelled/skipped. This proves the filesystem/status behavior; it does not prove visible native rendering or an installed update journey. Requested final pinned SHA, native menu/dialog pictures and the gitlink regression from the accountable owner through the existing request/task. Publication choice remains unresolved.

## Gitlink finding verified resolved: 961ec3f

Inspected committed reconciliation helper, setup/publish ordering and payload inclusion at 961ec3fcb19f17f35fdd751b56a21c6ae085ddeb. Recursive gitlinks are reconciled before frozen dependency installation/build on both paths; local outer/nested edits and divergent commits are refused. Exported this exact commit's tools to a temporary directory and independently ran both managed-source test files: 4 passed, zero failed/cancelled/skipped (~57 seconds). The real Git boundary confirmed clean nested B before install/build, outer B in selected metadata, runtime A retained, and tracked/untracked/staged edits plus divergent owner commit preserved on refusal. Build/stage/smoke remain fixture adapters in this regression.

PM fixture: outer A 0bdcee79eece9027660cf1293bba226089e10689, nested A 5036d1dd8bf17ff5594c73d7569bd5f6f15d3b38; outer B 639a21368f9ab60b234c0329f006bcf238819793, nested B dbab2a5f68ce3224364285749da135cacd3428cf; retained owner commit b68dc16ae77d85afd24e45fb05bcd98803bbfafb. Temporary fixture/export removed after passing.

Close the specific gitlink review finding. Overall updater launch sign-off still requires native visible evidence and the installed-Mac update journey. No new DMG, source publication or upload verified by this review; the 9360fb4 artifact does not contain these later fixes. Final integration must retain the live website commit and name its exact source revision.
