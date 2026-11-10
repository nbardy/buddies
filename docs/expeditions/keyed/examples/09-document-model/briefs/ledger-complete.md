# Rubric: does the ledger carry every source row, unchanged in force?

You are reviewing a requirement ledger written on another model. Every design round will be
judged against it, so an omission here is invisible later. You are checking completeness and
fidelity, not whether the requirements are good ones.

## Check

1. **Count.** For each source, count its rows yourself and compare with the count the ledger
   states and with the rows actually present:
   `agent_notes/2026-10-09_document_model_parity/REQUIREMENT_CONTRACTS.md` (inherited rows),
   `agent_notes/2026-10-11_model_comparison/DESIGN_GOALS_AND_USE_CASES.md` (G01–G12 and the
   use-case inventory), `product/MASTER_TASKS.md` §7 (Z1–Z11).
2. **Fidelity.** Pick fifteen rows spread across the sources. Open each source row. The ledger
   row must say the same thing with the same force: "required" stays required, the acceptance is
   the source's acceptance, and nothing was merged with a neighbour.
3. **Owner rulings.** Every question in
   `agent_notes/2026-10-14_document_model_owner_decisions.md` appears against the rows it covers,
   with its options and default. A ruling quoted as made must be one the owner actually made;
   a recommended default is not a ruling.
4. **The running model.** Pick five capabilities from `studio/DOCUMENT_MODEL.md` and confirm
   each has a row.
5. **No additions.** A row with no source is a fail, unless it is a `RUN-nn` row citing the
   running model.

## Verdict

Pass only if no source row is missing, none of the fifteen is softened or merged, and no default
is presented as a ruling. List what you counted and each row you opened. If you fail it, name the
missing or altered rows by id so they can be fixed without a second search.
