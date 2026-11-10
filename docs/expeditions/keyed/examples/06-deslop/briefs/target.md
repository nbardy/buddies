# Target: the lean design, its budgets and its slices

You are writing the plan of record for this cut: what the code should look like when it is done,
and the fenced slices that get it there. You have the measured size of the tree and one inventory
per area. No code changes in this step.

## Read first

- The measurement and every inventory in your inputs.
- `agent_notes/2026-09-25_lean-rewrite/CLOSEOUT.md`, `FINAL-REPORT.md` and the three `BUDGET-*.md`
  files: what the last cut achieved, what it missed and why. Do not re-plan work that already
  landed, and do not repeat a budget that assumed a move which never happened.
- `agent_notes/2026-09-27_deslop-all-slices.md` and `docs/patterns.md`.

## Write, under `agent_notes/2026-11-10_deslop/`

- `INVENTORY.md`: the area inventories merged into one table of facts: each fact, its competing
  definitions, its writers and readers, and the ONE owner you choose for it.
- `TARGET.md`: the lean design in prose and types. For each area, a line budget and the reason it
  is achievable, tied to named deletions. Then a "Kept as-is" list: code that looks redundant but
  stays, with the reason.
- `TARGET.json`: the slices, the same list you return.

## Slices

Each slice has an `id`, a `wave`, a `kind`, a `fence` (the only paths it may change), `retires`
(the exact path, export or definition it deletes, and the tests that go with it) and `keeps` (the
behaviour a real consumer must still see, and which test or screen shows it).

- A `slice` stays inside one fence and replaces and deletes one redundant path. Within a wave no
  two fences overlap, down to the file. A lint checks this before any code is cut. The host
  enforces each fence on its worker, and a fence must lie inside `server/src/`, `server/test/`,
  `client/src/`, `client/test/`, `shared/src/` or `crates/`.
- A `seam` is a change that cannot be fenced to one area: moving a type to its one owner in
  `shared/src` and re-pointing every consumer. Seams are done by one worker, one at a time, before
  the wave's slices. Keep them few. A wave with three seams is a wave planned wrong.
- Order the waves so that each wave's slices can assume the earlier waves landed. Put the cuts
  with the clearest check and the largest deletion first.
- Size a slice so one worker finishes it in about 40 minutes including a full test run.

## What good looks like

- A reader can take any slice and say what will be gone afterwards.
- No slice is "introduce X". If X is new, the same slice or seam deletes what X replaces.
- The budgets add up to a number, and you say plainly whether it reaches the owner's bar. If it
  does not, say what would be needed and leave that decision to the owner.

Stop when the lint would pass. Do not start cutting.
