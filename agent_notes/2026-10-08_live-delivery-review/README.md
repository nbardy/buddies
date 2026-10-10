# Live delivery review — 2026-10-08

Task: `task_01a11a85-d085-7440-8f2b-8bedb004412d`. Request:
`post_01a11a86-1d25-736f-917c-70c7d494604f`. Reviewer: Buddies Development Lead,
Codex quota fallback. Diagnosis and recommendation only; no production implementation.

**Finding:** the recent repairs fix busy-seat errors and Buddy-tool catch-up, but do not
provide a general live-delivery boundary. Self-spawned workers also share the parent's
Buddy address and read cursor, so ordinary Mail cannot address both live conversations.
Adding two message tool names alone would leave both problems intact.

## Scope and evidence

Read CORE_DESIGN first. Initial memory named `4f16903`; actual HEAD during review was
`f1011d0b4a954a8bee82292ea212768565baa4b3` (concurrent updater commit, not a delivery change).
The first milestone's “main 4f16903” was stale; subsequent coordination corrected it.
Vendor HEAD: `7a41287033e3fade6bda202117f09ef3dca03bb2`; its catalog alone was dirty.
The main checkout has unrelated dirty client/catalog work, which this review did not edit.

- [source-evidence.json](source-evidence.json): 18 source hashes, historical commit references,
  and full preserved text of uncommitted decision sources. This is the historical citation,
  not a claim that their mutable filenames were committed.
- [native-evidence.json](native-evidence.json): exact owner posts and scoped run API results.
  No foreign-workspace access or live-store opening. The native run list is clipped: it
  does not establish that these are all active/failed runs.
- [reproduction.log](reproduction.log), [reproduction.json](reproduction.json): two fresh
  reproductions at 08:05Z through a real temp crate, HTTP MCP, runner and conversation runtime.
  Provider execution is fake. All four recorded delivery-source hashes stayed unchanged.
- [reproduce.mjs](reproduce.mjs), [cases.tsfrag](cases.tsfrag): runnable reproducer. From repo
  root: `node agent_notes/2026-10-08_live-delivery-review/reproduce.mjs`. It extracts helpers
  from the named commit, generates a temporary test beside the fixture, and deletes that file.
  Tests assert the *broken behavior* to establish the diagnosis, not successful repairs.

Fresh existing checks: five selected `buddies-v2` tests passed (08:02Z):
`new thread messages steer the live reply once, without a second run or busy failure`;
`a follow-up whose seat is busy on another thread waits, then runs, with no failure notice`;
`a follow-up waiting on a busy seat is consumed when the busy turn reads its thread`;
`a spawned worker is told to post progress notes and answer with evidence paths`;
`an answer the requester already read settles its return run with no model turn`.
This is a focused boundary check, not a full suite or live-CLI validation.

First probe run passed both assertions but left a fake turn's fetch racing endpoint teardown.
It needed termination of its own test process; see `reproduction-first-cleanup-failed.log`.
The reproducer now drains fake turns before closing its temp endpoint. The corrected run
completed normally, 2/2, exit 0. No Buddy worker was cancelled to run these tests.

## Root-cause map

| Failure | Evidence and distinction | Repair owner |
|---|---|---|
| Owner text remains outside active work | `mcp.ts` `callTool` appends `liveThreadPosts` only to successful Buddy MCP results. Native shell/file tools never enter that wrapper; failed Buddy calls also return before catch-up. | Steering Task `task_01a11a68` |
| Catch-up has only one active root | `liveThreadPosts` accepts only post/deliver inputs and reads their trigger root; schedule/chat parents and messages in another request thread are outside that hook. A general worker message cannot rely on this hook even with a distinct Buddy identity. | Shared collector proposal |
| Explicit picker change suppresses correction | Reproduction 1 sends the 3×3×3 correction with an explicit config while the turn is held; completed `doc_read` contains no steering; the delivery remains queued. `liveThreadPosts` returns early for any queued configured delivery in that root. | Steering Task |
| Self-worker cannot receive direction/questions | Reproduction 2 holds parent and worker concurrently. Both `post inform` calls succeed, neither creates a targeted delivery, neither next `doc_read` includes the message. `answers` still creates the final correlated return. Same identity is excluded by `fan_out` and `take_unread`. | Concrete proposal below; not implemented |
| Owner in a free conversation starves at cap | `WAITING_REASON_SQL` applies the Buddy cap to all runs; claim is FIFO among eligible rows. This is independent of active-turn steering. Actual Game Designer active count was **not measured** here. | Admission Task `task_01a11a6d` |
| “Queued at the run limit” misdiagnoses queues | `channels.ts` exposes only replying/queued; `channel-data.ts:657` labels every queued row “at the run limit.” The crate's typed waiting reason already distinguishes `conversation_busy`, `pool_full`, pause and delay. | Steering Task's diagnostic scope |
| Quota failure | Native API shows all three original repair attempts failed with `execution_failed` and “You've hit your session limit” around 07:37Z. Owner's 07:40Z delivery failed likewise, after it was admitted. Follow-up gates also hit quota. This is neither an admission wait nor missing injection. | Provider failure reporting/retry, not a new queue |
| No-progress hang | The 6.5 h Codex incident is reported by its Task, not independently reconstructed here. Existing `TurnWatchdog` already has bridge, provider-idle and max clocks; removing the max clock does **not** remove provider-idle. Need explain why that idle clock did not end this run. | Liveness Task `task_01a119c4` |
| Execution loss | “process group was killed without an exit record” is distinct from quota, silence and queueing. Adoption/kill attribution must retain its existing authority. Screenshot text proves the reported failure, not that the later turn is dead. | Existing execution-loss investigation |

