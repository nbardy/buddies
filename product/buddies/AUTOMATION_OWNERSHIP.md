# Automation execution ownership

Current contract · updated 2026-09-24

| Capability | Implementation |
|---|---|
| Run lifecycle, deadline, cancellation, capture | `server/src/buddies/scheduler.ts` |
| Provider-turn completion and transcript ownership | `runtime.ts`, `integration.ts`, conversation runtime |
| Private scoped tool authority | `control-server.ts`, `mcp-config.ts`, package run transactions |
| Credential-free run projection | Shared automation run schema, `public-automation-run.ts` |
| Original decision and review evidence | [Accepted design](../../agent_notes/2026-08-24_automation-execution-ownership-design.md) |

## Who may turn a schedule on

A Buddy turns on schedules for **itself** without an owner grant, from any
conversation including channel threads, and new self schedules start enabled
(owner decision 2026-09-24, #bugfixes). Two bounds stand in for the grant:
a self-enabled schedule fires at most once an hour, and a Buddy has at most 5
enabled schedules. A schedule over either bound is saved as a disabled draft
whose `enable` decision names the bound; the owner enables it from
`/buddies/:buddyId/automations` or grants `schedule.manage`, which lifts both
bounds. Scheduling **another** Buddy always needs `schedule.manage` to enable.
Each run keeps its own runtime limit. `SELF_SCHEDULE_LIMITS` and
`scheduleEnableDecision` in `server/src/buddies/operations.ts` are the rule;
the cron gap bound is `minimumAutomationGapSeconds` in `scheduler.ts`.

## Execution

One durable occurrence has one executor. Its run row and private current claim
token authorize work; a conversation is the transcript and does not extend that
authority. Terminal states are absorbing. Cancellation immediately revokes tools,
then waits for provider shutdown and event drain before releasing ownership.

Every operation checks executable status, the private claim token, unexpired
ownership, cancellation, and the immutable operation policy. Synchronous mutations
and their audit writes share that transaction. Server-dependent dispatch performs
its final authority check when binding and starting the child. Credentials never
appear in public JSON, prompts, or process arguments.

The runtime deadline begins before configuration and conversation creation and
covers every iteration. Enforced limits and metering coverage are documented in
[budgets and limits](BUDGETS_AND_LIMITS.md#implemented-behavior).
There is one active occurrence per automation. Manual runs do not race the
scheduled cursor; scheduled completion owns advancement. Invalid schedules fail
before persistence. Deleting a definition archives it and retains its run history.

Production queues independent Luna memory maintenance after each successful
Buddy turn; it does not spend another work iteration or revive a terminal claim.
The reviewer has its own two-minute maintenance deadline and memory-only
capability, retains the source operation restrictions, and cannot execute work,
send messages or edit soul. Its failures and partial memory writes are audited
separately from the work outcome. See [Buddy memory](PLANNING_MEMORY.md).
Standalone scheduler users without `memoryReviewAfterEachTurn` retain the legacy
closing capture turn, only within the original run's remaining iteration/runtime
limits and memory policy. Production enables that option to avoid duplicate capture.

Cooperative development reload stays available while admitted work drains. At an
idle boundary it pauses admissions, rechecks, and exits or resumes. It never
pretends process exit means event consumption finished. Explicit shutdown remains
bounded and can interrupt work. A hard crash is recovered as visible interruption,
not adoption or silent replay; retry creates a new occurrence. Active memory
review processes also count toward the drain. Waiting reviews remain durably
queued; in-flight interrupted reviews are not automatically replayed.

Generic message waiting runs within the same deadline and authority. A reply can
arrive after a sender stopped waiting, but it cannot revive a cancelled, failed,
or completed run. Approval purpose strings do not grant an executor additional
permissions.

Relevant boundary tests cover cancellation during creation, stale tokens,
concurrent claims, delayed event drain, archival history, and MCP callbacks through
the authenticated scoped control path. The long accepted design remains evidence;
this file is the living entry point.

## Owner-delegated overnight Oompa control — October 20, 2026

An owner-authored `oompa` launch may include `automationSeconds` (positive,
at most 43,200). This explicitly grants the configured launch Buddy a fixed
controller horizon for the same workspace, registered source worktree, approved
tasks/owners and exact configuration, including validator pins. The immutable
authorization lives in the existing Oompa execution's `owner.json`; there is no
new task ledger or owner authority on the scheduled Buddy turn. `expiresAt` is
the parent host's controller horizon. `originalExpiresAt` records the original
`maxSeconds` deadline separately. Task configuration and existing task deadlines
are unchanged; configure a new desired task horizon on a new owner launch.

Within that authorization, ordinary scheduled turns of the same Buddy may use
`continue` for a task/revision/clean-commit/source-pinned diagnostic of at most
600 seconds, or `launch` with `priorRunId` naming the latest drained host and the
same launch coordinates/configuration. Renewal derives `resume_swarm_id` from
the exact prior host receipt and resumes Oompa's existing execution state. It
retains attempts, native sessions, held workspaces and original task deadlines;
it does not grant a new task budget. Each prior host has at most one successor,
and every parent host remains bounded by the original controller horizon.
The existing Oompa loop selects the next eligible implementation task from the
approved configuration; this host delegation never changes the task allowlist.

Only a fresh owner launch may grant a new policy/horizon. Sibling Buddies,
foreign workspaces, run-owned task children, changed task ownership, altered
configuration or validator pins and expired authorizations are rejected.
Explicit `stop` on any host in the chain durably revokes its root authorization
before signaling the processes; backend reload cannot restore it. Run-owned
subagent tools retain their task-limited acceptance surface and cannot control
the host. Boundary guard: `server/test/oompa-mcp.test.ts`.

`drain` with `runId` is a separate, asynchronous controller operation. It saves
its intent in the same execution journal and reuses the worker continuation
handshake to wait for all current task/validator work to reach acknowledged idle
checkpoints. Only then does the host cancel and revoke its own execution grant;
the automation remains valid for `priorRunId` renewal with updated harness code.
Reload recovers both the pending request and its control projection. An explicit
Stop still revokes the whole delegation, and the fixed horizon still ends work
at expiry. Drain never signals an active implementation or validator.

`requeue` (`runId`, `taskId`, exact `baseRevision`, bounded `reason`, idempotency
`key`) is a narrow controller recovery action for one known harness failure:
`Framework prompt not found: config/prompts/_framework/reviewer.md`. It requires
the latest fully drained host, active same-launch-Buddy delegation, one exact
persisted `execution-blocked` hold, retained attempt/session/source history,
original unexpired task deadline and an unpaused canonical `in_progress` task
at the held claim revision with its approved owner. Its owner-delegated CAS
changes only `status=open` and explanatory `nextAction`; the execution journal
records the proof hash and result. A crash after CAS replays the same core key.
It never edits held state, criteria, owner, session, attempts or workspace. Model
blocks (including held Force physics), canonical blocked/review/done tasks,
changed owners/revisions/pins, unknown errors and run-owned children are refused.
After renewal the existing Oompa selector reclaims the higher task revision and
reuses its held execution history. This is not a general unblock permission.
