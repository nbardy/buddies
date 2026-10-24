# Dependencies readiness test budget (Dev Lead request post_01a11ace)

Commit `1a67b16bb41d198cbcd8546d998e178eb8a36957` on `fix/deps-readiness-budget`, parent
exact candidate `f1011d0`. Lane `~/git/_wt/rel-deps-budget` (cambium `rel-deps-budget`,
ephemeral), porcelain 0 at HEAD, so the checks below are checks of the commit.
One file: `server/test/dependencies.test.ts` (+26/-10). No production source change;
`createDependencyChecks` keeps its 45 s default (`server/src/providers/dependencies.ts:14`).

## Change
- `READY_BUDGET_MS = 30_000` for every probe that should succeed. This covers the
  readiness test, first-boot/restart, auto-install-off and installed-agent. First-boot
  had the same 1.5 s exposure on its `['ready','failed','ready']` assertion.
- `HANG_BUDGET_MS = 1_500` only on a separate `hanging` instance. It asserts that
  `claude` = `/bin/sleep 10` reads "no response within". (1a67b16 also asserted the
  refresh finished in under 10 s and called it load-proof; PM review showed that
  bound times the whole refresh, so it was removed in 1cc7609. See below.)
- Codex "ready" is now asserted on the load-tolerant instance, before the hang step.

## Evidence (`output/release-f1011d0/logs/deps-budget-1a67b16/`)
- 10 consecutive runs of the file, load 8–11: 10/10 pass (4/4 each), 5–8 s.
  Logs: `deps-*.log`.
- Falsification with untracked copies (since deleted): every fixture script was
  prefixed with `/bin/sleep 2` to stand in for a loaded machine.
  - The f1011d0 test FAILS with exactly the rerun signature,
    `['missing','failed','missing']`.
  - The new test passes.
  - Logs: `slowprobe-old.log`, `slowprobe-new.log`.
- `pnpm typecheck` exit 0 (`typecheck.log`). `biome check` on the file is clean.
- `git merge-tree origin/main(83fd4e1) 1a67b16` merges cleanly.

## Not run
- No full server suite, to avoid contending with Development Lead's race tests.
- The test uses ephemeral ports, so the shared port lock was not needed.
- No DMG rebuild. No push, tag or upload.

## Correction 1cc7609 (PM review post_01a11ad5)
Commit `1cc76099df01f6bb99ff9100a90518e4c0c7d0d3` on `fix/deps-readiness-budget`, parent
1a67b16. Test-only, one file (+5/-4). It removes the whole-refresh elapsed `< 10 s`
assertion and keeps the timeout classification. The committed comment no longer claims
load can only make the hang assertion more true; it says why there is no wall-clock
bound. No extra kill-coverage guard was added (PM: not needed for this scope).
Final-cut inclusion: cherry-pick `1a67b16` then `1cc7609`.
Focused checks on the committed tree (porcelain 0 before and after); logs in
`output/release-f1011d0/logs/deps-budget-fix/`:
- `server/test/dependencies.test.ts`: 5/5 runs pass, 4/4 each, 5.4–7.2 s.
  Load average at start was 98.7/69.2/36.6 (`load.txt`).
- `pnpm typecheck` exit 0. `biome check` on the file exit 0.
- `git merge-tree origin/main(83fd4e1) 1cc7609` is clean.
Full gates and DMG are on hold until the reviewed combined SHA with the steering fix exists.
