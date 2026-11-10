# API gaps still open

Nothing in `api/expedition.d.ts` was changed. Each item says what the case needed and what the
plan does instead.

1. **One judge per step.** A slice has four real checks plus the gate. `judged()` takes one judge.
   *Instead:* one `check` whose command chains them with `&&`. The log then records one pass or
   fail, not which check failed; the worker's report has to say.

2. **A baseline that is not a commit.** The screenshot baseline is a directory under ignored
   `output/` on the host. A `command` step's result is a `CommandReport`, so the plan cannot hand
   the baseline to a later step or to `done` as a `Ref`.
   *Instead:* the path `output/deslop/base` is repeated as a literal in the plan and the contract.