The lead's earlier explanation that 30 agents occupied five Buddy slots was an inference and
was corrected in the source thread. Native subagents are not automatically Buddy run rows.
Raising the cap cannot inject into a busy turn. Restoring the one-hour wall-clock cap would
violate the accepted healthy-workers-keep-running direction.

## Historical before/after

| Commit/direction | Before → after | What it does not establish |
|---|---|---|
| October 6 delivery rebuild, A–K | Separate return/follow machinery → Mail posts plus `deliver`, Buddy/thread subscription and read fence. | That one Buddy/thread cursor can address two conversations of that Buddy. |
| October 7 owner successor; `5d75897` follow-up gate | Automated owner-chat envelopes → background branch; public/task seats remain unsubscribed unless explicitly followed. | Continuous mirroring of later owner-chat context into the branch. |
| `aa19d5a` | Same-thread collisions/queued messages → same-thread serialization and catch-up in completed Buddy tools. | Native-tool, failed-tool, or blocked-native-wait injection. |
| `4663353` | Unbound cross-root delivery claims a busy seat and fails → resolve seat, defer the unexecuted run with that conversation id, then wait. | Live direction to a worker or cap independence. Keep this repair. |
| `dc299ec` | Default 60-minute background deadline → no default absolute background cutoff. | Unlimited provider silence; provider-idle watchdog still exists. Keep the owner decision. |
| `e1164cf` merge of failure fan-out guard | Two failing subscribers can ping-pong `reply_failed` notices → those notices wake nobody. | All failure types retaining their provider-specific classification at the UI. |

These commits are ancestors of the reviewed main. The two new reproductions demonstrate
remaining gaps on their successor, not regressions proved against a pre-rebuild live installation.
No controlled historical real-CLI before/after run was available; “used to be great” is owner
experience, not a benchmark result this review can manufacture.

## Harness and native-agent boundary

| Harness | Current Unleashd transport | Proven ceiling / available candidate |
|---|---|---|
| Codex | Vendor `codex exec`, prompt stdin closes; journaled executor rejects open-pipe transport. | Buddy-tool wrapper only. Official app-server has `turn/steer` with `expectedTurnId`, no new turn and no model override. It is **not** the currently integrated transport. |
| Claude | `claude -p`, static prompt/MCP config, closed prompt stdin. | Buddy-tool wrapper only on reviewed main. Official `PostToolUse` / `PostToolUseFailure` support context beside tool results; prototype belongs to steering worker. Parent's synchronous Agent call must finish before its PostToolUse hook can run. Child hooks are not proof of parent resampling while blocked. |
| Cursor | Print mode with plugin MCP; stdin closed. | Buddy-tool wrapper only in current integration; any-tool support unproven. |
| Muse | `exec` with copied MCP config; stdin closed. | Buddy-tool wrapper only in current integration; any-tool support unproven. |
| Gemini | `-p`, stdin closed; harness declares `mcpCapability: 'none'`. | Cannot currently supply required Buddy MCP. “Buddy-tool-only” would falsely imply a supported Buddy turn. |

