# Record: the result, and the graveyard rows

The search is over. Your inputs hold the whole learning log and, if a candidate passed the long
audit, its commit and the audit report. Write the tracked record and commit it. A reviewer on
another model will check every number you write against the reports.

There are two cases. Look at your inputs to see which one you are in.

**A candidate passed the audit.** You are working on top of its commit.
**Nothing passed.** You are working on the baseline. This is a valid result; write it as one.

## Write

1. `benchmarks/speed_search_v1/results/2026-11-10.md`, one page:
   - the outcome in two lines: the candidate, its speedup and error ratio at matched error, the
     device, the number of ABBA blocks, the complete cost in dollars; or "no candidate passed";
   - a table of every idea tried: id, family, prediction, measured, verdict, commit;
   - what the run cost in total, including rejected candidates and the benchmark repair;
   - what the audit does not show: other devices, other cases, other grid sizes.
2. `KEY_LEARNINGS.md`: one new row in the graveyard for each rejected idea, in the table's
   existing format, with the measured ratio and the report it comes from. If a candidate passed,
   one entry under "Open hypotheses" naming it as a measured candidate.

## Rules

- Copy numbers from the reports. Do not round a 1.13 up, and do not average runs from two devices.
- Do not edit an existing graveyard row. Add rows.
- Do not set `matchedErrorSpeedup=true` anywhere, and do not move anything to `KEY_INSIGHTS.md`.
  The owner promotes a claim after reading your page. Until then the word is "candidate".
- If two ideas in one family both failed, say what they have in common in one line. That line is
  what stops the next run repeating them.
- Do not write agent notes, and do not touch the engine source or the benchmark.

Stop when both files are committed.
