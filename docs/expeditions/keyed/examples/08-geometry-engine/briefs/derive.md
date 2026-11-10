# Derive: the geometric conditions, before any code changes

You will hold this whole task in one conversation: derivation now, then implementation rounds
that continue from here. Nothing is run in this step. Take the time it needs.

## Read first

- `agent_notes/2026-10-30_own_geometry/REQUIREMENTS.md`, especially the operation-to-core map,
  "Smallest honest first replacement" and "Source-review correction".
- `agent_notes/2026-10-30_own_geometry/MESH_DESIGN.md` and `WORK.md`.
- `studio/design_kernel/native_geometry/boundary.ts`, `curved_wall.ts` and `boundary.test.ts`
  (read the test; never edit or run it).
- `oompa/geometry/guard.py`, and the earlier guarded receipts under
  `output/2026-10-30_own_geometry/` if they are present.
- The learning log in your inputs: earlier attempts and why each stopped (residual, capacity,
  timeout). Do not propose again what is already rejected there unless you say what is different.

## Produce `agent_notes/2026-10-30_own_geometry/DERIVATIONS.md`

1. **The admitted domain.** Derive, do not quote, the radius at which the bore cap meets the inner
   wall. REQUIREMENTS states r > sqrt(3.75^2 - 2^2) - 2.5; re-derive it from the authored recipe's
   dimensions and say whether you agree. State the tangency case separately. Everything outside
   the seven-face through-bore topology must refuse.
2. **Faces, trim curves, adjacency.** For the admitted domain: each face with its surface type,
   each edge with its curve type and the two faces it joins, and the orientation convention. Show
   closure (every edge used exactly twice, oppositely).
3. **Known answers.** The enclosed volume by an independent cylindrical-chord integral, in closed
   form or as a one-dimensional quadrature with a stated error, for each radius the suite uses.
   Face areas and edge lengths where a closed form exists.
4. **A memory and time bound.** From the mesh tolerances, a bound on vertices, triangles and peak
   allocation for each case, as a formula. The last run died at 270,024,704 B against a cap of
   268,435,456 B. Say where the bytes go and what bound your design guarantees.

## What good looks like

A reviewer on another model re-derives items 1 to 3 from the authored dimensions alone and gets
your numbers. Label each statement TEXTBOOK, DERIVATION or CONJECTURE. A bound you cannot prove is
a CONJECTURE, and item 4 may not rest on one.

Commit the note. Change no source in this step.
