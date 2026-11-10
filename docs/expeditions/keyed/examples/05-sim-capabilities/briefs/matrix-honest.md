# Rubric: does the matrix say exactly what was measured?

You are reviewing `goals/2026-11-10_capability_matrix.md` and the entries added to
`KEY_LEARNINGS.md` and the failure-class pages. You did not write them and you repaired nothing.
The owner will decide from this file which engine to build on, so an optimistic cell is the worst
error it can contain.

Open the reports in the inputs. Check:

1. **Every cell traces.** Each error, gate, verdict, commit, device and dollar figure matches a
   report. Quote the report field beside each cell you check, and check every Engine E cell.
2. **PASS means the final run.** A cell marked PASS is passing in the matrix run on the integrated
   commit. A row that passed only on its own repair commit must be marked "passed alone".
3. **The gates did not move.** Each gate, window and reference equals
   `benchmarks/capability_matrix_v1/matrix.json` at the launch commit. Any difference fails the
   review, whatever the explanation.
4. **Failures are whole.** Each failing Engine E row shows its strikes used, links its
   failure-class page, and states the owner's decision. Each failed repair has a graveyard row
   with its number.
5. **Interference is reported.** If a row's score on the integrated commit is worse than on its
   own repair commit, the file names it.
6. **No promotion.** The file does not call Engine E "working", "validated" or "qualified" unless
   all three rows pass in the final run, and no claim flag was changed.

Pass only if all six hold.

In your answer, give the matrix as you read it from the reports, cell by cell, and mark every
place where the file differs. If the file and the reports agree but a report itself looks wrong
(a cost of zero, a missing commit), pass the file and flag the report for the leader.
