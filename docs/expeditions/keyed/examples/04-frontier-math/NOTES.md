# API gaps still open in this example

Nothing in `api/expedition.d.ts` was changed. Each item says what the case needed and what the
plan does instead.

1. **A checkout cannot carry a read allowlist.** The Astra packet gives the builder (`L01`) one
   candidate, the minimal problem and the implementation contract, and keeps the attempt ledger
   and prior architecture hidden through the first hostile judgment. A fence (step or per-call)
   limits what a step may change; nothing limits what a step with a checkout may read, and
   `.reads(...)` is documented as "paths the step may read without a checkout". So `build` and
   `claim` can open the graveyard. Written instead: the two blind discovery steps have no tree and
   a two- or three-file `.reads` allowlist (enforced), and the `build` brief forbids reading prior
   work (advisory). Needed: a read grant that also applies inside a checkout.

2. **A review judge's grant is not expressible.** `review(rubric, by)` names who judges, not what
   the judge may read. The `math-red-team` judge must see only the answer and the author's
   allowlist; the `matched-error` judge must see frozen source and receipts and not the author's
   conversation or the prior-work ledger. Written instead: both rubric briefs state the limit in
   prose. Needed: `review(rubric, by, { reads })`, or the rule that a judge inherits exactly the
   judged step's grant plus its output.

3. **`contract.rules` are appended to every brief, including blind ones.** There is no way to
   exempt a step. The rules in this contract are therefore written to name no project
   architecture. A rule such as "do not retry the modal-Schur route" could not be an owner rule
   here without contaminating discovery.

4. **A review judge cannot return a typed verdict.** The packet's judge returns
   `SURVIVES | REVISE | KILL`. A `review` judge gives pass or fail plus `why`. Written instead:
   `SURVIVES` is the pass; `REVISE` and `KILL` are both `failed` (and both write a `reject` row),
   told apart only in the prose of `why`. The plan does not branch on the difference.

## A choice, not a gap

The `lineage` step reads the ledger and returns only a family name, which the plan passes to the
host as `tests` and to no other call. This departs from the packet's lean firewall in one way: the
host may refuse a build for a rejected family before the first hostile judgment, where the packet
would have let it run.