Sources fetched 2026-10-08:
[Codex App Server](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn) and
[Claude hooks](https://code.claude.com/docs/en/hooks#posttooluse-decision-control).
These establish vendor-documented mechanisms, not installed-version live proof.

Native Codex collaboration tools in this review's runtime explicitly offer `send_message`
and `followup_task` to native agent IDs, with delivery at a pending tool's completion. Their
IDs/queues belong to the provider harness. A Buddy MCP worker instead launches through
`post kind=request worker`, has a durable Unleashd run and conversation, and returns through
`answers`. Neither a native child ID nor its wait event is a Buddy request address.
No native child was spawned just to duplicate the assigned repair workers.

**Capability acceptance remains open:** steering worker must provide installed-version evidence
for a native shell tool, failed tool, parallel batch, parent blocked on native Agent/wait, and
child continuation. No real-CLI inference run was launched by this review. Do not label every
harness “inject-at-any-tool” from docs or the fake-provider tests. A blocked tool is not a
completed-tool boundary; if the owner needs prompt-time steering during that block, use a
demonstrated streaming-input mechanism or return from a bounded wait while children continue.

## Smallest coherent repair plan

1. Keep one durable Post write and the existing runner/admission/execution authority. Resolve
   destination before delivery. Owner admission changes only cap eligibility and ordering;
   it never gives a second writer to a conversation. Existing queued worker work keeps running.
2. One grant-scoped collector supplies pending messages to both the Buddy-tool wrapper and
   harness tool-completion adapters. No independent hook mailbox, poller per worker or second
   executor. Owner steering and explicit request messages use that boundary; ordinary public
   chatter retains its current follow-up gate. Config changes affect the next turn rather than
   suppressing delivery of owner text to the current one (recommendation; worker verifies).
3. Separate **thread-read receipts** (existing Buddy cursor) from **addressed delivery receipts**
   (the destination conversation's existing durable delivery run). A parent's channel read must
   not consume a worker's instruction. A worker reading shared history must not consume the
   parent's question. Do not broaden `take_unread` to all same-author posts.
4. Repair provider-idle in `TurnWatchdog`; count real native child progress appropriately, never
   wrapper timer heartbeats or merely an alive child PID. A long silent tool with no observable
   progress is an explicit measurement limitation. Inspect run_01a1185c and Maintenance Sleep
   before choosing N. The Claude background-wait widening is a separate existing behavior;
   do not silently delete it or give all Codex silence the Claude exception.
5. Use crate waiting reasons in the thread status line. Retain provider quota/startup/process-loss
   causes in diagnostics. Gate quota errors currently collapse into `execution_failed`; expose
   the nested cause without generating more DM messages or retrying forever.

## Exact proposed tool contract (manual review required)

Existing inputs stay unchanged:

```ts
post({ channel: {direct: []}, kind: 'request', worker: {provider: 'codex'},
       body: assignment, taskId, key })       // launch self-worker, result is Post
post({ channel: {id: channelId}, replyToId: requestId, body: note, key })
post({ answers: requestId, body: finalReport, evidence, key }) // closes request
```

First two calls cannot currently express a *conversation-addressed* direction/question for
two conversations of the same Buddy. A distinct report Buddy can exchange ordinary Mail,
but making every self-worker a new identity solely for transport adds lifecycle/staffing
work and does not prove any-tool injection.

Recommendation: extend the existing `post.channel` union with one request-scoped destination:

```ts
post({ channel: {request: requestId, to: 'worker'}, body: direction, evidence, key })
post({ channel: {request: requestId, to: 'parent'}, body: questionOrProgress, evidence, key })
```

Contract: only `inform` (default); `answers`, `worker`, `replyToId` and `taskId` are refused in
this form. Thread, task and audience derive from the request. Result remains the existing
Post/mention result. The request stays awaiting; final `answers` retains its existing meaning.
No arbitrary conversation IDs, owner token, or identity inherited from body text.

- `to:worker`: only the request's actual spawner conversation (including its established
  owner-chat background return branch) may address its bound worker conversation.
- `to:parent`: only the worker bound to that request/authorized continuation may address
  the spawner's established return conversation. Same Buddy identity alone is insufficient.
- Both endpoints must remain in scope and audience. Messages are information under the
  recipient's current grant, not extensions of staffing, task, workspace or owner authority.
- Replays use existing actor/workspace idempotency keys, including destination in the recorded
  mutation. One accepted write creates one targeted receipt. It neither closes the request nor
  cancels/restarts the child. Explicitly stopped/cancelled work is not revived by a late message.
- With an active destination: offer at its next supported completed tool boundary; settle the
  receipt only under the collector's delivery contract. With an idle, still-authorized endpoint:
  resume through existing admission. On unsupported harnesses report waiting honestly.
- One completion transport must not also deliver through the MCP fallback. Message IDs provide
  correlation; idempotent write is not a claim of exactly-once provider processing. The transport
  rejection/crash window and acknowledgment point must be pinned by regression before shipping.

Owner-suggested alternative:

```ts
message_worker({requestId, body, evidence?, key})
message_parent({requestId, body, evidence?, key})
```

These would have precisely the same authority, storage and receipt rules. Two aliases do not
remove schema work; they increase the advertised tool surface. Recommend the one `post`
extension unless owner review prefers directional names for discoverability. Neither is approved
for implementation by this review.

## Schema/code impact and removals

Proposed storage delta: a typed `run.delivery_scope` discriminator, `thread` (existing default)
or `request_message`. Reuse `run.input_id` → message Post, `run.conversation_id` → resolved
recipient, `post.root_id` → originating request, and existing run status/consumed outcome as
the durable receipt. No Worker table, new mailbox, supervisor, receipt table or parallel queue.
`request_message` compose selects its exact Post and never calls the shared thread read fence;
its own handoff settles its run. Request cancellation fences its pending addressed messages.
The engineer must verify crash/adoption behavior before confirming this one-column design is
sufficient; do not hide a second state machine in an untyped field.

Boundaries affected: MCP Post union/dispatch; crate Post write/authorization and delivery
mode; generated napi types; existing runner's compose/drain; grant-scoped delivery collector;
harness adapters and their journal/restart integration; runs/threads diagnostics. Existing Post
output need not expand. Receiver status uses existing runs read with a typed delivery mode.

Replace the bespoke `liveThreadPosts` selection/config-suppression loop with that collector;
retain MCP delivery as an adapter for weaker harnesses. Replace the generic queued→cap label.
Remove any temporary hook-only queue/peek path when collector integration lands. Keep the
busy-seat deferral, read fence for ordinary threads, failure-notice suppression, background
return branch, run lease and execution-adoption safeguards. Do not rebuild pre-October return
controllers or restore automated owner-DM envelopes.

## One workflow and acceptance evidence

Owner changes the active lead's thread to 3 tasks × 3 models × 3 versions. The owner Post is
durable; next supported lead tool completion injects it under the current grant. Lead sends
request-addressed direction to its still-running worker. The worker sees that direction at
its next supported completion, asks a question through the parent endpoint, and keeps working.
The parent sees the question at its next completion and answers through the worker endpoint.
The worker ultimately calls `answers` with evidence. Owner-chat returns stay in the existing
background branch; no raw Mail envelope or autonomous coordination post is added to owner DM.

Required combined regression: hold both endpoints; send correction, direction, question and
answer; verify intended transcripts, original request correlation, one local receipt per
message, no extra live writer, no child Stop, and no premature Task completion. Then exercise
replayed key, parent reading shared thread, same-identity siblings, cancelled request, rejected
cross-workspace/private-audience target, hook/MCP race, transport rejection, and restart.
Actual native-subagent tests use harness addresses; actual Buddy-worker tests use request IDs.

## Decision record and remaining questions

Question: how to provide responsive steering and live worker coordination without another
mailbox/controller or owner-chat noise? Assistant recommendation, **PROPOSED**, 2026-10-08:
one request-scoped `post` destination and one delivery collector; separate addressed receipts
from Buddy thread reads. Decision-maker for expansion: owner, pending concrete review.
Constraints: workers continue; no blanket wall cutoff; one executor, scope/grants preserved;
Mail/Task/File authority retained. Alternatives: two tool aliases; new identity per self-worker;
periodic channel polling; cancel/relaunch. Tradeoff: one typed storage discriminator and explicit
endpoint authorization in exchange for correct concurrent addressing. Existing primitives alone
support final returns but fail the reproduced live exchange. Revisit if endpoint receipts require
more than the existing durable run, or if owner prefers tool names for usability.

Linked successors: October 7 owner-chat restoration and October 8 root-causes approval
preserved in `source-evidence.json`; owner 07:40Z worker-messaging suggestion preserved in
`native-evidence.json`. The suggestion is not an approval of these exact schemas.

Remaining engineering evidence: installed harness injection/native-wait proof (steering lane);
run_01a1185c history and Maintenance Sleep/N (liveness lane); addressed delivery acknowledgment
and restart proof; exact immutable spawner/worker relation across retried requests (confirm in
existing core before adding fields); stale background branch receiving later owner guidance.
No scoped data proved actual Game Designer/Art Lead slot occupancy. Full implementation and
combined real-provider workflow are not verified or claimed complete.

## 08:15Z evidence successor — Codex native Bash steering

Steering worker milestone `post_01a11a90-357d-70ad-b1f1-102d851b92f3` reports a native-hook
prototype in its isolated lane. This reviewer inspected and preserved its logs (hashes in
`sibling-evidence.json`), not the uncommitted implementation or a rerun. The real Codex test
passed 1/1: initial shell tool waits for release, owner correction arrives, a second shell tool
uses 3×3×3 instead of original 2×2×2, original turn completes after 18.7 s. Log explicitly says
`child=false`: **no native child-wait proof yet**. Three prototype regressions pass; failing-first
log shows the missing native-hook endpoint returned 405 instead of 200 on the old implementation.
These are stronger candidate-mechanism evidence than official docs alone, but do not change
the reviewed main's Buddy-tool-only classification or prove all-tool/all-harness support.

Worker also says model picks deliberately remain queued to preserve config. Review recommendation
remains: deliver text now, retain model choice for next turn. Task permits a documented tested
exception, but this waiting choice must be flagged to the lead; it is not the general owner
steering outcome. Coordination posted to its Task (`post_01a11a94-707c`). Claude, native child
continuity, exact installed version and commit-level validation are still the steering lane's work.
