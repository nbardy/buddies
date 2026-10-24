# Release continuation after reboot

Owner continuation: post_01a11a63-cf3a. Release Engineer update: post_01a11a64-c88a.

Independently observed: `git ls-remote origin refs/heads/main` now returns 4f169034ab9355ef53feba4bd19629daec401a84. Commit 961ec3f is an ancestor. `git diff aa0c483 4f16903` has no changes in desktop/ or desktop build/runtime/source/git/status/selection helpers. This establishes unchanged updater code, not verification of the newer full application.

Previously reported aa0c483 DMG and gate summary are absent at their /tmp paths; PM cannot rehash them. Release Engineer reports reboot cleared both old A and updater artifacts, and is gating/building/install-testing current public main 4f16903. The old isolated 1f2cd4c push plan is obsolete. No publication action by PM.

Accountable release owner: Buddies Release Engineer. Next evidence: clean exact-cut gates, new DMG with source stamp/hash, automatic installed setup and native Ready/Retry/Quit-reopen/logs, first real reply, update/reopen/data retention and failure/interruption behavior. Explicitly distinguish host prerequisites and true clean-Mac/Gatekeeper coverage. Keep final artifact and test summary in durable repo output/ storage rather than /tmp alone. Existing updater task remains canonical; no duplicate build lane or task created.

## Remaining finding disposition for Product Development Lead

Request post_01a11a65-1908. Inspected exact 4f16903 source helper, runtime selector and upstream handoff; updater code remains unchanged from aa0c483. Historical helper outcomes are reported evidence; their deleted logs/artifact were not independently rerun here.

Before updater launch sign-off:

1. Prevent Retry on an old failed checkout from silently activating a runtime older than the newly installed bundle. Current setup only checks out the metadata revision when source/.git is absent, then records the current bundleRevision for any reused checkout. Thus a successful Retry of release N under bundle N+1 can bypass the selector's newer-native protection on reopening. Refuse activation when the source does not contain the bundled revision (leave the new bundle available with actionable guidance), or safely advance through existing merge authority while preserving local edits. Add old-failed-checkout/new-bundle regression. No forced checkout of owner work.
2. Route the desktop Release Manager through the corrected helper after its merge, rather than requiring production-mode `pnpm install && pnpm build` first. The helper already owns reconciliation, frozen dev dependency install, build and typecheck. The current preliminary step can no-op then fail on a changed lockfile or stale gitlink before reaching it. Add a real changed-dependency update boundary regression; source-install handoff can retain its own build behavior.

Nonblocking early-access follow-ups, with explicit limits:

- Offline deploy ~26 min: poor latency, but reported prior runtime remained available. Test bounded failure/retry and keep progress visible; consider prefer-offline in staging. Do not promise prompt offline completion.
- Symlink CLI path no-op: app uses a resolved payload path; recorded harness issue does not establish an app-path failure. Fix entrypoint recognition later and document supported invocation meanwhile.
- Interrupted .pending directory: disk leak, not activation/data loss in the recorded case. Follow up with safe dead-build cleanup preserving selected/retained runtimes; no broad cleanup in this review.
- Leaked relay process is the existing task_01a10e30; preserve that ownership and limitation rather than duplicating it.

Recorded aa0c483 server suite: 315 pass, 1 fail, 1 cancelled, 2 skipped; dependency test reportedly passed three isolated reruns, Ctrl+C cancellation known. This is not all-green and is not the new 4f16903 result. RE's fresh current-cut gate report remains required. PDL owns code disposition/final reviewed SHA; RE owns packaging/install lane. Existing 4f16903 validation can inform the review but any code fix requires affected gates and a newly pinned artifact.

## Both specific code holds resolved: f1011d0

Request post_01a11a6b-04ff. Independently inspected committed publisher ancestry guard, unchanged-selection refusal, direct desktop helper handoff and regressions at f1011d0b4a954a8bee82292ea212768565baa4b3. Exported the exact commit with git archive into an isolated temporary directory; linked host node_modules for existing test dependencies. Reran desktop-source and real-pnpm changed-install tests: 5 passed; upstream real API/core/Git boundary tests: 7 passed. Zero failures/cancellations/skips. Temporary export removed after run.

An older source is refused with preserving-merge guidance before staging/selection, both with an existing active manifest and with no manifest after failed first setup. Preserving fast-forward then publishes B. Real pnpm regression installs a newly added development dependency under inherited production mode, builds/typechecks and selects a fixture runtime. Upstream test checks actual generated owner update request, with direct quoted --publish and no preliminary pnpm install/build. This proves helper and request boundaries, not model obedience or full installed compilation (stage/smoke adapters are fixtures).

Disposition: close these two specific code holds at f1011d0. Release Engineer must integrate it into the final isolated cut and record that exact source SHA, affected/required gates and a matching new DMG/installed journey. 4f16903 gates alone do not verify this fix. Overall release sign-off/publication remains open; no competing package build, push or upload by PM.
