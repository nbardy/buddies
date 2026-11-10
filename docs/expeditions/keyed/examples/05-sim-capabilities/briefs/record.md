# Record: the matrix as it now stands

Your inputs hold the baseline score of every cell, the repair commits that closed a row, the
final matrix scored on the integrated commit, and the learning log. You are working on top of the
integrated commit. Write the tracked record. A reviewer on another model will check every cell
you write against the reports.

## Write

1. `goals/2026-11-10_capability_matrix.md`:
   - the matrix: rows R6, R7, R9 against engines E and A. Each cell has the measured error, the
     gate, PASS or FAIL, the commit, the device and the dollars, before and after;
   - for each Engine E row that is still failing: how many paid strikes it used, a link to its
     failure-class page, and the one decision the owner has to make to go further;
   - any row that passed alone and fails on the integrated commit, named as an interference
     between two repairs;
   - the total cost of the run, including failed repairs.
2. In `goals/2026-10-12_three_engine_goals.md`, add one dated line at the top pointing to the new
   file. Do not edit its status table; that table is the 2026-10-12 record.
3. `KEY_LEARNINGS.md`: one dated entry per diagnosed mechanism, with what was predicted and what
   was measured. A repair whose paid run failed goes in the graveyard table with its number.
4. Each `agent_notes/2026-11-10_capabilities/*_FAILURE_CLASS.md` page gets a final "Outcome"
   section: the replay result, the paid result, and whether the diagnosis held.

## Rules

- Copy numbers from the reports. A cell with no report is "not measured", not a guess.
- A cell is PASS only if the final matrix run on the integrated commit says so. A row that passed
  on its own repair commit and was not re-scored is "passed alone", which is a different word.
- Engine A was measured and not repaired. Say that in one line; do not describe it as behind.
- Do not write "working" for Engine E unless all three rows pass. Do not change any claim flag.
- Do not touch engine source, the gates or the scoring tools.

Stop when the files are committed.
