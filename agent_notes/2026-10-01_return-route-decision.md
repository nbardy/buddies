# Return route for answers: decide at send time, not claim time

Date: 2026-10-01. Status: PROPOSED by Buddies Development Lead; awaiting owner decision.
Source incident: agent_notes/2026-10-01_unleashd_case_study_conversation_busy.md (wave_sim copy sha256 468fdecfb2a4077b…).
Code read at main 046ac6c.

## Root cause

A run doesn't know what it is until after it's claimed.

- `notify_author` (crates/unleashd-buddies/src/posts.rs ~741) enqueues a `Reply` run for EVERY Buddy-authored
  request, tagged with `return_conversation_id`.
- The claim gate (`WAITING_REASON_SQL`, runs.rs:41) holds any run with a conversation_id while that
  conversation is busy.
- Only after the claim does `returnJob` (server/src/buddies/runner.ts:212) ask `placement(origin)`. A
  foreground (human) origin turns out to need nothing (`mailbox` job: settle with a note).

So rows that are not model work go through the model-work queue (busy gate, pool cap). They show as
"blocked" and settle in 0–6 ms when the gate opens. Wave_sim, 2026-10-01: 9 rows, up to 2h44m.

## Proposal (simplify + fix)

The request records where its answer goes, as a sum type fixed when the request is sent:
`Returns = Inbox | Conversation(id)`.

- Requests sent from a foreground (human) chat get `Inbox`. `notify_author` creates no run, matching
  what it already does for owner-authored requests. The answer post is the delivery.
- Background/absent origins get `Conversation(id)` and work as they do today: busy gate, turn or fresh turn.
- Deleted: the `mailbox` Job variant, the foreground arm of `returnJob`, and the false
  queued rows. `failure_notice` runs follow the same route.

Placement is already derived from stable data (`conversation.kind` + visibility, server.ts:353), so the
server can stamp the route when it creates the request. Engineer to confirm: can visibility flip between
send and answer? If it can, decide whether that matters (today a flip goes to a fresh turn).

## Separate, also proposed

- Liveness: show last provider activity on `running` rows. The turn-attempt journal already records
  `attempt_activity` per conversation, so this is a read, not a new heartbeat.
- Mid-turn awareness (owner design call): an `Inbox` answer to a Buddy mid-turn in a human chat is
  unseen until it checks inbox. One option is appending "N new answers" to the next Buddy MCP tool result.

## Alternatives considered

- Exclude `reply`/`failure_notice` from the busy check in SQL. Smaller diff, but it keeps the
  no-op run and the late decision, and adds a special case to the gate.
- Decide placement at enqueue inside the crate. The crate doesn't know conversation kinds, so it would
  need a new host callback. Stamping the route on the request keeps the crate pure.

## Revisit if

Human chats need automated input mid-turn (then `Inbox` would need a wake path).

## Addendum 2026-10-01 14:36Z: liveness already exists, just isn't shown

- agent-cli emits `progress` events from `agent-cli.heartbeat` (vendor/agent-cli-tool/src/heartbeat.ts) every 30s
  once unified events have been silent for 25s.
- TurnWatchdog (server/src/turns/watchdog.ts) runs three clocks: bridge 2 min (any event, heartbeats included),
  provider idle 60 min (provider progress only; heartbeats excluded on purpose), and max 24h
  (= TURN_MAX_RUNTIME_MS = the run lease). Values are in server/src/constants/timeouts.ts.
- Gap: `watchdog.idle()` stays in memory, and run rows expose only status, startedAt and leaseExpiresAt.
- Proposal: show elapsed, lastProgress and the idle limit on running runs (runs list/get + UI). No new heartbeat.
- The overnight `running` 9.5h runs are a separate class: the backend was down (inferred from the
  "host restarted" outcome at 05:38Z), so no watchdog was alive. Tracked by P1 detach-and-adopt
  (task_01a0f2cb-48ba-722b-b0f6-07e4942fdb5c).

## Successor 2026-10-01 14:48Z: ACCEPTED by owner (lean version)

