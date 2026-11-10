# Rubric: does the record say exactly what the measurements say?

You are reviewing the results page and the new `KEY_LEARNINGS.md` rows. You did not write them,
and you did not build or benchmark any candidate. Assume the author wants the result to look good.

Open the reports the page cites. Check each of these:

1. **Every number traces.** Each speedup, error ratio and dollar figure on the page appears in a
   cited report, for the stated commit and device. Quote the report field next to each one.
2. **Matched error.** For the candidate called the result, the error ratio is at or below 1.0 on
   every frozen case in the audit report, not only in aggregate. If one case is above 1.0, fail.
3. **Paired and complete.** The audit is ABBA with six blocks on one named device, and its cost
   includes setup, compile, readback and output. A single timing, or timing of the evolution
   loop alone, fails.
4. **The protocol did not move.** The cases, metric and baseline commit in the report match
   `benchmarks/speed_search_v1/protocol.json` at the launch commit.
5. **The rejects are all there.** Every idea in the learning log has a row in the table and, if
   rejected, a graveyard row. A missing reject fails the review as surely as a wrong number.
6. **No promotion.** The page says "candidate". `matchedErrorSpeedup` is not set. Nothing claims
   the result holds on a device or case that was not measured.

Pass only if all six hold. If no candidate passed the audit, items 2 and 3 do not apply, and the
page must say "no candidate passed" in its first two lines.

In your answer, list each number you checked and where you found it. If you fail the page, name
the line and the report field that disagree.
