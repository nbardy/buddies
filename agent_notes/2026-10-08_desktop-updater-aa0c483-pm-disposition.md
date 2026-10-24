# Delivery PM: aa0c483 remaining release findings

Review request post_01a11a65-1908-7256-8322-ce9a7ebfe47a; existing task
task_01a117b8-fee8-742d-a2a4-1eee266b3073. Preparation only; no publication approval.

Evidence reviewed: Release Engineer's
`agent_notes/2026-10-08_desktop-updater-aa0c483-fix-verification.md`, task detail,
and committed aa0c483b042e60bd54a999fc4b588c8ecc2ec37b versions of
desktop-source.mjs, desktop-selection.mjs, desktop-runtime.mjs,
server/src/upstream/routes.ts and unleashd-home.ts. No dirty-tree test claim.
The referenced /tmp/rel-updater-gates-aa0c483 directory is unavailable here:
DMG hash and executed gate/journey results remain engineer-reported, not independently
rehashed or rerun by PM. RTK.md is absent from this checkout.

## Must close before this updater cut's early-access release

1. **Stale-source activation (finding 1).** Existing source bypasses bundled-revision
   checkout, then publication records the NEW bundleRevision beside OLD source revision.
   selectedRuntime therefore accepts the older server on reopen. This defeats the
   newer-native selection guard. Helper-only difference makes this particular fixture
   benign; it does not make the general behavior safe, especially after a newer backend
   has opened/migrated stores. Product Development Lead owns correction: retain the
   bundle/previous compatible runtime and explicitly refuse an older/divergent source,
   or safely reconcile a clean ancestor to the bundled revision without discarding work.
   Done: real-Git failed-N setup → install N+1 → Retry/reopen regression never activates N;
   preserve dirty/divergent local work; newer source remains supported.
2. **Production RM pre-build (finding 3).** The generated desktop request still tells
   the RM to run pnpm install && pnpm build before the helper. Under production the
   install may exit successfully without changing dependencies. This fixture kept the
   same dependencies, so it did not verify a changed-lockfile update. Product Development
   Lead owns a single reliable desktop build handoff, preferably invoking the canonical
   helper after merge rather than requiring an unsafe preliminary install/build.
   Done: generated owner-requested desktop flow with inherited production, non-TTY and
   changed dependencies reaches successful helper publish; failure preserves old runtime.
   Cover reused RM seats as well as new seats; do not overwrite owner-edited souls.

Release Engineer validates any new committed cut and replaces/reidentifies the DMG
if shipped inputs change. Continue native testing on retained aa0c483 to expose other
issues, but carry only valid evidence forward and rerun affected flows on final artifact.

## Can defer for early access, with explicit scope

3. **Offline deploy delay (finding 2):** not a release blocker by itself. The source
   staging attempt reportedly succeeds after 26 min and does not replace the running
   bundle/previous runtime. Do not claim fast or fully offline source setup. Release
   Engineer still must demonstrate native app remains usable during the wait and usable
   failure/Retry/log feedback. Lead follow-up: prefer cached deploy data and measure
   DNS-failure recovery time; a timeout must preserve selection. Escalate if native journey
   reveals app blocking or unrecoverable setup rather than an independent helper delay.
4. **Symlink invocation (finding 4):** defer because the supported app passes resolved
   paths. Lead follow-up: resolve entry paths consistently or fail explicitly; regression
   must invoke the CLI through a symlink and prove execution or nonzero diagnostic.
   Release Engineer checks actual generated RM helper path on final installed artifact.
5. **Interrupted .pending leak (finding 5):** defer as a disk/recovery defect, not current
   activation corruption. Lead follow-up: reclaim only abandoned helper-owned staging
   directories after proving no live owner; preserve selected/previous runtimes and live
   builds. Regression: interrupted staging → Retry removes orphan, selects successful
   runtime, preserves active work. Do not perform cleanup during this review.

All follow-ups stay on the existing task/comment chain; no duplicate tasks created.
Finding 6 (surviving MCP relay) stays with existing task_01a10e30 and its owner;
no new duplicate or claim that it is fixed. Duplicate failure-dialog copy is cosmetic.

## Remaining evidence and disposition

Helper boundary is accepted as reported: production first setup, failed-install Retry,
and A′→B′ publishing with nested gitlink reconciliation. GUI was bypassed after display
failure and Release Manager was a shell stand-in after DNS failure. This is not automatic
native launch, native Retry/reopen, actual RM execution, a real Buddy reply or clean-Mac
proof. Those installed/native outcomes remain release holds, owned by Release Engineer.
True no-tool clean Mac/quarantined download and public exact-source availability remain
open; do not silently convert development-host tests into those claims. Lead must make
any narrower early-access platform/distribution decision explicit.

Full server result is **315 pass, 1 fail, 1 cancelled, 2 skipped (319 total), exit 1**.
The dependencies probe failure reportedly passes alone 3× (4/4 each); Ctrl+C adoption
was cancelled. This supports a load-flake hypothesis, not an all-green gate. Release
Engineer owns preserving logs and rerunning the unresolved tests on the final commit
under controlled load, including completed adoption coverage. A remaining failure or
cancellation needs an explicit Lead/owner risk disposition before release, not omission
from the summary. Other gates and crate counts are reported in the engineer note.

**Decision: retain release hold.** Close findings 1 and 3, obtain final-artifact native
installed/reply evidence, resolve/dispose the non-green server gate and outstanding
distribution constraints. Nothing is authorized to publish by this PM review.
