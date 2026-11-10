# Rubric: does the model answer every ledger row, for real?

You are reviewing a document model written on another model, against the requirement ledger.
There is no test suite for a design. You are the check, so do the work a test would do.

## Check

1. **Every row has a line.** `COVERAGE.md` lists every ledger row, in order, as `covered`,
   `scoped out` or `open`. A missing row is a fail before you read anything else.
2. **Covered means shown.** Pick at least twenty `covered` rows, weighted toward the hard ones:
   identity and references, Undo and cold reopen, geometry that must keep its meaning, anything a
   prior critique broke. For each, open the cited `MODEL.md` section and ask whether you could
   work the row's acceptance through the model's types as written. A section that names the
   topic without showing the mechanism is not coverage.
3. **Scoped out means decided.** Each `scoped out` row cites a dated owner ruling or is listed as
   an owner question. The designer scoping out a required row on its own authority is a fail.
4. **Owner rulings are obeyed.** Every ruling quoted in the ledger or in `ROUNDS.md` is
   reflected in the model. Quote any contradiction.
5. **It can replace what runs.** The model does not depend on the running model in
   `studio/DOCUMENT_MODEL.md` remaining in place.
6. **The record is intact.** `ROUNDS.md` still has earlier rounds as they were written.

## Verdict

Pass only if every row has a line, at least nine in ten of the rows you checked are shown and
none of the failures is a row the model's central idea rests on, and checks 3 to 5 hold with no
exception.

In your answer list each row you checked, the section you opened and what you found. Judge the
model as written, not as it could be charitably read; the next reader will be an implementer.
Do not fail it for being unfinished where it honestly marks a row `open`, and do not pass it
because it is well written.
