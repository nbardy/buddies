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
