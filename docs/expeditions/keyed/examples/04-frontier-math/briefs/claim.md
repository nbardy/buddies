# Claim: exactly what the receipt supports for `{{id}}`

You built this slice. The host has now run its one falsifier, and the receipt is in your inputs.
There will be no second run. Your job is to write down what was shown, and nothing more.

## Write `candidates/{{id}}/CLAIM_LEDGER.md`

1. **Prediction against measurement.** Copy the numbers from `PREDICTION.md` unchanged, put the
   measured numbers beside them, and state the difference. Do not explain a miss away.
2. **The comparison.** Which baseline, on which adapter, at which commit, and the physical error
   of both sides. Matched means within the tolerance frozen in the reference contract. If the
   baseline was not the best admissible member of the reference class at the same order (for a
   time integrator: the same-stage Gauss, Lobatto or Radau scheme), say so; the speedup then
   does not stand.
3. **Complete cost.** Setup, compile, evolution, adaptation, certification, conversion, rejected
   work, fallback, readback and output, each from the receipt. A term the receipt does not
   report is written "not measured", not zero.
4. **The claim.** One sentence with the speedup factor, the scene, the error and the hardware.
   Then the list of larger claims this does not earn: other scenes, other resolutions, the
   full solver, scaling.
5. **The hostile control.** What happened on it.

## Rules

- Change no source and no threshold. This step adds the ledger and the receipt pointer only.
- Every number carries the path of the receipt it came from.
- If the measurement refutes the premise, write that as the claim. A clean refutation with its
  mechanism is what the graveyard needs, and it is a better outcome than an inflated survival.

A reviewer on another model, who has not seen your conversation, will recompute the comparison
from the frozen source and the receipt. Their verdict is written to the learning log by the host;
do not record a verdict yourself.
