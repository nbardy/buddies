# Repair: {{row}} on Engine {{engine}}

You have just written the failure-class page for this cell, and this call continues that
conversation. Now make the one repair the page names. Not a different one, and not two.

## Build

- Change only files under `prototypes/eulerian_mac_mg_v0/cuda_body_forces_v1/`. The checkout
  starts from the commit that holds your failure-class page.
- Repair the mechanism in the shared path. Do not add a case-specific branch, a tuned constant
  that only this Scene needs, or a new "sidecar" beside the solver. If the row can only pass with
  a special case, the diagnosis is wrong: say so and stop.
- Keep every other row's physics untouched. Still water (R2) passes on this engine today at
  4e-7 m; a repair that disturbs hydrostatic balance has traded one row for another.
- Any tolerance you add comes from `tools/sim_runner_v1/tolerance.ts`. No bare numbers, and no
  f32 relative tolerance below 1e-4.
- GPU legality is part of the method: buffers, capacities, reductions, pass order. No CPU
  fallback in the hot loop.
- Add or extend a `test_*.py` beside the source that pins the repaired behaviour on a small known
  answer, with no GPU. The directory's unit tests are your judge; run them and fix what you break.

## What happens after you commit

The host, not you, replays every saved failure for {{row}} against your commit on the local M4.
Only if all of them pass does it spend one of this row's two paid runs to score the frozen case on
Modal. You get no third run. So before you commit, ask whether the saved failures will pass and
why; if you cannot say why, you are not done.

## Do not

- Launch Modal, the local GPU or any campaign script yourself.
- Touch `tools/capability_matrix_v1/`, `benchmarks/capability_matrix_v1/` or the scoring window.
- Rename a second attempt so that it does not look like one.
- Claim the row passes. You have not seen a score.

Write a `learn` row before you commit: the repair, its family, the error you predict on the
frozen case, and leave the measurement for the host's runs. In your summary, say in three lines
what you changed and what a failed paid run would most likely mean. Stop when the tests pass and
the change is committed.
