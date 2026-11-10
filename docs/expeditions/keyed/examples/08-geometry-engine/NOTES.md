# API gaps still open in this example

Nothing in `api/expedition.d.ts` was changed. Each item says what the case needed and what the
plan does instead.

1. **A `done` criterion cannot point at a logged call's outcome.** The natural done criterion is
   the suite itself under the guard. A criterion can now reserve pools (`needs: [replay]`), but
   `replay` is `uses: 1` and the plan's `replay` step has already consumed it, so the `done` check
   and the `land` re-check would be refused, or would be a second and third run of an evaluation
   the owner authorized once. Kept instead: `done` checks a committed receipt with
   `tools/geometry/verify_receipt.py` (not yet real), which reads the result of the one replay and
   runs nothing. Needed: a criterion of the form "the logged outcome of call `replay`, on this
   commit".

2. **The `guard` pool gates host calls only.** A worker with a checkout and a shell can run a test
   inside its own turn without reserving the machine-wide guard slot or the replay. Written
   instead: a contract rule and the `implement` brief forbid running tests; the host's `probe`
   command is the only execution. That is advisory.

3. **A review judge's reads are not expressible.** The `preserved-geometry` reviewer must compare
   the committed receipt with the host's stored output of the `replay` call. `review(rubric, by)`
   cannot pass it that output. Written instead: the `receipt` step is given `replayed.value` in
   its `reads`, and the rubric assumes a judge sees the judged call's inputs.

4. **`probe` runs a file the plan's first round creates.** Launch requires that every check can
   run on the base. Whether that applies to a command step is not stated. If it does,
   `derived.test.ts` has to be committed empty before launch.
