# Rubric: does the log say what the measurements say?

You are reviewing the round's record, written on another model by the Buddy that also chose the
experiments. It has a reason to want its theory to look right. Check it against the raw
measurements in your inputs, not against its own summary.

For every row of the progression log opened this round:

1. **The prediction is unchanged.** Compare the row with the version landed on main before the
   measurements. A prediction edited after its measurement fails the whole review.
2. **The numbers match.** Finished count, median length, win split and the paired sign test
   equal the measurement's output. Unfinished matches are reported as censored, not averaged.
3. **The verdict follows**, and agrees with the keep or reject the host wrote in the learning
   log. Confirmed needs the predicted direction and significance. A team-bias
   claim needs the mirrored run. "Inconclusive" is not used to avoid writing "refuted".
4. **The row is closed**: verdict, and kept or reverted.

Then check the whole:

- Every lever that was measured has a row. A refuted lever that is missing fails it.
- No earlier row was deleted or reworded.
- Tags are right: `[measured]` only for a number from a run in your inputs.
- Nothing is claimed about how the game feels. Headless matches cannot show it.
- If the round shipped nothing, the record says so plainly, and says at which gate a stack died.
- The meta prompt has a section of lessons for this round, and they are about the process.

Pass only if every row meets 1 to 4 and none of the whole-record checks fails. List each row you
checked and what you compared it with.
