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

## Retired: Buddy Oompa control — November 3, 2026

Buddies used to launch, amend, renew and accept Oompa runs through an `oompa`
MCP tool backed by a server-side host (owner-delegated overnight control, Oct 20;
reviewed portfolio progression, Oct 21). The owner retired that host on
2026-11-03 to focus on Expeditions (`server/src/expeditions/`), which never used
it. The tool is gone from every role's tool list; a call from a turn adopted
across the upgrade answers `[retired] oompa: …` (`RETIRED_TOOLS` in
`server/src/buddies/mcp.ts`). Old `~/.agent-viewer/oompa-executions/` journals
are left on disk and never read. The design as built is in the history before
the retirement commit (`server/src/buddies/oompa*.ts`,
`server/test/oompa-mcp.test.ts`). The swarm/oompa viewer is separate and stays.
