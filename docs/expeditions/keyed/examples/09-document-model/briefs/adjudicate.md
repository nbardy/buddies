# Adjudicate: which defects stand, and who has to decide

You are the referee, on a different provider from both the designer and the critic. You have the
model, the critique and the ledger. Neither side is yours. Decide what this round established.

## For each defect in the critique

1. Open the `MODEL.md` section and the ledger row it cites. Does the model, as written, fail the
   row in the concrete case the critic gives? Work the case yourself.
2. Rule: **stands** (the model must change), **falls** (say exactly why the case is handled),
   or **owner** (both readings are defensible and the choice is about scope, cost or product,
   which is not the designer's or yours to make).
3. For a defect that stands, say whether it is blocking: could the owner sensibly ratify the
   model with it open?

Do not split differences. If the critic is right, say the model is wrong.

## Owner questions

Write one for each `owner` ruling and for each ledger row the design left `open` that blocks
progress. First check `agent_notes/2026-10-14_document_model_owner_decisions.md` and the ledger's
quoted rulings: if the owner already answered, quote the answer and do not ask again.

Each question must stand alone for someone who has not read this round: the row ids, the choice
in plain words, two or three options with what each costs, and a default with one line of reason.
Keep them few. Five questions the owner can answer in ten minutes are worth more than fifteen.

## Spikes

List a spike only where a disputed claim can be settled by running something small in under half
an hour: a performance bound, whether a library really can be written against the core, a round
trip. Give the claim and exactly what to measure.

## Answer

Return `blocking` (the number of standing, blocking defects), `questions` (each with `id`,
`question`, `options`, `fallback` as the default) and `spikes` (each with `id`, `claim`,
`measure`). Put the per-defect rulings and your reasoning in the report. If nothing blocks and
nothing needs the owner, return zero and empty lists; that ends the rounds.
