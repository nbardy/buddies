# Desktop managed update gitlink reconciliation

Request: post_01a117da-bd19-7034-a45e-96aae894b0b4.
Task: task_01a117b8-fee8-742d-a2a4-1eee266b3073.
Base: 9360fb42fb1cb56e214a98d8dce798d8f4d95937.
Local branch: fix/desktop-gitlink-handoff, isolated checkout /tmp/unleashd-gitlink-fix-I5rtoB.

## Change

The managed helper now reconciles recursive committed submodule pins before installing dependencies or building, including the explicit --publish path. Both setup and publishing install frozen dependencies. The guard first rejects outer edits, staged gitlink changes, and recursive nested tracked/staged/untracked edits. Clean nested HEADs must be ancestors of the target pins; missing target objects are fetched without changing HEAD. Divergent local commits and backwards pin changes are conservatively refused for manual review. It uses sync and update --init --recursive --checkout, without --force/reset or automatic merges. A final cleanliness check precedes installation/build. Failed reconciliation preserves the active runtime selection. The new helper ships in the DMG payload; the new boundary test is included in test:desktop.

## Evidence

`node --test tools/desktop-source.test.mjs tools/desktop-source-git.test.mjs`: 3 passed, 0 failed/cancelled/skipped in the isolated checkout. The new test uses actual local Git repositories, a recursive clone, an ordinary fetch/fast-forward outer merge, and prepareSource({publishOnly:true}) through atomic runtime selection. Build/install and stage/smoke adapters are fixture implementations; this proves Git/build ordering, refusal and selection, not actual application compilation or installed-Mac behavior.

Recorded fixture revisions:
- Outer A: 8a1aa58a48812cf9d43648a2e27e65104016adb5
- Nested A: 389f4226888899e22c1da5ba9928cb2081049f22
- Outer B: de9fa4863fa6a78519d1ac673571a75c3b7e2fe8
- Nested B: 19e4485a0986d06f49adfa69fdf170278ab87b46
- Preserved divergent owner commit: 57de58cdd30cd4f7e9a43c105290ba1b8bd885b9

The outer merge leaves nested A checked out while pinning B. Tracked, untracked and staged nested edits each cause refusal before any install/build call and retain selected A. A divergent nested commit is likewise refused and retained on its branch. Once the fixture returns to clean A, install/build/typecheck see clean B, selected runtime records outer B, staged fixture content is B, and immutable A remains available.

Mutation check: removing the reconciliation call makes the new test fail when installation sees the stale/dirty nested checkout. The original source was restored. Biome check of all changed code/package files passed. A broader desktop TS test attempt lacked @nbardy/agent-cli in this dependency-free isolated clone (login-path prerequisite failure; server-env tests 2 passed); no claim of full desktop suite/build/DMG validation.

## Integration and disposition

Keep this fix as a distinct local commit from concurrent, unfinished setup-status changes in the shared tree. Do not sweep those changes into this commit. The canonical updater task remains in review. Integrate with the setup-status work, then build/test the resulting exact revision and complete the installed update evidence required by the PM review. No main push, upload, DMG rebuild, live-store access, or owner publication approval occurred. Existing owner A/B decision and launch hold remain.
