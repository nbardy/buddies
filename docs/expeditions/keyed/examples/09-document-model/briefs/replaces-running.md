# Rubric: does this plan actually retire the running model?

You are reviewing a retirement plan written on another model. The owner has ratified the design.
The question here is narrower and has been failed eight times: will following this plan leave the
old model deleted, or will it leave a new model sitting beside it?

## Check

1. **The inventory is the running model.** Take the layers and components that
   `studio/DOCUMENT_MODEL.md` lists. Each appears in `RETIREMENT.md` with a fate. Pick ten paths
   from the inventory and confirm each exists in the tree at this commit.
2. **Every fate is defensible.** `replaced by` cites a section of the model that really does that
   job. `deleted with no successor` cites the ledger row and the owner ruling that scoped it out.
   `kept` explains why the thing is not part of the document model.
3. **Every step deletes.** Go through the ordered steps. A step that only adds fails, unless the
   very next step deletes what it supersedes and the plan says what happens if work stops between
   them.
4. **Consumers are named.** Each step names the check that shows real consumers still work: edit,
   Undo, save, cold reopen, export, and existing saved documents opening. "Tests pass" with no
   test named is not a check.
5. **Old documents.** There is an explicit migration, with original bytes and readers retained
   until it is proven.
6. **The first step can start.** It names files, a consumer journey and an acceptance.
7. **Conditions.** Any condition in the owner's ratification note is met.

## Verdict

Pass only if all seven hold. In your answer, list the paths you checked, each step and what it
deletes, and anything in the running model you could not find a fate for.

Do not reopen the design: whether the model is right was the previous question. Do not pass a
plan because it is detailed; a detailed plan to build beside the old model is the failure this
rubric exists to catch.