Decision-maker: owner, in #channels-feature thread post_01a0f7c2-048a-7742-9368-d3fb6b6bbff5
("Okay sounds good, and lets make sure we cover the reasoning in comments as this code is hard
to maintain and carries a lot of details hidden in it"). Proposal: post_01a0f7e7-387e-713e-96db-226a4724e669.

Accepted, two changes, each deleting something:
1. `Returns = Inbox | Conversation(id)` fixed at send time (as above). Deletes the `mailbox` job kind
   and the false blocked rows. Task: task_01a0f7c2-c655-73ba-944d-227c35c5e620.
2. The run lease is the heartbeat: a lease of minutes, renewed on the watchdog's bridge clock (agent-cli
   heartbeats keep it ticking). The lease stops doubling as the 24h max runtime. Deletes: the "show
   lastProgress" proposal above (a fresh lease IS liveness) and the separate blanket startup sweep.
   Child Task of P1 detach-and-adopt (task_01a0f2cb-48ba-722b-b0f6-07e4942fdb5c), landing after P1's
   candidate 811f758 so the merge-ready candidate is not reopened.

Superseded: "Separate, also proposed" above. Liveness field dropped (lease is it); mid-turn
"N new answers" notice dropped (new concept for an edge case; the inbox holds the answers).

Why the lease change: a run leaves `running` only when its holder settles it or at the next boot's
`recover_runs` (crates/unleashd-buddies/src/runs.rs:256). The lease equals TURN_MAX_RUNTIME_MS (24h),
so a dead holder's rows lie until the next start: 9.5h overnight 2026-09-30→10-01; 14 and 10 runs
orphaned at 12:34Z and 14:09Z on 09-30. Whether the backend was down the whole 9.5h is unconfirmed
(disk full, ENOSPC, logs unread).

Constraint carried into the Task: AGENTS.md rule from docs/incident-2026-09-10-buddy-chat-timeout.md:
foreground deadlines get TURN_MAX_RUNTIME_MS explicitly and never inherit the 600 s background claim
default. That incident is exactly lease-and-deadline being one number; this change separates them, and
its regression tests must keep passing.

Owner requirement: reasoning lives in code comments at each site (why the route is fixed at send time;
why lease ≠ deadline; the incidents), plus Pattern tags and docs/patterns.md.

Revisit if: lease renewal writes show up as SQLite contention, or human chats need automated mid-turn input.

## Successor 2026-10-01T15:05Z: owner approves P1 merge; dispatch fan-out handoff triaged

Decision-maker: owner, thread post_01a0f7c2-048a-7742-9368-d3fb6b6bbff5 ("yes do whatever it takes to
implement this"), answering the lead's question: merge P1 (continuity/p1-adopt @ 811f758, open edge cases
2a/2b documented on task_01a0f2cb) into local main once fix/lease-heartbeat is green on top of it. ACCEPTED.
Still no push.

Handoff triaged: agent_notes/2026-10-01_product_lead_dispatch_fanout_handoff.md (wave_sim Product Lead,
uncommitted, sha256 8e8157d097a870f6…). Lead's reading (recommendation, not owner decision):
- Related, same seam, NOT covered by Returns=Inbox|Conversation: its "consumed answer" case. A BACKGROUND
  origin (buddy-run-…) read the answer mid-turn via a tool call, yet a queued return run_01a0f62f still
  waited to resume it with the same answer. Inbox only removes foreground-origin returns. Follow-on:
  reading the answer settles its pending return run (consumed), unread answers still resume. Also fix the
  MCP text "inform wakes nobody" (mcp.ts:257), which is wrong for public/task posts and owner DMs.
- Unrelated layer, real bug: Product Lead badge showed 3 running while a fresh hello showed 2 of them idle
  (old native-child rows of completed parents). Client reconciliation, not the run store. Own Task.
- Deferred for owner design review (CORE_DESIGN.md:151): batching distinct same-topic requests from
  different conversations into one turn (3 GPU-custody questions in 36.7 s). Would add a concept; the
  incident had distinct requests, each correctly answered. Delegation-instruction tuning: not code.

## Successor 2026-10-01 15:10Z: IMPLEMENTED (engineer worker run; open questions answered)

Implements the accepted change 1 above. Commit `316ef1f` (branch fix/return-route, fast-forwarded onto
local main from 046ac6c; not pushed; backend not restarted). This note's sha256 before this section:
9863a55849bf158b…. Task: task_01a0f7c2-c655-73ba-944d-227c35c5e620. Decision-maker for the choices
below: the implementing engineer (worker run), within the owner's accepted design; each is revisable.

