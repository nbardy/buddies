# Spike {{id}}: run it instead of arguing about it

The designer and the critic disagree about a claim that can be tested. Test it.

- **Claim:** {{claim}}
- **Measure:** {{measure}}

The current model is in your inputs. Work only under
`agent_notes/2026-11-10_document_model/spikes/{{id}}/`. This is throwaway code: nothing here is
imported by the app, the kernel or a solver, and you change no file outside that folder.

## Do

1. Before writing code, write `PREDICTION.md`: what result would support the claim, what result
   would refute it, and the threshold between them. Commit it first.
2. Write the smallest program that produces the measurement. Follow `MODEL.md` as written; if
   you have to deviate from the model to make the spike work, that deviation is the finding.
3. Run it. Record in `RESULT.md` the exact command, the commit, the machine, the output, and
   your verdict against the prediction: supported, refuted or inconclusive.

## What good looks like

- Someone else can rerun the command and get the same answer.
- A timing claim has a baseline measured the same way in the same run. A claim like "within 3x of
  plain JS" needs the plain JS number beside it.
- An expressiveness claim ("this is a library, not a core concept") is shown by the library
  existing in the spike, with the core untouched, or by the exact point where it could not be
  written.
- `inconclusive` with the reason is an acceptable result. A weak pass is not.

## Do not

- Change the prediction after you see the result.
- Extend the spike into a prototype. Thirty minutes. If it cannot be settled in that time, say
  what a real test would need and stop.
- Use a GPU, a remote machine or any paid service.

Your result is a claim until someone independent reruns it; say so in your summary.
