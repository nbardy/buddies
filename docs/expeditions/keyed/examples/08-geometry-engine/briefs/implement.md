# Implement: one round of the loop

You are continuing your own conversation. Your derivation note has been independently confirmed.
Each round you make one change, commit it, and the host tests the commit under the guard within
seconds. The result of that test is in your inputs at the start of the next round.

## Each round

1. **Read the last result first.** If this is not round one, your inputs hold the previous probe:
   pass or fail, the guard's reason, peak RSS, elapsed time, the tail of the output. The host
   has already written that round's row in the learning log (a pass is `keep`, a fail is
   `reject`); use `learn` only to add the mechanism the result showed. A refusal that says the family is already rejected means choose a
   different mechanism, not a different wording.
2. **Choose one change.** One mechanism, named. Write down, before you edit, what you predict the
   probe will show.
3. **Edit** `boundary.ts`, and `derived.test.ts` when the change needs a new check. Round one
   creates `derived.test.ts`.
4. **Commit**, and answer with `family` (the mechanism family, short and stable across rounds,
   for example `trim-span-allocation`) and `idea` (this round's specific change).

## What `derived.test.ts` is for

It is the cheap stand-in for a suite that can be run only once. It must show, without realizing
the full D2 boundary, that the full suite will pass under the caps:

- the known answers from your derivation (cap-intersection radius, volume integral, face and edge
  counts) checked against the code's own closed-form paths;
- the refusal cases: cap intersection, tangency, an unsupported feature graph;
- allocation counts for each suite case computed from the same sizing code the mesher uses,
  asserted under your derived bound. Count; do not allocate.

If a check here needs the full geometry to run, it is not a probe. Prove the property by
construction instead.

## Do not

- Run `boundary.test.ts`, or any test, yourself. You may typecheck.
- Change two mechanisms in one round. You have a first build and two repairs.
- Lower a tolerance, sample a grid where an analytic patch is required, or catch and hide a
  capacity error.

Stop each round at the commit.
