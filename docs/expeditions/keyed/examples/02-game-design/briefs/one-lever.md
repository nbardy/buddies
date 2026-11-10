# Rubric: is this diff exactly one lever?

You are reviewing a change written on another model. It claims to implement one balance lever.
The measurement that follows is only worth anything if that is true.

Read the lever's stated idea and its prediction row in section 11 of the theory doc. Then read
the diff, and compare the variant map with `reports/tidewar-balance/baseline/map.json` field by
field.

Pass only if all of these hold:

1. **One family.** The variant map differs from the baseline only in the knobs of the stated
   lever. Any other differing field fails it, however small.
2. **Stated setting.** The knob values are the ones the idea and the prediction row state.
3. **Off by default.** Any new knob in `pacing.rs` ships off, and the shipped map
   `keel/content/tidewar-map.json` is untouched. With the knob off, no code path changes.
4. **No owner ruling bent.** Nothing changes when or how the flagship shield opens.
5. **Nothing else.** No edit to the AI, the tests, the match runner, the theory doc or another
   variant.
6. **A prediction exists** for this lever, written before this change.

Do not judge whether the lever is a good idea or will work. A lever you expect to fail still
passes if it is clean. In your answer, list the differing map fields and the files changed, and
for a fail, name the line that breaks which rule.