What landed:
- `Returns = Inbox | Conversation{id}` (crate types.rs, napi `{kind:'inbox'} | {kind:'conversation', id}`).
- Stamped at turn start: the grant carries `returns` (`returnsFor(visibility, conversationId)` in
  server/src/buddies/policy-port.ts; foreground → Inbox, background → Conversation). MCP `post` passes
  `grant.returns`. Builder and memory-review grants are Inbox.
- Crate `send_back` (posts.rs) is the one place an answer (`notify_author`) or failure notice
  (runs.rs `close_request`) becomes a run. Inbox and owner-authored requests enqueue none.
- Deleted: `mailbox` Job variant and its settle arm, the foreground arm of `returnJob`, and
  `RunnerHost.placement` with both implementations (server.ts, test harness). `returnJob` keeps one
  post-claim question, existence (`host.registered`): see Q3.
- Reasoning comments at: `Returns` (types.rs), `send_back`/`notify_author` (posts.rs), the claim gate
  (`WAITING_REASON_SQL`, runs.rs), `returnsFor` (policy-port.ts), `returnJob` (runner.ts), and the grant
  field (grants.ts). New pattern `route-at-send` in docs/patterns.md, tagged at each site.

Open questions, answered:
- Q1. Can placement flip between send and answer? No. A conversation's kind (with its visibility) is
  set once at construction; the `kind` setter in conversations/runtime.ts has no caller (rg `\.kind = `
  in server/src: none at 046ac6c). AGENTS.md: "A conversation's kind is ONE stored value". So the turn
  start is as good as send time, and the grant is where the route is decided. Revisit if a "promote
  background thread to foreground" (or the reverse) feature is ever added: the route would then belong
  on the request at send, read from the conversation at that moment, as here.
- Q2. Schema change? None. The route is stored in the existing `post.return_conversation_id`: on a
  request, NULL is Inbox and an id is Conversation (decoded once in `post_row` → `Post.returns`). The
  separate column was rejected because it would be fully determined by (request, return_conversation_id)
  for every existing row. Consequence: `Post.returnConversationId` on the napi type became
  `Post.returns`; no TS code read the old field.
- Q3. Background origin deleted between send and answer: kept today's behaviour (fresh turn) via
  `host.registered(id)`. This is an existence check, not a placement decision. A row with no
  conversation (queued before this change) also gets a fresh turn.
- Q4. Requests with no sending conversation (a crate caller passing no `returns`): Inbox. In production
  every Buddy request goes through MCP, whose grant always carries a route, so this only affects direct
  crate callers (tests). Before, such a request's answer started a fresh turn.

Known transition cost (not fixed; owner may want a one-time restamp):
- Rows from before 316ef1f still carry their origin conversation id, whatever its placement. Each one
  answered or failed after the upgrade whose origin is a human chat now queues a `reply`/`failure_notice`
  run there, as before, but the runner no longer settles it as `mailbox`. `runCoordinationMessage`
  refuses it ("Automated Buddy inputs require a background conversation"), and the run ends `failed`.
  The answer itself is in the inbox. The same goes for any such run already queued at upgrade.
  The count is not measured: live stores were not read.
- The dev watcher reloads TS and rebuilds the addon separately. Between those two steps, the new TS runs
  against the old addon, and the failure above can happen to new requests too.

Verification (on the commit; tree clean at 316ef1f):
- Regression test FIRST, failing on 046ac6c: buddies-v2 "an answer to a request sent from a human chat
  starts no run and never queues behind that chat". On main it fails with actual
  `[['reply','queued'],['chat','running']]`, which is the incident itself. It passes at 316ef1f.
- Crate guard `an_inbox_request_starts_no_run_for_its_answer_or_failure` (tests/core.rs).
- Background serialization: "a scheduled run asks for help in the background and its answer comes back
  as a turn there" and the worker-spawn test pass.
- typecheck exit 0. Rust buddies 4 + 34 + 1 pass. test:server 234 pass / 1 fail / 1 skip. test:client
  219 / 1 fail. The failures below also fail at 046ac6c, and none touches this change:
  buddies-v2 "a DM new chat opens the next generation…" (route requires `key`; test omits it);
  client "the Task filter shows one Task across channels…"; crate node.test.mjs "a request, its run and
  its answer cross the napi boundary" (reads `PostWrite` as `Post`); check-client-invariants G8 (CSS
  14033 > 13987).
