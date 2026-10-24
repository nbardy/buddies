# Bundled revision floor and direct desktop build handoff

PM blockers: post_01a11a66-8508-748f-b690-a57579a23e8b, agent_notes/2026-10-08_delivery-release-continuation.md. Existing task task_01a117b8-fee8-742d-a2a4-1eee266b3073.
Fix commit f1011d0b4a954a8bee82292ea212768565baa4b3, five scoped files. Concurrent client formatting/catalog/submodule edits excluded. No push or build artifact produced in this turn.

## Behavior

Publisher now requires the source commit to contain the bundled metadata revision (Git merge-base --is-ancestor). Older/divergent/missing ancestry refuses publishing with preserving-merge guidance, leaves existing selection unchanged and the bundled app available. The same guard applies to setup Retry and explicit publishing through their canonical publisher. It does not merge or discard owner source edits. An old failed source cannot be labelled with the new bundleRevision to bypass newer-native selection.

Desktop upstream update request now goes from owner-authorized merge directly to the shipped --publish helper. Removed the redundant preliminary production pnpm install/build which could silently skip changed dependencies or fail before gitlink reconciliation. Helper remains the single reconciliation/development-install/build/typecheck/stage/smoke authority. Ordinary source checkout handoff retains pnpm install/build. This replaces duplicate instructions, not the existing merge authority or grants.

## Evidence

Exported exact f1011d0 source into output/desktop-blockers-20261008/committed; host node_modules linked for TS test dependencies. pnpm test:desktop: 5 desktop + 6 managed-source tests pass; exported upstream tests7/7 pass, no failures/cancellations/skips.

Real filesystem/Git old-checkout/new-bundle regression covers prior active manifest and no-manifest failed-first-setup cases: publishing A under bundle B refuses, A remains untouched, bundle remains selected, preserving fast-forward merge allows B. Removing ancestry guard on a separate exported copy makes this regression fail (exit1).

Changed-dependency real-pnpm regression starts with production-only dependency tree, commits an update adding a previously absent build tool and lockfile change, then runs helper --publish under parent NODE_ENV=production. Correct install/build/typecheck/staged fixture selection succeeds; build asserts development environment and availability of the newly added tool. Staging/smoke are fixture adapters, not full installed-app proof.

Upstream HTTP/Buddies-core boundary test inspects the actual posted request: direct safely quoted --publish command, reopen guidance, no preliminary pnpm install/build. This proves generated instruction contract, not nondeterministic model obedience. Existing task/idempotency regressions retained.

Scoped Biome and git diff --check pass. Shared-tree pnpm typecheck passed, but catalog/submodule work is dirty, so full typecheck is not claimed as an exact-cut gate. Release Engineer must gate the combined commit. pnpm token-audit --tag buddy executed after handoff change: historical497sessions/26krequests/~136.6M excess3.4%; not a causal before/after improvement measurement. Prompt-engineering skill applied to minimal contract correction; no model-specific performance claim.

## Handoff

Release Engineer's4f16903 gates remain prior-cut evidence. Include f1011d0 in final isolated cut, rerun affected/required gates and package that reviewed SHA. PM review requested. Native automatic setup/ready/Quit/reopen/real reply/update/data/failure proof, clean-Mac distinction and concrete publication approval remain required. Offline deploy/symlink/pending-dir follow-ups stay nonblocking per PM; relay-leak task ownership unchanged.
