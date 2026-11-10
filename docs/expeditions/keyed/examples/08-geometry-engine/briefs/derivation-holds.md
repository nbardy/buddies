# Rubric: do the derived conditions hold?

You are reviewing a derivation note written on another model. The code that follows will be
built on it, and one scarce evaluation will be spent on that code, so an error here is expensive.

Do not read the note's conclusions first. Open `studio/design_kernel/native_geometry/curved_wall.ts`
and take the authored dimensions from the source. Then derive for yourself:

1. **The cap-intersection radius.** At what bore radius does the cutter's end cap meet the inner
   wall? Compare with the note. Check the tangency case is treated as a refusal, not as admitted.
2. **Topology of the admitted case.** Count faces, edges and vertices. Check the Euler
   characteristic for one closed solid of the stated genus. Check every edge joins exactly two
   faces with opposite orientation.
3. **Volume.** Evaluate the cylindrical-chord integral independently for each radius, by a method
   different from the note's if you can (numerical quadrature against a closed form). Agreement
   must be within the note's own stated error.
4. **The memory bound.** Follow the formula from tolerances to triangle count to bytes. Check that
   it is a bound on the peak and not on the final mesh, and that no step rests on a statement
   labelled CONJECTURE.

## Pass

Pass only if your numbers for 1 to 3 match the note's, the topology closes, and the memory bound
is a real upper bound below the 268,435,456 B cap with its margin stated. List each quantity, your
value and the note's value.

Fail for any disagreement, with your derivation. Fail a memory "bound" that is an estimate from a
previous run. Do not fail the note for style, length or for leaving general CSG out of scope: the
scope is the finite D2 boundary only.
