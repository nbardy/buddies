# Rubric: is the geometry behaviour preserved, and is the receipt true?

You are reviewing a candidate written on another model. Inspect the source, not the author's
prose. Read the full diff from the launch base to the candidate commit. Do not execute anything
except read-only git and file inspection; the host owns execution and the one replay is spent.

## The receipt

1. `G0_RECEIPT.json` matches the host's stored result of the replay: same commit, same command,
   same peak RSS, duration and counts. All tests completed and passed. Peak RSS and elapsed time
   are under 268,435,456 B and 60 s.
2. No source file changed between the replayed commit and this one. Only notes and the receipt.

## The source

3. Nothing outside `boundary.ts`, `derived.test.ts` and the notes folder changed.
   `boundary.test.ts`, `oompa/geometry/` and `field_core/` are byte-identical to the base.
4. No cap, tolerance or check was weakened. No refusal case was dropped. Compare each tolerance
   constant and each refusal branch with the base.
5. The boundary is still analytic: curved faces, trim curves and adjacency are constructed, not
   sampled from a grid or a display mesh. No path reaches OCCT, and no unsupported input falls
   back to anything; it refuses with a typed error before a result is published.
6. The cap-intersection and tangency refusals are enforced where `DERIVATIONS.md` says, at the
   derived radius.
7. Memory fits by construction: the sizing code the probe counts is the sizing code the mesher
   uses. A bound proved on a copy of the logic does not count.

## Pass

Pass only if all seven hold. Cite the commit, file and line for each. Rank anything you find by
severity.

Fail for any weakened check, any edit outside custody, any receipt field that does not match the
host's record, or a claim beyond the task. This candidate is one finite D2 boundary. It is not a
general kernel, and it does not establish Product receiving, physics or performance.
