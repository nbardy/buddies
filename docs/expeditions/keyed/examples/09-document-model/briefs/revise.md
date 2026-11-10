# Revise: answer the round

You designed the current model, and this call continues that work. In your inputs are the
critique, the referee's ruling on each defect, any spike results, and the ledger. The owner's
answers to this round's questions are also in your inputs, each starting "Owner ruling on" and
the question's id.

Owner answers are fixed. Quote each one in `ROUNDS.md` with today's date before you change
anything, and design to it even where you argued the other way.

## For every defect the referee ruled `stands`

Do one of three things, and say which in `ROUNDS.md`:

- **Change the model** so the critic's concrete case is handled. Show the case working.
- **Scope the row out**, only if an owner answer permits it. Cite the answer.
- **Concede it open.** If you cannot fix it without breaking something else, write down the
  conflict plainly. An honest open defect is better than a patch that moves it.

Do not re-argue a `stands` ruling. If you believe the referee misread the model, the fix is to
make `MODEL.md` say it clearly enough that the next round reads it correctly.

## Spikes

A refuted claim comes out of the model or is redesigned. A supported claim keeps its tag as
CLAIMED until rerun independently. Do not promote it.

## Update

- `MODEL.md` in place. It must read as one coherent model, not a model plus amendments.
- `COVERAGE.md`: every ledger row again, in order. A row whose section changed gets rechecked.
- `ROUNDS.md`: append this round: the defects, the rulings, the owner answers, what changed and
  what did not. Never edit earlier rounds.

## Watch for

- Growth. If this revision adds a core concept, name the concept it removes or explain why the
  core is still small. Each of the eight earlier designs grew this way.
- Fixing a defect by adding a layer beside the running model. The model must still be able to
  replace it.

Commit when `COVERAGE.md` again has a line for every row. A reviewer on another provider will
check coverage against the ledger before the next round starts.
