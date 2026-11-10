# Inventory: who defines, writes and reads each fact in `{{path}}`

You are one of several readers, each given one area of the repo. Yours is `{{path}}`. You change
nothing. Someone else will write the lean target from your answer and the other areas' answers, so
what they need from you is a record they can trust, not a plan.

## Read

- Every source file under `{{path}}`. Open the files; do not infer from names.
- `docs/patterns.md`, for the patterns the code is supposed to follow (one store + one index, sum
  types, one write path, one type source).
- Outside your area, read only as far as needed to answer "who else defines or uses this".

## Record, for your area

1. **Facts with more than one definition.** A fact is something the system knows: a conversation's
   kind, a turn's state, a Buddy's grant, a row's shape on the wire. For each one defined in more
   than one place, list every definition (`file:line`), every writer and every reader, and say
   which definition the running code actually obeys.
2. **Parallel paths.** Two code paths that do the same job (an old route beside its replacement, a
   JS implementation beside the Rust one, a mapper beside the schema it mirrors). Name both and
   name the callers of each.
3. **Types that hide a decision.** Optional fields that mean "not decided", string tags compared
   in several places, `if` ladders on kind inside a function that should not care.
4. **Dead code.** Exports with no production caller. Give the search you ran. A caller in a test
   only counts as a test, so say so.
5. **Size.** Lines per file, largest first, and the three files you would look at first.

## What good looks like

- Every entry has a `file:line` a reader can open. Search a single file before you quote from it:
  recursive search output in this repo is rewritten and is not safe to cite.
- "I did not find a second definition" is a useful answer. Do not manufacture findings.
- Where you are unsure whether two things are the same fact, say so and say what would settle it.

## Do not

- Propose slices, budgets or a design. That is the next step's job.
- Run tests, builds or the app.

Stop after about 15 minutes. An honest partial inventory that names what you did not read is
better than a complete-looking one.
