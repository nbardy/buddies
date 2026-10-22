# Reviewed Oompa portfolio progression

The reported blocker was fixed raw-config/task scope stranding an authorized
controller after its first children completed. Source commit
`5bdfd5b79da5eeec56150171c910083270d5d176` replaces that restriction only for an
explicit owner-delegated canonical portfolio. It reuses canonical Tasks, existing
Buddy review requests and the existing host execution journal; it adds no Buddy
DB mutation path or separate task/scheduler ledger.

The operating/API owner is
[AUTOMATION_OWNERSHIP.md](../product/buddies/AUTOMATION_OWNERSHIP.md#reviewed-portfolio-progression--october-21-2026).
New owner launch accepts portfolio `{rootTaskIds,ownerIds,reviewerIds}`.
The scheduled launch Buddy can create scoped `prerequisite` tasks, request a real
independent review via ordinary DM request, and `amend` a drained host after the
reviewer records its OWN canonical task evidence. Review evidence binds exact
base config SHA, proposed config SHA and clean source commit. Renewal explicitly
names `priorRunId`, `amendmentId` and the returned immutable configPath.

Scopes use canonical ancestry, current approved ownership and task revisions.
No executed/held oracle can be repinned; a distinct reviewed source/consumer task
is required. Completed children retain historical source receipts. Existing
acceptance dependencies, external/human gates, model/spend/task budgets and
reconcile_on_rejection=true cannot be weakened. Identical prerequisite definitions
are idempotent across duplicate wakes. Unchanged exhausted graph fingerprints
cannot trigger another automatic launch without meaningful reconciliation.

An owner-authored `launch.resumeRunId` is a NEW explicit window, distinct from
ordinary `priorRunId` renewal. It records prior run identity and supplies matching
host-only owner_window configuration/environment. The old authorization remains
expired; historical worker deadlines, attempts, sessions and held source are not
rewritten by the host. Oompa records the authorized deadline history. Stop
revocation remains effective for every host under the same authorization.

## Committed verification

Temporary `git archive` sources of Buddies `5bdfd5b` and Oompa
`d05e990742d1f005c89ccfccd0b35dd05042a968` passed the complete
`server/test/oompa-mcp.test.ts` suite: **12/12**, **131 seconds**.
`OOMPA_TEST_SOURCE_ROOT` and `OOMPA_TEST_PORTFOLIO_DRIVER` explicitly enabled the
actual Babashka adapter/worker/consumer contract; those archives were deleted.

The portfolio case starts with canonical three-DONE-child records and a persisted
exhausted/held execution fixture. The scheduled Lead creates new canonical
prerequisite/review tasks through MCP. After the original owner turn token is
revoked, the ordinary reviewer Buddy receives a real DM request, records its OWN
canonical review task through MCP and replies. The Lead's self-review task write
is refused. The Lead then amends and renews through MCP. The real selected worker
audits the new graph and executes the new source-pinned consumer through the real
host acceptance gate exactly once. Its task reaches canonical done; accepted
count progresses from three to four. The retained blocked task's attempt 9,
source workspace, native session and attempt history remain intact. Provider,
reviewer computation and Cambium lifecycle are bounded fixture doubles; canonical
HTTP, graph/source checks, task CAS and subprocess validator are real.

The suite also verifies foreign scope/owner/peer rejection, stale review/source,
held-source repin refusal, original stop/expiry/revocation controls, unchanged
fingerprint suppression, and an expired old host followed by a fresh owner-only
window. No live run was launched, stopped, drained or amended by this worker.
A guaranteed-missing-run amendment probe confirmed the live schema was hotloaded
without mutating any run or task. The existing turn's tool description snapshot
can remain cached; the committed MCP description documents the new workflow.

Working-tree server/test typecheck, owned-file Biome and diff checks passed.
Archived runtime checks reused installed package/native dependencies. A clean
whole-repository rebuild was not claimed; foreign provider/catalog changes were
left unstaged, with the previously recorded static baseline limitation unchanged.

## October 22 source-only owner scale repair

Blocker: reviewed beta scale configuration is refused by the intentional frozen
harness guard, including from owner turns. Target: an explicit owner-only scale
exception in existing amendment admission; scheduled callers retain the freeze.
Expected improvement: admit reviewed allocation changes without creating a new
automation window. Cheapest check: real temporary-store portfolio MCP boundary.
Pass: owner admission and same-horizon renewal; scheduled and budget/graph/pin
weakening refused. Stop: broad authorization redesign or activation needed.
Claim boundary: source software controls only, no beta or physics acceptance.

`amend.ownerScale:true` requires current owner role and owner principal before
idempotent receipt lookup. Allocation is bounded to six workers, one GPU worker,
one reviewer; models/prompts pass through and task assignments stay within the
admitted graph. Remaining worker/reviewer controls, global/task budgets,
independent review, history and acceptance dependencies retain their owners.
Normal scheduled renewal may consume the owner-admitted immutable receipt under
the original horizon. No live run, DB, provider, deployment or server activation
was performed. Required owner action after supported source activation: invoke
ordinary reviewed `amend` with `ownerScale:true` from the launch Buddy's live
owner-authored turn, then use its returned amendment ID/config for normal renewal.

Verification: `pnpm exec tsx --test --test-name-pattern='portfolio MCP'
server/test/oompa-mcp.test.ts` passed 2/2 (ordinary and owner-scale variants,
30.4 s), through real MCP HTTP/core with temporary stores and fixture host.
Covered scheduled flag/unflagged/replayed receipt denial, owner admission,
original expiry/history preservation, worker/global budget refusal, GPU/count
caps, foreign task refusal, retained acceptance dependencies and held repin
refusal. `pnpm --filter @unleashd/server typecheck`, owned-file Biome and
`git diff --check` passed. No optional real Babashka portfolio driver was enabled;
this verifies software admission controls, not provider execution or beta outcomes.

## October 22 delegated scale envelope implementation brief

Blocker: a scheduled controller cannot admit a reviewed allocation change, so an
owner-requested six-worker beta run waited for another live owner turn. Target:
optional, strict owner-launch `scaleEnvelope` persisted with the automation grant;
delegated amendments can change only worker count/model/task assignment/GPU flag
and reviewer model within it. Expected improvement: reviewed bounded scaling
continues within the existing horizon. Cheapest check: real MCP temporary-store
portfolio boundary, including renewal and rejection cases. Pass: in-envelope
admission, specific cap/model/GPU refusals, unchanged frozen controls and review
binding; absent or renewal-supplied envelope refuses. Stop: any need to change
the existing amendment design or broaden authority. Claim boundary: source-only
authorization repair; no live beta execution or delivery acceptance.

Implemented on the existing Oompa owner journal and portfolio amendment path.
The strict launch field is
`scaleEnvelope:{maxWorkers:number,models:string[],maxGpuWorkers:number}`;
an owner must also give `automationSeconds` and `portfolio`. Renewal inherits the
exact envelope from `owner.json` and cannot submit one. With no envelope,
scheduled allocation changes still fail. With an envelope, the scheduled Buddy
can submit independently reviewed worker count/model/task_ids/GPU and reviewer
model changes within its limits. Full model strings include effort. Worker and
reviewer prompts, task/runtime/spend controls, budgets, dependencies, owners,
validator pins and original horizon retain their existing freezes. Existing
owner-only `amend.ownerScale` remains a separate explicit path.

Owner clarification: the envelope bounds agent count and subscription load,
including an explicit `maxWorkers:12`; model tokens are subscription-paid.
It does not authorize paid GPU/Modal dispatch. The worker-count refusal names
agent count/subscription load rather than treating it as a monetary limit.

Verification: `pnpm exec tsx --test server/test/oompa-mcp.test.ts` passed **15/15**
(173.5 s); after adding accepted-path frozen-field assertions, the changed
`portfolio MCP permits reviewed delegated scale only within the owner launch
envelope` case passed **1/1** (18.2 s). Both include real MCP HTTP boundaries,
temporary core stores, independent review evidence and fixture host; the new
case reloads the server before amendment and checks persisted/renewed envelope.
`pnpm --filter @unleashd/server typecheck`, both client TypeScript checks,
vendor agent-cli typecheck, owned-file Biome and `git diff --check` passed.
Repository `pnpm typecheck` stops before compilers at the already-dirty shared
tree line ceiling: 14,474 > 12,487 after the policy wording update (baseline
14,431 > 12,487); the ceiling file was untouched. Optional
real Babashka portfolio driver was not enabled. No server restart, live Oompa
run, deployment or external publication was performed.

After the subscription-load wording update, the delegated-scale MCP case passed
again **1/1** (25.6 s), owned-file Biome and `git diff --check` passed. The existing
checkout is `preserve/owner-20261010/live-source-base` (contains `ee1da2d`, divergent
from `main`); only the seven scoped files are included, with no branch switch.
