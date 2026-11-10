# Rubric: is each fact now owned once, and is the old path really gone?

You are reviewing a closeout written on another model, against the commit it describes. Do not
trust its table. You did not write any of this code.

## Check

1. **Single owners.** Take every inventory row the closeout marks `single`, or twenty of them
   chosen by you if there are more. For each, search the commit for the type, schema, table or
   function that defines the fact. Pass the row only if one definition is left and the others are
   deleted, not renamed, re-exported or commented out.
2. **Retired paths.** For each landed slice, or fifteen chosen by you, confirm that what it says
   it retired is absent from the commit and has no remaining caller.
3. **Tests.** For the same slices, confirm that every deleted test tested only the retired path,
   and that the behaviour listed as kept is exercised by a test that goes through the real path.
   A test that was weakened or skipped to get green fails the slice.
4. **Honest numbers.** The source and test deltas are reported separately and match the
   measurement in the inputs. Code moved to a place the count excludes is not a reduction.
5. **No preparatory work counted as done.** Any new interface, type or module the closeout counts
   as progress must name what it replaced, and that thing must be gone.

## Verdict

Pass only if every row and slice you checked holds, and section 3 of the closeout lists the
slices that did not land rather than hiding them. One `single` row with two live definitions is
a fail.

In your answer list each row and slice you checked, the search you ran and what you found. If you
fail it, name the exact definitions or callers that remain. Do not fail it for missing the
owner's line bar: that is a separate criterion, and a smaller honest cut can still pass here.
