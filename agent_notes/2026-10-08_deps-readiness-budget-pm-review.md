# PM review: dependency readiness budget 1a67b16

Reviewed exact commit `1a67b16bb41d198cbcd8546d998e178eb8a36957`, not the dirty shared tree. Only `server/test/dependencies.test.ts` changes. Production probe default remains 45 seconds. The 30-second success/installation budget, separate 1.5-second hanging instance and Codex-ready assertion before the hanging fixture preserve the relevant behavior checks.

## Disposition

Accept the budget split in principle; request a small test-only correction before including the final release cut. At committed lines 59–62 the new elapsed <10 seconds assertion measures the entire refresh: temporary-directory work, multiple subprocess probes (Claude version and response sequentially), child close delivery, filesystem cleanup and event-loop scheduling. A correctly killed child can therefore fail this bound under contention. Ten passing repeats at reported load 8–11 and a two-second fixture delay do not establish resistance to arbitrary parent scheduling delays. The line-17 claim that load can only make the assertion more true is incorrect and should be removed/reworded, along with the corresponding evidence-note claim.

RE next action: remove the wall-clock assertion and retain timeout classification, or replace it with a real fixture completion marker after sleep and assert the marker is absent after refresh. Prefer an immediate --version fixture response so the hang checks the actual response probe. If retaining explicit kill coverage, demonstrate that disabling process-group termination fails that marker guard. Do not merely enlarge the elapsed threshold. Existing passing repeats and old-fails/new-passes evidence suffice for the budget split; they do not justify the elapsed assertion's load-immunity claim.

## Evidence checked

Read retained deps-1 through deps-10 logs: each 4 passed, no failures/cancellations/skips. Read slowprobe-old.log (missing/failed/missing assertion failure), slowprobe-new.log (one pass), and typecheck.log. The temporary falsification fixture copies were deleted, so their exact source cannot be independently inspected from these artifacts. Biome pass remains RE-reported; not rerun by PM.

PM independently ran `pnpm exec tsx --test server/test/dependencies.test.ts` in `/Users/nicholasbardy/git/_wt/rel-deps-budget`: HEAD exactly 1a67b16; porcelain empty before and during run. Result: 4 passed, 0 failed, 0 cancelled, 0 skipped; duration 10332 ms (first test 6491 ms). This is a clean-commit targeted test run, not a full-suite gate or DMG verification.

Steering defect and full-suite release HOLD remain open. No replacement DMG, integration, publication or release approval established by this review. Development Lead coordinates inclusion; RE owns corrected test commit and matching final-cut gates/artifacts.
