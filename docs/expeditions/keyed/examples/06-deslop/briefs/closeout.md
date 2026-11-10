# Closeout: what was cut, what was kept, what is still double

The waves are over. You have the measurement before and after, the target with every slice, and
the inventories. Write the record the owner will read and the next cut will start from. You are
working on the last landed commit; describe that commit, not your memory of the plan.

## Write `agent_notes/2026-11-10_deslop/CLOSEOUT.md`

1. **Numbers first.** Source lines before and after, tests before and after, as two separate
   deltas. Per area: budget, actual, and for every area still over budget, the specific reason.
   If the owner's bar was not reached, say so in the first paragraph.
2. **Per landed slice:** what it retired (paths, exports, tests) and the test or screen that
   shows the kept behaviour. Take this from the commits, not from the slice list.
3. **Slices that did not land:** each one, with the stage it reached (not started, failed its
   checks, passed but failed on the merged commit) and what blocked it. Do not fold these into a
   count.
4. **One owner per fact.** Go back through `INVENTORY.md` row by row. For each fact, check on
   this commit whether one definition is left. Mark it `single`, `still double` (with both
   `file:line`s) or `kept on purpose` (with the reason).
5. **Kept as-is.** Everything deliberately left, and why.
6. **What the next cut should know:** hidden consumers found, fences that turned out wrong, checks
   that passed when they should not have.

## Update the repo's own docs

Where a slice changed which file owns something, fix the code tree map and the affected rows in
`docs/` in the same commit. Where a seam created or moved a pattern implementation, check the
entry in `docs/patterns.md`. Do not write a new guide.

## Rules for this document

- A reviewer on another model will check section 4 against the code. Any row you mark `single`
  that still has two definitions fails the whole closeout.
- Do not describe an added interface as a simplification unless you name what it retired.
- Do not round the numbers or report the total without the test delta beside it.
- No code changes in this step. If you find something broken, report it.

Stop when the document is complete and every `file:line` in it opens.
