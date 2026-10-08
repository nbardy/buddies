# Turn lifecycle: reasons behind the server core

Code keeps a 1–3 line reason comment and the guard's name at each site
(docs/patterns.md#fix-guards). The longer story lives here, keyed by the anchor
the comment cites.

## one-terminal-path

`executeCommand().completed` describes child-process termination, not consumption
of the normalized event stream, and session persistence is asynchronous. Releasing
ownership before the event consumer drains could start the next queued turn while
text/session/turn.complete events from this one were still being applied. One
joined terminal path (`TurnRunner.follow`: `await eventConsumption` then `settle`)
is simpler than making every handler replay-safe.

The same rule covers failures that happen before any child exists: a synchronous
spawn throw (`TurnRunner.start`) and a configuration preflight refusal
(`Conversation.refusePreflight`) have no later completion event, so each
terminalises the attempt and emits `buddy-turn-failed` at the single point that
owns the error. An automation subscribes to that event before `sendMessage()`, so
its `runTurn` promise never waits for its outer timeout. History:
`agent_notes/2026-08-24_automation-execution-ownership-design.md` (invariant I8).
Guards: `provider completion waits for the normalized event stream and session
persistence`, `event-stream failure after turn.complete fails automation after
joined drain`.

## execution-adoption

A turn outlives the backend that started it. agent-cli runs every provider under a
detached `sh` wrapper whose stdout/stderr go to FILES in a journal directory
(`vendor/agent-cli-tool/src/journal.ts`), never to pipes: a piped child died of
SIGPIPE soon after its backend, so every backend death killed every turn (14 and 10
orphaned runs on 2026-09-30). The server adds `owner.json` (conversation, attempt,
the user row, the policy's run lease and grant; `server/src/turns/executions.ts`)
before spawn.

Every turn is READ from its journal, including one this backend spawned, so a
replacement backend adopts a running turn by following the same directory from
byte 0 through the same fold (`TurnRunner.follow`). Replaying into an empty overlay
rebuilds exactly what a never-restarted backend would hold. The overlay's user row
keeps its original text and time, so `mergeSessionMessages` pairs it with the
native transcript as it did live.

Boot order is the correctness argument (`server.ts`):
1. Scan the journals.
2. `turnAttemptJournal.initialize(adopting)` leaves adopted attempts open.
3. Conversations load and adopt (`lifecycle/adopt-executions.ts`).
4. `buddyRunner.start(adopted)` recovers every other run and keeps these.

Adoption precedes any claim, so an adopted conversation is busy and nothing can
start a second writer on its session. That second writer is the 2026-09-30 "already
has an active writer" failure.

- The grant is re-registered unchanged, and the Buddy MCP endpoint listens on its
  last port (`buddy-mcp.json`), so the CLI's configured tools keep working.
- A run's deadline is armed by the policy from an absolute time, so an adopting
  backend re-arms the same deadline.
- The journal is removed only after the drain settles. A re-adopted spent journal
  settles again, and the crate lease (`settle_run`) rejects that second settle.
- Explicit Stop still kills the group and revokes the grant.
- A group SIGKILLed from outside leaves no `exit.json` and completes `lost`, never
  success.

Design and history: `agent_notes/2026-09-30_execution-adoption-design.md`.
Guards: `server/test/execution-adoption.test.ts` (real backend SIGKILLed mid-turn,
replaced on the same stores), `vendor/agent-cli-tool/test/journal.test.ts`.

## early-turn-complete

A timeout or stop seals the stream: later provider events are dropped so they
cannot resurrect or complete the turn twice. A normal `turn.complete` does NOT
seal. On resume Claude can emit a result for drained task-notifications before
the prompt's own answer, and that answer must still be recorded (493c1c7).
Guard: conversation-runtime.test.ts "an early turn.complete does not drop …".

## one-request-shape

Every harness gets one `ExecuteCommandRequest`. Effort is a pass-through string:
configuration validation rejects levels the provider does not accept, and
agent-cli maps it to a flag only for harnesses that take one (execute.ts). The
cast covers only agent-cli's `reasoningEffort?: never` typing on the rest. It
replaced three identical per-provider branches (T08 S2). Guard: `every harness
receives its resolved effort in one request shape`.

## provider-usage

`usage` events are provider-counted truth for the request that just completed.
agent-cli already canonicalised per-harness conventions and excluded Claude's
turn-aggregate `result` usage and its sub-agent measurements, so the server takes
them verbatim; re-deriving would reintroduce double counting. Last write wins
within a turn (tool loops issue several requests; the latest is the live context
size). It can go down when the provider compacts; that is the signal.

The value is flushed once per turn, not per event: each write is a CAS round trip
on the config record. It is filed under the session settled at drain, so a
mid-turn rotation records usage against the session that holds that context. A
failed write is logged and never fails the turn. A session reset clears it: a new
session is an empty context.

## chat-fork

Chat "Fork" is a soft handoff: `resumedFromConversationId` is UI lineage and the
context lives in the draft / first user message, so changing provider before the
first send must still work. The first send upgrades to provider-session
inheritance only when the source has the same provider, the harness can fork
(`providerSupportsFork`) and the memory generations match. Anything else stays a
soft handoff and never rejects the send. When inheritance ran, first-turn
briefing / pasted-context prefixes are skipped: the CLI already has the source
transcript. Bug 2026-08-20: muse → muse died with `Harness "muse" does not
support fork.` because only the same-provider branch reached prepareSession.
Guard: `same-provider fork on a fork-incapable harness falls back to string
handoff`.

## session-relative-prompt

A seat's wording depends on whether the provider session resumes, and that is
decided at admission (`sendAdmittedMessage`): a Buddy turn may first wait for a
run slot, and a changed Buddy audience rotates the session. Asking first and
sending one prompt later leaves a window for the decision to flip, so callers
hand over both wordings (`SessionRelativePrompt`). The runner's `--resume` and
the chosen wording come from the same `resumesProviderSession` decision.

## preflight

Configuration is resolved against the catalog immediately before any message or
queue mutation (catalog changes can move defaults without changing durable
intent). The policy's preflight is an admission rule, not a process failure:
checking it before spawn keeps a queued message retryable and prevents a
synchronous spawn throw from leaving the queue head "sending".

## provider-progress

Three independent clocks stay in `TurnWatchdog`: bridge liveness (2 min), provider progress
(60 min by default, `CWV_TURN_PROVIDER_IDLE_TIMEOUT_MS`), and an optional absolute budget.
Child stream/task/subagent events reset provider progress just like parent events. Typed native
session advancement does too; a timer-only wrapper heartbeat resets only bridge liveness and
renews the Buddy lease. Background work has no default absolute deadline (dc299ec); foreground
Buddy deadlines remain explicit and leases never become deadlines.

Successor 2026-10-08: removed `background-wait.ts`, which let an old Claude background launch
buy 13 hours of silence regardless of whether a child was progressing. Only observed progress
resets the one idle clock now. A completely silent healthy tool/child exceeding 60 minutes is
indistinguishable from a hang; retain the established allowance rather than guess a shorter N.
Revisit with measured healthy silence or a typed child-progress signal.

Expiry persists `stopping(timeout(provider_idle_timeout))` before revoking the grant/signalling.
The joined process/event drain settles the attempt and run, releases the slot and conversation,
and removes the journal after settle. Run settlement preserves `provider_idle_timeout` instead
of flattening it to `execution_failed`; it is distinct from `max_runtime_timeout` and `user_stop`.
The event-loop stall monitor stays wired. Guard: `run-lease.test.ts` “no-progress ends a silent
background turn and frees its seat while child streams outlive N”.

A watchdog cannot fire while its backend is absent/frozen. The reported run_01a1185c's 6.5-hour
interval contained no old-boot heartbeat or progress; adoption drained a resume failure within
115 ms. That interval is unsettled duration, not proven live provider execution. Diagnosis and
scoped API evidence: `agent_notes/2026-10-08_hung-turn-liveness.md`. Adoption replays with a fresh
idle observation window; elapsed downtime alone never licenses killing a live turn.

## background-idle

A running turn has one in-memory activity beside its persisted phase (`turns/background-work.ts`
`TurnActivity`): `working`, or `background`. In `background` the model's turn has ended, and the
harness process is alive only for background jobs it launched (Workflow, background Agent or
Bash). It is not a phase: the turn still holds its grant, the provider-progress watchdog above
still ends a silent one with `provider_idle_timeout`, and nothing persists. A backend exit drops
the held hook request, claude's hook fails open, and claude waits on its jobs as before, so there is
nothing to adopt.

Why (task_01a11aa8, 2026-10-08): Game Designer's model ended its turn at 07:09:56 after launching a
background Workflow. The process then lived 29.5 min with zero tool calls, so tool-boundary
steering could not fire, and the owner's 07:14 and 07:20 posts queued behind "replying…".

Mechanism, per harness (`buddies/harness-steering.ts` `IdleDelivery`):
- claude, `stop-hook-hold`: claude runs its Stop hook as soon as the model ends a turn, passing the
  in-flight `background_tasks`, and blocks while the hook runs. The hook POSTs to the Buddy
  endpoint's `/hooks/event` (the old `/hooks/stop` URL remains an alias). If no background job is running, it returns at once. Otherwise
  `holdStoppedTurn` (`buddies/mcp.ts`) enters `background` and holds. On the first owner post in
  the thread it takes the unread page (marked read, so the queued delivery is fenced `consumed`).
  It then answers `decision: block` with the "While you were working…" text, and claude continues
  the SAME process. If the jobs' `task.finished` events arrive first (they stream live during the
  hold), it releases with no decision, and claude handles the job's notice as it always did.
- codex, gemini, opencode, cursor, muse, `waits-visibly`: no hold is wired. The post waits as a
  queued delivery; its status names the next tool boundary or the harness limitation.

The status line maps the activity to the channel response state: `background` reads "running
background work…", never "replying" or "queued at the run limit". Guards:
`idle-background-delivery.test.ts` (real backend, fake `claude -p`) and the opt-in
`buddies-v2` "real CLI claude: an owner post reaches a model idle on its background job"
(`UNLEASHD_REAL_IDLE_BACKGROUND=1`). Probes and evidence:
`agent_notes/2026-10-08_idle-background-delivery.md`.


## live-delivery

Successor 2026-10-08, task_01a11af2: execution 29c47118 was born before the Stop hook existed.
Backend adoption preserves argv, so upgrading the backend could not reach its idle parent. Its
27 native sub-agents received the owner post 35 times from a per-agent in-memory set, repeated
on restart. New Claude turns register PostToolUse, PostToolUseFailure, Stop and SubagentStop at
one stable `/hooks/event` endpoint; unused events return empty. Codex registers its supported
PostToolUse event. Behaviour is dispatched by the current server, with old URLs retained as aliases.
The exact hook set is recorded on the grant and survives adoption. Journals without it are typed
`unrecorded`: their processes retain their original hooks until they end. No backend update can
retrofit a missing Stop hook into an already-running process.

The parent's existing collector takes the post at its tool boundary or Claude idle hold. Native
sub-agents share one durable `run.noticed_ord`, so at most one receives each owner's post per run,
without advancing the parent read cursor or consuming its delivery. This notice is at-most-once:
a failed hook response can lose the advisory notice; the parent still receives the durable post.
Request-addressed messages keep their existing response/consumed fence and at-least-once outage
semantics. No second delivery transport or child-to-parent relay is introduced.

Queued thread responses include the live seat's reach: next step, Buddy-tool-only harness,
unrecorded hooks, picked model requiring a new turn, or no live seat here. Only actual capped
admission says “at the run limit (n/max)”. Older backend responses without reach use a neutral
“answers after its current turn” fallback. Explicit picks are never steered into the old model.
Full waiting-path table and restart recommendation: `agent_notes/2026-10-08_waiting-paths.md`.
Guards: `idle-background-delivery.test.ts` (real temp backend, idle hold plus fan-out/adoption),
crate `a_sub_agent_notice_shows_an_owner_post_once_without_fencing_its_delivery`, and rendered
`channel-response-status.test.tsx`. Line ceiling grows 97 lines after removing the superseded
WeakMap and merging hook handlers; the growth records durable capability/cursor state and honest
status projection, with no new controller.
