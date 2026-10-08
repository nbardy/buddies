# Request-addressed messages (message worker / message parent) — 2026-10-08

Task: task_01a11a97-1a8b-7487-ab7a-a2555d3b24be. Request: post_01a11aa9-f8d2-737d-a0f5-a20a82a00e3a.
Implementer: Buddies Development Lead's Opus worker (branch `feat/request-addressed-messages`).

## Decision status

- **Owner direction (accepted):** 07:40Z post_01a11a74-7a14 proposed "message worker" and "message parent"
  tooling, delivered at the next completed tool call. 08:37Z post_01a11aa9-1bad: "Complete all the work".
  The lead took these as authorization to implement the reviewed design.
- **The owner has NOT reviewed the exact schema line by line.** The shipped shape below is the reviewed
  design's recommendation (`post` extension, not two aliases), chosen by the assistant. It is open to
  owner revision.
- Design source: `agent_notes/2026-10-08_live-delivery-review/README.md`, SHA-256
  `3cdd629ba9bc9954f6679449fed1d2c6277b53fccf1b25c08a66607f6eda9d14` (re-hashed 2026-10-08 09:05Z;
  matches the Task's citation). Lead acceptance:
  `agent_notes/2026-10-08_live-delivery-lead-review.md`, SHA-256
  `66e0bab774c8a2d59d27f875c48071b2966990e641e4523e9443113c22ae25bd` (uncommitted when hashed).
  Preserved excerpt: "Self-spawned workers also share the parent's Buddy address and read cursor, so
  ordinary Mail cannot address both live conversations."

## The gap

A self-spawned worker IS its spawner Buddy, so the two share one Buddy id and one thread read mark.
An inform in the request's thread is the author's own post: `fan_out` never delivers it to its
author, and the shared mark cannot say which conversation read it. Review reproduction 2 (08:05Z):
the parent's direction and the worker's question both posted, and neither live turn ever saw them.

## Shipped tool schema (MCP `post`, `channel` union)

```ts
channel:
  | { id: string }
  | { direct: string[] }   // Buddy ids or 'owner'
  | { task: string }
  | { request: string; to: 'worker' | 'parent' }   // NEW
```

`post({ channel: { request: requestId, to: 'worker' }, body, evidence?, key })`: the parent directs
its running worker. `post({ channel: { request: requestId, to: 'parent' }, body, evidence?, key })`:
the worker asks or reports to whoever started it. These are non-final, inform only. `kind:'request'`,
`worker`, `replyToId`, `taskId`, mentions and broadcast are refused by name (crate `require_plain`).
`answers` stays the only way to close a request. The result is the ordinary Post (with `mentioned:[]`).

## Open point 1, settled: endpoint authority, acknowledgment, restart

**Authority is derived at every send from durable rows. Nothing is stored per message.**
- worker = the LATEST attempt of the request's `post` run: its Buddy and bound conversation. A retry
  in the same conversation keeps the endpoint. A provider-change retry moves it with the new conversation.
- parent = the request author's subscription to the request thread. This is the route `answers`
  already takes (`deliver_to_spawner`), so an owner-chat spawner resolves to its background branch.
- **Not** `request.conversation_id`: `bind_run` overwrites it with the worker's conversation, since the
  initial crate c3ff355. The client's "open conversation" eye on a request post relies on that, so
  the overwrite was left alone.
- The sender must write FROM the opposite endpoint's conversation (`from_conversation_id`). The same
  Buddy id alone is refused (`Denied`), so a sibling worker cannot speak for another request.
- The request must be `awaiting`. Closing it fences queued `to_worker` messages: `answer`,
  `close_request` (failed/cancelled) → `messages::close`, `request_closed`. A finished or stopped
  worker is never revived. `to_parent` messages still reach the parent.
- Messages are information under the recipient's own grant; they extend no authority.

**Storage: one additive column, as proposed.** `run.delivery_scope TEXT NOT NULL DEFAULT 'thread'
CHECK IN ('thread','to_worker','to_parent')`. It is added by `ensure_column` on open after the
delivery rebuild, and declared in `RUN_TABLE`. A message is a `deliver` row: the input_kind CHECK
cannot be ALTERed, and a rebuild for a new kind was not justified. It has its own input key
`message:<post>:<buddy>`, and the crate surfaces it as `RunInput::Message { postId, to }`, so every
host switch is exhaustive. No mailbox table, no worker identity, no controller.

**Receipts vs the thread mark.** The thread read fence, thread composes and unread pages ignore
addressed posts (`not_addressed!` in deliveries.rs). A parent's `channel_read` of the request thread
neither shows nor consumes a worker's message, and vice versa.

**Acknowledgment point.** Both boundaries share one collector (`mcp.ts addressedMessages`): a native
post-tool hook from the turn's own agent, and any Buddy MCP tool result. It peeks
(`pendingMessages(conversationId)`) and shows the messages. Their runs settle `consumed`
(`acknowledgeMessages`) only when the HTTP response that carried them closes with `writableFinished`.
A process-local `offered` set stops a hook and a concurrent Buddy tool call from both showing one message.
- Transport rejection: the relay (`server/relay/buddy-mcp-relay.mjs`) did not pass a caller's
  disconnect upstream, so the backend saw a completed write and acknowledged a message nobody received.
  Observed failing in "request messages: siblings, …" (dropped-hook step) before the relay change.
  It now destroys the upstream request when its caller leaves first. This edit changes the relay's
  version hash, so backends replace an older relay on attach.
- Restart: a queued message is a run row and survives (crate test reopens the store). `offered` is
  memory only, so a backend death between showing and acknowledging shows it again. The guarantee is
  at least once, never lost.
- An idle destination is claimed through ordinary admission (capped, conversation serialization; it
  waits `pool_full` honestly) and runs as a turn in that one conversation (`runner messageJob`,
  `outOfOwnerChat` so an owner chat is never used). It may end silently, and its failure posts nothing,
  so the owner's DM gets no added noise.

## Native harness children vs Buddy workers

A Buddy worker is a request's run: it has a durable run, conversation and grant, and it is addressed
by request id. A native harness child (a Claude/Codex sub-agent) is NOT a Buddy endpoint. Its
post-tool hook (with `agent_id`) is never shown addressed messages; the message is for the
conversation's own agent, which takes it at its next boundary (the child's return is one). Owner
steering's peek-to-children behaviour (task_01a11a68) is unchanged.

