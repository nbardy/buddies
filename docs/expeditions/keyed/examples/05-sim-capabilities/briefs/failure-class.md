# Rubric: does this page localise the failure?

You are reviewing a one-page failure-class document for one row on one engine. A repair will be
built from it, and that repair gets at most two paid runs. You did not write the page. Judge
whether the diagnosis follows from the evidence, not whether the proposed repair sounds sensible.

Open the saved failures and the baseline report the page cites. Check:

1. **The failure is stated as measured.** The number, the gate, the commit and the case match the
   baseline report in the inputs and `benchmarks/capability_matrix_v1/matrix.json`.
2. **It is localised by evidence.** The page says which term carries the error and shows data
   that rules out the alternatives it lists (flow, boundary, coupling, measurement). "Most
   likely" with no discriminating evidence fails.
3. **It describes a class.** The page covers more than the one symptom, and the repair it names
   addresses the class. A repair that would only move the fault to the next cell or particle fails.
4. **History is used.** If this is a second round, the page explains why the first repair's
   result is consistent with the new diagnosis. A page that ignores a failed attempt fails.
5. **It predicts.** There is a numeric prediction for the frozen case after the repair, and a
   stated result that would prove the diagnosis wrong.
6. **Nothing frozen moves.** The page does not propose changing the window, the reference, the
   gate or a tolerance below the typed minimum.

Pass only if all six hold. A page that honestly says "the evidence cannot separate these two
mechanisms, and this local replay would" passes item 2 if the replay it names would separate them.

In your answer, quote the evidence you checked for item 2. If you fail the page, say which
alternative mechanism it did not rule out.
