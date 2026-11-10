# Diagnose: why {{row}} fails on Engine {{engine}}

You own one cell of the requirement matrix: row {{row}} on Engine {{engine}}. It fails its frozen
gate. Your inputs hold the baseline score for this cell and, if this is a second round, the first
round's diagnosis, its repair, its local replay and its paid result. Read all of that history
before anything else. A second diagnosis that repeats the first one is a wasted strike.

You are not fixing anything in this step. You are writing the one-page design of the whole
failure class, so that the repair that follows is aimed at a mechanism and not at a symptom.
Plate lift took about nineteen paid attempts because each fix moved the fault to the next
particle and nobody had written down the class.

## Read first

- `benchmarks/capability_matrix_v1/matrix.json`: the case, window, reference and gate for {{row}}.
- `goals/2026-10-12_three_engine_goals.md`: the row's pass check and the 2026-10-12 status.
- `KEY_LEARNINGS.md`, especially "2026-10-07: Foil lift deficit is in the flow, not the force
  measurement" and the graveyard. Then the learning log in your inputs.
- `agent_notes/2026-10-12_engine_dual/R5_FIXED_SOLIDS_FAILURE_CLASS.md` as the model for the
  document you are writing.
- The engine source under `prototypes/eulerian_mac_mg_v0/cuda_body_forces_v1/` that the row exercises.
- The saved failures for the row in `benchmarks/capability_matrix_v1/saved_failures/`.

## Write `agent_notes/2026-11-10_capabilities/{{id}}_FAILURE_CLASS.md`, one page

1. The measured failure: the number, the gate, the commit, and where in the run it appears.
2. Localisation. Which term carries the error: the flow, the boundary treatment, the coupling, or
   the measurement? Show the saved-failure evidence that rules the others out. Check units,
   limits and the conservation ledger for the case.
3. The failure class: every way this mechanism can show up, not only the one in front of you.
4. What was already tried on this row, and why each attempt did or did not address the class.
5. One repair, and the prediction: the error you expect after it, as a number, and which saved
   failure will flip first. State what result would prove the diagnosis wrong.

## Answer

Return `family` (the mechanism family, in words the learning log already uses where one fits) and
`idea` (the one repair, in a sentence). The plan declares these as what the repair tests. If that
family is already rejected for this engine, your page must say what is different this time.

Write a `learn` row for the diagnosed mechanism. A reviewer on another model checks that your
localisation follows from the evidence. If the evidence cannot localise the failure, say which
local replay would, and return that as the idea. Do not launch anything on Modal or the GPU, and
do not edit the gate, the window or the reference.
