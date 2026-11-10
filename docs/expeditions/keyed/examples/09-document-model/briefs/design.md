# Design: one document model that can replace what runs

You are the designer for this expedition and you keep this role through every round: later calls
continue this conversation, so reason here in a way you can build on. The ledger is in your inputs
and is committed in your checkout. It is the list of what the model must answer.

## Read first

- The ledger, all of it, including the conflicts and the list of abandoned designs.
- `studio/DOCUMENT_MODEL.md`: the model that runs. Your design replaces this or it is not done.
- `agent_notes/2026-10-11_model_comparison/COMPARISON.md` and `design_v1/` (`MODEL.md`,
  `CODE_PLAN.md`, `ACCEPTANCE.md`, `RETIREMENT.md`): the most recent attempt.
- `studio/design_kernel/09_ADJUDICATION.md`: what a serious critique of an earlier draft found,
  including "smuggling a feature catalog while calling B-rep a backend problem".

## Write, under `agent_notes/2026-11-10_document_model/`

- `MODEL.md`: the model. Start with the types: the document's layers, what is authored and what
  is derived, identity and references, how an edit, Undo, save and cold reopen pass through it.
  Then the interface a person or an agent actually uses, and why it is leaner than Zoo's or
  Onshape's for the same capacity. Say what the core refuses to contain.
- `COVERAGE.md`: one line per ledger row: `covered` with the `MODEL.md` section that covers it,
  `scoped out` with the reason, or `open` with the owner question. Every row, in ledger order.
- `ROUNDS.md`: start it with this version's summary. Later rounds append; nothing is rewritten.

## What good looks like

- Small. If a capability can be a library over the core, it is not in the core, and you show the
  library's shape in ten lines.
- Each claim of capacity names the ledger row and the use case it serves, and how we would know.
- You say where this design differs from each abandoned one on the point that killed it. If it
  does not differ, that is a finding to state, not to hide.
- Where a decision is the owner's, you do not make it. You give options, a default, and what each
  costs, and mark the row `open`.

## Do not

- Write a design that needs the running model to stay. Additive designs are how the last eight
  ended.
- Mark a row `covered` because a section mentions it. Covered means a reader can see how the
  operation, its identity rules and its acceptance work in this model.
- Claim a performance or expressiveness property without tagging it SPECULATION until it is run.

Take the time this needs; this is one mind holding the whole model. Commit when `COVERAGE.md` has
a line for every row.