- Size: source code +73/−47 (net +26) plus +84 comment lines (the owner's requirement); tests net +73;
  docs +17. Total diff +304/−74.

## Successor 2026-10-01 (lease-heartbeat implemented): engineer choices on the open questions

Decision-maker: the implementing engineer (worker of Buddies Development Lead), acting inside the
owner-ACCEPTED 14:48Z decision above. These are PROPOSED choices for the lead and owner to review.
Nothing is merged or pushed, and the backend was not restarted. Task: task_01a0f7f0-cf18-730a-8c72-2dd480be982c.
Request: post_01a0f7f8-4c60-7744-a219-7d712e6c270d.
Branch `fix/lease-heartbeat` at commit 1ad0781, worktree `../unleashd-lease`, stacked on
`continuity/p1-adopt` 811f758 (P1 unmodified).

### Q1. Lease length versus SQLite write rate
**Choice:** `BUDDY_RUN_LEASE_MS` = 5 min, env `CWV_BUDDY_RUN_LEASE_MS`. The holder renews at most
once per `lease / 5` (1 min).
- **Where renewal fires:** on the events that tick the watchdog's bridge clock
  (`BuddyTurnPolicy.bridgeAlive`).
- **Cost:** one primary-key UPDATE per running Buddy turn per minute. Ten concurrent turns make
  ten writes a minute.
- **Rejected: renew on every bridge event.** A streaming turn emits many events per second, so
  that would be one write per event.
- **Rejected: a 2-minute lease.** That equals the bridge timeout, so one missed renewal plus a
  short stall would expire a healthy turn.
- **Rejected: 15 minutes or more.** The lie a dead holder leaves grows with the lease.
- **Why 5 minutes is enough:** heartbeats arrive at most 30 s apart, so renewals land at most
  about 90 s apart. That leaves room for roughly four missed renewals. A dead bridge is ended by
  the 2-minute bridge timeout first.
- **Revisit if:** renewals show up as SQLite contention in the event-loop stall monitor.

### Q2. Does boot keep P1's explicit dead-pid interrupt?
**Choice:** keep P1's adopt-or-discard of journals. Delete the run-level sweep (`recover_runs`) entirely.
- **A `lost` journal (pid dead, no exit.json)** is adopted as `ended`. The new backend is now the
  holder, so it settles the run `failed` with "lost", which is the truthful cause. This was kept.
- **A refused journal** (unstarted, or its conversation is gone) still gets its attempt
  interrupted and its group killed. Its RUN is left to the lease: at most 5 min plus the 5 s
  backstop.
- **Queued chat runs a dead backend left** are no longer cancelled at boot. When the claim reaches
  one, `admitChat` finds no ticket and settles it cancelled ("no conversation waits for this chat
  turn").
- **Cost:** after a quick restart, a run the dead backend held that was not adopted keeps its
  conversation and one pool slot for up to about 5 minutes. The sweep ended it at once.
- **Why accept that cost:** the sweep cannot tell a dead holder from a live one on a shared store.
  `run-lease.test.ts` demonstrates it: on 811f758, backend B's boot ended backend A's live run as
  `interrupted`. Worktree backends share ~/.buddies, so this is a real configuration.

### Q3. How does the 600 s background lease relate?
**Choice:** there is no 600 s lease in this codebase any more.
- The 600 s default belonged to the retired v33 package's `claimBuddyRun`. The crate's
  `claim_run` has always taken the lease explicitly.
- Every claim, chat or background, now gets the same heartbeat lease.
- Deadlines differ by kind and are set at claim in the run's existing `deadline` column, with no
  schema change:
  - a chat run gets `chatDeadlineMs`, which is `TURN_MAX_RUNTIME_MS`, passed explicitly; the type
    has no default;
  - every other run gets `turnDeadlineMs`, which is `BUDDY_BACKGROUND_TURN_MS` (60 min).
- A background deadline now runs from the claim, not from `runTurn`. The two are seconds apart.

### Other choices
- **A renewal that returns `lease_lost` logs and does not kill the turn.** Reaching that state
  takes a renewal gap longer than the whole lease. The requester was already told the run failed,
  a late answer or settle is rejected, and the conversation stays busy in memory, so no second
  writer starts on this backend. Killing the turn would misreport a bookkeeping loss as a timeout
  or a user stop, which is the 09-10 failure mode.
- **Bug fixed on the way:** the claim gate's expiry was a bare UPDATE with no `after_settle`. An
  expired `post` run therefore left its request `awaiting` forever and never notified the sender.
  Expiry now shares `end_run` with `settle_run`.
- **One incident-guard line changed.** `buddies-v2.test.ts` asserted
  `leaseExpiresAt - startedAt == TURN_MAX_RUNTIME_MS`, which is the lease-equals-deadline
  conflation this change removes. It now asserts the same budget on `deadline`. The
  `conversation-runtime.test.ts` guards are byte-for-byte unchanged. One of them still carries a
  comment saying "the run's lease is the chat's deadline"; it was left alone because those tests
  had to stay unchanged.
- **No lastProgress field was built.** The runs `get` call shows `leaseExpiresAt` and `deadline`.

### Evidence
- **Tests written first; base 811f758 plus the new test file:** "a holder that dies while the
  backend stays up is cleared within the lease time" FAILED. B's boot interrupted A's live run
  (`errorCode: interrupted`). The silent-turn and idle-timer test passed on base, as a
  preservation guard should.
- **On 1ad0781:** both pass.
- **Mutation, renewal disabled:** both tests fail (`lease_expired` at about 5 s).
- **Mutation, gate expiry back to a bare UPDATE:** crate test
  `an_expired_lease_ends_its_run_like_a_failed_settle` fails.
- **Full suites on commit 1ad0781, clean tree:**
  - `pnpm typecheck`: exit 0.
  - Rust buddies: 4 + 34 + 1 + 0 pass.
  - Node boundary: 1/2. The failure is the known `node.test.mjs` "a request, its run and its
    answer cross the napi boundary", the same assertion at line 41 as on base.
  - `test:server`: 242 pass, 1 fail, 2 skipped. The failure is the known "a DM new chat opens the
    next generation".
  - `test:client`: 219/220. The failure is the known "the Task filter shows one Task…".
  - All three failures match 811f758's known failures.

### Not done
Merge, push and backend restart, per the request. A live soak on the real backend was not run.

## Successor 2026-10-06: an answer the requester already read settles its return run
Decision-maker: engineer (Sonnet worker) under task_01a0f7ff-bbd6, whose open question this was; proposed to the lead, not an owner decision. Builds on the route-at-send decision above.

**Question:** what counts as "read"? **Choice:** the cursor the server already keeps. The requester's `thread_read` cursor (moved by a `channel_read` of the request's thread to the newest post shown) reaching the answer's `ord` settles that requester's queued `reply` run as `cancelled`, `error_code = consumed`, with no model turn. It happens inside `mark_thread_read` (crate `posts.rs` `settle_read_returns`), so it works while the requester's own turn is still running: the run would otherwise sit `conversation_busy`.
**Alternatives rejected:**
- *The channel cursor (`post_read`).* An answer is a reply in its request's thread, so it is never on a channel's feed page; a channel read does not show it. Found by the first server test, which read the channel and did not settle.
- *Inbox listing counts as read.* The inbox carries counts and request rows, not the answer text; a Buddy that only listed its inbox has not received the answer, so settling would lose it.
- *Check at claim time in `replyJob`.* Simpler, but the run stays queued and "blocked" for the whole turn (the incident's 17 minutes), and a claim-time check needs its own read signal anyway.
- *A new "delivered" marker or scheduler concept.* Not needed: the cursors already exist and the run table already has `cancelled`.
**Tradeoff:** a Buddy that reads the DM channel but ignores the answer still counts it as read. That matches the follow rule (`already_read`), where reading is receiving. A run already claimed is never touched; only `queued` reply runs settle. Failure notices are untouched (they carry no answer).
**Revisit if:** a requester is shown to read the newest page without the answer text reaching the model (e.g. a truncated page), which would need the read to be per-post, not a cursor.
**Evidence:** crate test `reading_an_answer_settles_its_queued_return_run` (fails on base: reply run stays `Queued`); server test "an answer the requester already read settles its return run with no model turn" (fails on base: the return run ran as a model turn, `complete` not `cancelled`). Incident: `2026-10-01_product_lead_dispatch_fanout_handoff.md` (sha256 8e8157d097a870f6…), "Incident trace".
Also: the MCP `post` description no longer says "inform wakes nobody"; it says a Buddy-DM inform is inert while public or task posts can wake @mentions and thread followers.
