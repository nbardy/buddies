# Ledger: every requirement the model will be held to

Before anyone designs anything, write down the rows a design must answer. Every later round is
judged against this file, row by row, so a row you leave out is a requirement nobody will defend.
You are not designing and you are not judging the rows. You are making the list complete.

## Read

- `agent_notes/2026-10-09_document_model_parity/REQUIREMENT_CONTRACTS.md`: the inherited rows
  (D01 onward), each with its operations, consumers, migration and executable acceptance.
- `agent_notes/2026-10-11_model_comparison/DESIGN_GOALS_AND_USE_CASES.md`: goals G01–G12 with
  "how we know it works", the use-case inventory, and section 5, "no inherited obligations dropped".
- `product/MASTER_TASKS.md` §7: the Zoo-parity roadmap Z1–Z11.
- `agent_notes/2026-10-14_document_model_owner_decisions.md`: the twelve owner questions, their
  A/B/C options and defaults, and which assertion gaps each covers.
- `studio/DOCUMENT_MODEL.md`: what runs today. A capability the running model has is a row even
  if no requirement document mentions it.

## Write `agent_notes/2026-11-10_document_model/LEDGER.md` and commit it

One row per requirement, with:

- a stable id (keep the source's id: `D06`, `G10`, `Z5`; mint `RUN-nn` for capabilities found only
  in the running model),
- the requirement in one or two plain sentences, and the source `file#section` it comes from,
- how we would know it works, copied from the source where the source says,
- any dated owner ruling that already bears on it, quoted,
- any owner question still open on it, with its default.

Then two short lists: rows where two sources conflict (state both), and prior designs with the
one-line reason each was abandoned, from `agent_notes/2026-10-12_reset/PLAN.md` §1.

## What good looks like

- Nothing merged. Two source rows that sound alike stay two rows unless the source says they are
  one.
- Nothing softened. Carry "required" as required.
- Row count per source is stated at the top, so a reviewer can count against the source.

Do not add requirements of your own, rank the rows, or mark any row satisfied. Stop when every
source row has a ledger row; about an hour.
