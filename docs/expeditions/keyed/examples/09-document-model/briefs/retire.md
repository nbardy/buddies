# Retirement: how this model replaces what runs

The owner has ratified the model. You designed it, and this call continues that work. The owner's
note with the ratification is in your inputs, starting "Owner ratification note".

Treat any condition in that note as a requirement. The remaining job is the one the last eight
designs never did: say how the running model goes away.

## Read

- `studio/DOCUMENT_MODEL.md`: the running model and its layers, as fact.
- `agent_notes/2026-10-11_model_comparison/design_v1/RETIREMENT.md` and `CODE_PLAN.md`: an
  earlier retirement inventory. Use it as a lead; recheck every path against the current tree.
- Your own `MODEL.md` and `COVERAGE.md`.

## Write `agent_notes/2026-11-10_document_model/RETIREMENT.md`

1. **Inventory.** Every part of the running model: schemas, readers, writers, evaluators,
   codecs, views. For each: the path, what consumes it, and its fate, which is one of `replaced by`
   (the section of the new model), `kept` (why it is not part of the document model), or `deleted
   with no successor` (the ledger row that scopes it out, and who decided).
2. **Order.** The sequence of steps that gets from today to the old model deleted. Each step
   names what it adds, what it deletes in the same step, and the check that shows real consumers
   still work: edit, Undo, save, cold reopen, export, and old saved documents still opening.
3. **Old documents.** How existing saved documents are read: an explicit migration, with the
   original bytes and readers retained until it is proven.
4. **The first step,** in enough detail to start: files, the consumer journey it carries, its
   acceptance.
5. **What would stop this.** The conditions under which the plan should be abandoned.

Then add a short dated note at the top of `studio/DOCUMENT_MODEL.md`:
the ratified model, a link to this folder, and the statement that the document still describes
what runs until each step lands. Change nothing else in that file.

## What good looks like

- No step is "build the new thing beside the old one" without a deletion attached.
- Every path in the inventory exists in the tree at your commit.
- An engineer could disagree with the order on specifics, because the specifics are there.

Do not start the migration, and do not edit app, kernel or solver code. Stop when the inventory
accounts for every layer the running model document lists.
