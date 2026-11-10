# API gaps still open

Nothing in `api/expedition.d.ts` was changed. Each item says what the case needed and what the
plan does instead.

1. **Reading the owner criterion from the plan.** The case needs "the owner did not ratify, here
   is the open disagreement" as a `gap`. The contract's `owner` criterion is evaluated by the host
   after the plan returns; the plan cannot see its outcome.
   *Instead:* the plan asks the owner itself (`x.ask(..., Ratify)`) before the retirement step
   and returns the gap if the answer is no. The contract still carries an owner criterion, on the
   whole package including the retirement plan. The owner is therefore asked twice, about two
   different things: the model, then the model plus how it replaces what runs.

2. **A failed critique means two things.** The plan treats `attack` returning `failed` (its
   reviewer found no real defect) as a clean round. `failed` is the only signal available, and it
   also covers a critic that found real defects and described them badly.
   *Instead:* the `real-defect` rubric tells the reviewer that failing the critique ends the
   rounds, and the owner's ratification question states how the last round ended.

3. **No mechanical ledger coverage.** Not an API gap: the API could express it as a `check` or a
   `command` returning counts. No such script exists in wave_sim, and coverage of a design row is
   a judgment, so it is a `review` on a third provider. The plan cannot read a coverage number.

4. **Judge independence for a Buddy.** `ledger` is produced by `buddy('document-model-lead')` and
   reviewed by a gemini seat. The plan cannot state the Buddy's provider, so independence is only
   known at the dry run.