## Evidence

- Failing first: `…-evidence/failing-first.log`. The combined test failed on the steering base
  425e06d: "Invalid arguments for tool post: Invalid input at channel", after the owner-correction
  step had passed.
- Real installed harness, codex-cli 0.159.0, gpt-5.6-luna, one run (opt-in
  `UNLEASHD_REAL_STEERING=1`): `…-evidence/codex-rollout-excerpt.txt` from the native rollout. The
  parent's message was posted at 09:00:14.667Z and the worker's blocking shell tool completed at
  09:00:14.862Z. A developer message "Messages on your requests arrived…" followed at 09:00:14.876Z,
  then the second tool wrote 3×3×3 (default 2×2×2). The receipt settled `consumed`, there was no
  message turn, and nothing was stopped. Transcript: `…-evidence/codex-request-message.txt`. The first
  attempt passed the same material assertions but failed my over-strict "one turn" check: the answer's
  return to the parent is a second turn by design. The assertion was corrected and rerun once.
- Claude was not run for this change (the session limit was hit earlier today, and runs were kept
  minimal per the lead). Claude's PostToolUse transport is the same endpoint, proven by task_01a11a68's
  trials, but **this message path has no Claude live proof.**
- Tests: crate `a_request_message_reaches_only_its_other_endpoint_and_never_revives_closed_work`;
  buddies-v2 "owner correction → parent → live worker → question → parent → answer → final answers",
  "request messages: siblings, shared reads, hook/MCP race, a dropped hook, denied senders, cancel",
  and the opt-in "real CLI codex: a parent message reaches a busy Buddy worker after its native shell tool".

## Removed / not removed

Nothing pre-existing was a worker-message queue, so there was no superseded selection code to delete.
`liveThreadPosts` and the native steering resolver are now one collector with the addressed path,
and no second delivery path exists. Kept as instructed: background return placement, the failure
guard, the read fence, busy-seat deferral, run lease and adoption.

Line ceiling (after rebasing onto 83fd4e1, which set 11561): 11561 → 12005 (+444): messages.rs (≈200 lines including why-comments), the run-kind
plumbing, and the collector. This is a new, owner-approved capability.

## Alternatives and revisit conditions

The alternatives were the same as in the review: two tool aliases (`message_worker`/`message_parent`), a
distinct Buddy per self-worker, polling, and cancel/relaunch. Revisit if the owner prefers named tools
for discoverability; it would be a thin alias over the same crate path. Also revisit if an endpoint
needs messages before its worker run is bound: that is refused today ("not started; send it once it
runs") rather than queued without a destination. And revisit if exactly-once provider processing is
ever required, which would need a provider-side acknowledgment that hooks do not offer.

Integration: rebased onto origin/main 83fd4e1, which includes steering (a4696ed) and task_01a11aa8's
idle-background Stop hold. `holdStoppedTurn` now runs the same collector: a parent whose model is
idle while its own background job runs is released by its worker's message, as it is by an owner post.
Guard: buddies-v2 "a worker's question reaches a parent idle on its own background work". Failing
first: with the collector removed from the hold, the test timed out at 20 s, because the hold waited
for the job.

Note for the lead: f1011d0 was already an ancestor of origin/main before this push (it arrived with
an earlier merge). This commit adds no other commit.
