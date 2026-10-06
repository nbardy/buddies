# Design: one delivery rule (conversations subscribe to threads)

Date: 2026-10-06. Status: PROPOSED design by an Opus design worker for Buddies Development Lead.
Nothing here is implemented. The owner has endorsed the **direction**; the interface, data model and
the decisions in §4 are assistant proposals that the owner has not accepted.

- Request: post_01a10fdd-85d4-70fb-934a-4ed279182cf4 (lead → design worker).
- Direction: `agent_notes/2026-10-06_delivery-model-step-back.md` (uncommitted; sha256 prefix
  `c06ab461d883e15c` at the time of writing), including "Successor 06:00Z".
- Owner endorsement, #case-studies thread post_01a0f659-342a-7691-92b8-31a8b3791401: "yes I like this
  consolidation", "I do like the 'wait for a message in thread' MCP design".
- Code read at main `47c5f40`. Design sources: `product/buddies/CORE_DESIGN.md` (last changed at
  `ef3e71b`), `docs/patterns.md` (route-at-send, lease-heartbeat, wake-on-write).
- Prior decisions this design succeeds: `agent_notes/2026-10-01_return-route-decision.md` (Returns =
  Inbox | Conversation, accepted 14:48Z) and `agent_notes/2026-10-04_thread-follow-and-channel-search-decision.md`
  (follow + 2 s grace, accepted).

## 0. A conflict the step-back note missed: read this first

The step-back note says the foreground guard (`runtime.ts:424`) has "no recorded owner decision". That
is not quite right. `CORE_DESIGN.md` at `ef3e71b` records:

- §"The owner talks while implementation continues": "A Worker report can bring the lead back through
  background coordination **without creating a human message or injecting an autonomous turn into
  the owner's chat**."
- §"Why this core stays small", row "Autonomous turns in human chat": rejected because it "couples
  owner access/history to background coordination".
- §"September 13 follow-up": "the owner **requested** that work launched from a human thread return
  completion/timeout to that Buddy in a separate background thread".

So delivering into a foreground chat reverses a September 13 owner request, not only an engineering
guard. The owner's 2026-10-06 endorsement ("Foreground chats are included") is the newer word. The
owner should still confirm it explicitly, knowing what it supersedes (decision D0 in §4). CORE_DESIGN
then needs a dated successor paragraph and an edited table row; the old text stays as history.

What still holds from September 13 is the reason behind it: the owner must be able to talk to the
lead while work is in flight. This design keeps that with owner-first ordering (D3) and Stop (D1).

## 1. The rule

> A conversation subscribes to threads. When someone else posts in a subscribed thread, the post is
> delivered to that conversation:
> - **idle**: the delivery starts its next turn;
> - **busy**: the delivery waits in that conversation's queue and runs after the current turn (owner
>   messages already queued go first);
> - **already read**: nothing happens. The read mark passed the post, so the queued delivery settles
>   `consumed` with no turn.

Any conversation can subscribe: owner chats, DM chats, thread seats, worker and request
conversations, and background conversations.

**Subscriptions.** Each (Buddy, thread) pair delivers to at most **one** conversation, the
*subscribed conversation*. The last subscription wins. A conversation becomes subscribed when:

1. it posts in the thread, including a `request`, which roots its own thread (this covers U2 and U3);
2. it is the conversation a delivery or request run opened for that thread: the seat opened for an
   @mention, or the fresh conversation of a request recipient;
3. it calls `channel_read {threadId, follow}`.

Mentions and the owner's DM posts are **deliveries to a Buddy with no conversation in that thread
yet**. The run carries no conversation, and the runner opens one when it claims the run: the
Buddy's seat for a public, task or DM thread, or a fresh `buddy-run-<id>` for a request. Opening it
subscribes it (case 2). Today's request recipients already work this way.

**Why one conversation per (Buddy, thread).** It lets the existing per-Buddy read mark
(`thread_read`) be the delivery cursor too, and it means a post never wakes the same Buddy twice. The
cost: when the lead replies in thread T from its owner chat C, later replies in T go to C and no
longer to T's seat (D8).

## 2. Interface: MCP tools after the change

There are 12 Buddy tools before and after. Only `channel_read`'s follow branch and the descriptions of
`post` and `inbox` change. Today's follow read has 3 result kinds (`unread | following |
not_following`), an `until` deadline, a timeout wake and a foreground refusal. Afterwards it has 2
result kinds and no deadline. The bigger reduction is in behaviour: one rule replaces eleven paths
(§3). Signatures that do not change are listed so the change is easy to see.

```ts
post({
  channel?: {id} | {direct: string[]} | {task},   // required unless `answers`
  answers?: string,                                // a request id
  body: string, kind?: 'inform' | 'request',       // default inform
  replyToId?: string, taskId?: string, purpose?: string,
  worker?: {provider, model, reasoningEffort?},    // request only
  evidence?: string[], key: string,
})
```
UNCHANGED shape. New description: "Write to a channel, DM or task, or answer a request. Posting
subscribes this conversation to the thread: new posts there by others come back to THIS conversation
as its next turn. A `request` also records that the recipients owe an answer. With `worker`, it runs
on that model."

```ts
channel_read({
  read: {channelId}
      | {threadId, follow?: {wait?: number /* seconds, 0..30, default 2 */} | false}
      | {search: {...unchanged}},
  before?: {ord}, limit?: number,
})
```
CHANGED, only the `follow` field:
- `follow: {wait}`: "Subscribe this conversation to the thread, then wait up to `wait` s for a post by
  someone else. Returns `{kind:'unread', posts}` if any are unread now or arrive in time, else
  `{kind:'subscribed', posts:[]}`. New posts will start your next turn here; end your turn when you
  have nothing else to do."
- `follow: false`: "Unsubscribe this conversation from the thread. You still see the thread in reads
  and search." This also covers notify-only (D2).
- Removed: `follow.until` (the timeout wake; use `schedule` when you need a deadline) and the
  `following` and `not_following` result kinds.
- `wait` is capped at 30 s. Claude gives up on a held tool call at about 60 s, and the MCP relay holds
  for 55 s (`HOLD_MS`). The 2026-08-21 rejection of a blocking wait still applies to anything longer.

```ts
inbox({})        // UNCHANGED shape: {requests, waiting_on, channels, unread_threads}
```
New description: "Requests you owe, your own open requests, and unread counts. Answers and replies to
your threads are delivered to the conversation that posted, so you do not need to poll this."

```ts
runs({action: {kind:'list', scope} | {kind:'get', runId} | {kind:'cancel', runId}
             | {kind:'retry', runId, worker?, key}})
```
UNCHANGED shape. Run rows show four input kinds (`chat | post | deliver | schedule`) instead of six.
A queued `deliver` row's `waiting` can be `conversation_busy`, `owner_first` (new, D3) or `pool_full`.

**Soft notice** (the optional "N new posts in your threads" line on every tool result) is not in this
interface. It changes every tool's output contract, which needs explicit owner approval
(CORE_DESIGN, owner clarification 2026-09-16). It is Task 6, and optional.

## 3. Data model

Reuse first: the `run` table is already the durable, per-conversation, serial, pool-limited queue
(`conversation_busy` plus `run_conversation_slot`). `thread_read` is already the per-Buddy read mark
of every thread. The design adds one column for the route and one run kind, and deletes a table and
three run kinds.

| Change | Where | Why |
|---|---|---|
| **ADD** `thread_read.conversation_id TEXT` (NULL = read mark only, not subscribed; owner rows are always NULL) | crate `schema.rs` | The subscription is the route, stored at write time, so route-at-send holds. Replaces `post.return_conversation_id` and `thread_follow.conversation_id`. |
| **ADD** index `thread_read_conversation ON thread_read(conversation_id) WHERE conversation_id IS NOT NULL` | schema | A delivery composes unread posts across every thread its conversation subscribes to. |
| **ADD** `run.input_kind 'deliver'`, `RunInput::Deliver { post_id }`, key `deliver:<post_id>:<buddy_id>` | `types.rs`, CHECK rebuild as done for `follow` | One run per (post, recipient), idempotent. Coalescing is done by the read fence, not by the key (see below). |
| **ADD** `run.through_ord TEXT` (the newest post a claimed delivery showed; fixed once) | `runs.rs` | The same job as `thread_follow.delivered_through`: an adopted turn must not mark unseen posts read when its prompt is recomposed. Engineer: check whether the legacy `run.snapshot` column is ever written. If not, drop it in the same rebuild. |
| **ADD** `RunWaiting::OwnerFirst` | `types.rs`, `WAITING_REASON_SQL` | D3 |
| **ADD** `RunInput::Retired { kind, id }` (read-only; never enqueued or claimed) | `types.rs` | Ended `reply`, `failure_notice` and `follow` rows stay as history behind a typed variant, with no silent remap (CLAUDE.md T4). |
| **REMOVE** `run.input_kind` `reply`, `failure_notice`, `follow` for new rows | types, runs, runner | Merged into `deliver`. |
| **REMOVE** table `thread_follow` and index `run_follow_queued` | schema, `follows.rs` | A follow is now a subscription. |
| **REMOVE** column `post.return_conversation_id`; type `Returns`; `PostInput.returns`; grant `returns` | schema, types, `policy-port.ts`, `grants.ts`, `mcp.ts` | The route is the poster's subscription. |
| **KEEP** `post.request`/`answer_id` (the obligation), `post.conversation_id` (provenance), `post_read` (channel feed marks), `RunInput::Post` (a request owed by its recipient, still one fresh conversation per request) | – | – |

**How delivery works** (all in the crate, inside the post's own transaction, like `wake_followers`
today):

1. `insert_post` / `answer` write the post. Then:
   - they upsert the author's `thread_read` with `conversation_id = from_conversation_id` (when one is
     given);
   - for every other Buddy subscribed to the thread, they enqueue `Deliver{post}` with
     `conversation_id` = that Buddy's subscribed conversation;
   - for each mentioned Buddy with no subscription (mentions are parsed by the host and passed in as
     `PostInput.mentions: string[]`), and for each Buddy member of a DM where the owner wrote a plain
     post, they enqueue `Deliver{post}` with `conversation_id = NULL`.
2. **The read fence** (generalizes `settle_read_returns`). Whenever a Buddy's `thread_read` mark
   advances, through a post, a thread read, a follow or a composed delivery, every queued `deliver`
   run of that Buddy whose post is in that thread at or below the mark is cancelled with `consumed`.
   This one statement replaces the consumed fence, follow `already_read` and the pair's `readThrough`.
3. **Claim** (`deliver_posts(run)`). The delivery shows the unread posts by others across **all**
   threads the conversation subscribes to (at most 20 shown, the rest counted), fixes `through_ord`,
   and advances each mark. The fence then cancels any other queued deliveries for the same posts, so
   a burst of N posts in M threads costs one turn. If nothing is unread, the run settles `consumed`.
4. **A failure notice is a post.** When a request run fails, `close_request` writes a
   `purpose:'run_failed'` reply in the request's thread, authored by the recipient Buddy, with the
   error and the `runs retry` hint. The requester's subscription delivers it like any other post.
5. **Run binding.** When the runner opens a conversation for a `conversation_id = NULL` delivery or a
   `post` run, `bind_run` also sets that Buddy's `thread_read.conversation_id` for the thread
   (subscription case 2).

**The per-conversation durable queue is the `run` table filtered by `conversation_id`.** Deliveries
are durable now. The owner's typed messages are durable only once Task 5 makes each a `chat` run at
send time (this merges task_01a10ae8). Until then, pending owner messages live in the memory
`TurnQueue`, as they do today.

## 4. Replacement map for the eleven paths (step-back §2)

| # | Path today | Replaced by | Code deleted (file: function) |
|---|---|---|---|
| 1 | Owner types → chat turn behind the run limit | Unchanged. Task 5 makes it a durable `chat` run at send. | (Task 5) `TurnQueue` pending entries become a projection of queued chat runs |
| 2 | DM `request` → fresh `buddy-run-<id>` (`post` run) | Unchanged: the obligation plus a fresh conversation, which is now subscribed to the request thread at bind. | – |
| 3 | Answer → `reply` run via `Returns` (Inbox: none; Conversation: busy gate; deleted origin: fresh turn; consumed fence) | A `deliver` to the requester's subscribed conversation, foreground or background. A deleted conversation gets a fresh turn (`openFresh`). The fence is generalized. | `posts.rs`: `notify_author`, `send_back`, `settle_read_returns`, `returns_of`; `types.rs`: `Returns`; `runner.ts`: `replyJob`, `returnJob`; `policy-port.ts`: `returnsFor`, `INBOX`; `grants.ts`: `returns` field |
| 4 | Failure notice → same route as 3 | A `run_failed` post in the request thread, then rule 1 | `runner.ts`: `failureJob`; `runs.rs`: the `send_back` call in `close_request` (becomes a post write) |
| 5 | Channel @mention → pair machine → seat turn | `Deliver{post}` with `conversation_id NULL`; the runner opens the seat (`seatConfig`/`openConversation`, kept) and composes with `seatPrompt` (kept: fresh session gets the whole thread, resumed gets the delta) | `channel-pair.ts` (whole file); `channels.ts`: `pairs`, `apply`, `runReply`, `trackRunSlot`, `awaitTurn` use, `untilIdle`/`idle`, the `wake` loop body, `responding` (now derived from running `deliver` runs) |
| 6 | Thread follow-up gate (an ephemeral yes/no per participant) | Removed (D7). Participants are subscribed; delivery coalesces; the Buddy may stay silent. | `channel-reply-gate.ts` (whole file); `channels.ts`: `followUps`, `followUp`; `follows.rs`: `delivering_followers` |
| 7 | `channel_read follow:{until}` (2 s inline, then a durable `follow` run; foreground gets `not_following`) | `follow:{wait}` = subscribe + bounded inline wait; works from every conversation | `follows.rs` (whole file: `follow_thread`, `deliver_follow`, `due_at`, `follow_until`, `wake_followers`); `mcp.ts`: `followThread`'s `inbox` branch and its `until` handling; `runner.ts`: `followJob`, `postsPrompt`, `timeoutPrompt`, `followAgain`; types `ThreadFollow`, `FollowInput`, `FollowRead`, `FollowWake` |
| 8 | Owner plain post in a DM wakes members through seats | A `Deliver{post}` to each Buddy member (NULL conversation → its DM conversation, `directConversation`, kept) | `channels.ts`: `directPost` shrinks to the mention list handed to the crate |
| 9 | Schedule → run | Unchanged | – |
| 10 | Worker = `request` + `worker{}` | Unchanged (2 + 3) | – |
| 11 | Native sub-agents | Unchanged; badge only | – |

Also deleted: the foreground guard in `runtime.ts` `runCoordinationMessage`. The busy check there
changes from "process, running or any queue entry" to "process or running" (a pending owner head
waits on its own chat run instead).

**Net line estimate (production code, excluding tests and docs): about −800, range −550 to −1,050.**
This is an estimate from file and function spans at `47c5f40`, not a measured diff.

| Area | Removed | Added |
|---|---|---|
| crate `follows.rs` → `deliveries.rs` | −258 | +150 |
| crate `posts.rs`, `runs.rs`, `types.rs`, `schema.rs` | −210 | +100 (including the one-time migration) |
| `channels.ts`, `channel-pair.ts`, `channel-reply-gate.ts` | −530 | +80 |
| `runner.ts` | −110 | +60 |
| `mcp.ts`, `policy-port.ts`, `grants.ts`, `runtime.ts` | −150 | +50 |

Tests: `channel-pair.test.ts` (−150) and follow (e) are deleted, and several tests are rewritten (§7).
Net tests ≈ −150.

## 5. Decisions on the open questions

All of these are **proposed** by the design worker. The owner should confirm D0, D2, D3, D7 and D8.

**D0. Deliver into foreground chats, reversing the September 13 request** (see §0). The owner chat is
where the owner and lead agreed the work, so the result continues there and the lead keeps the
context. *Alternative:* keep returns in a background branch and make the owner chat show a
notification. That leaves U2 half-solved: the lead in the owner's chat still does not continue.
*Revisit if:* the owner finds automated turns in their chat noisy, even with D2 and D3 in place.

**D1. Stop vs queued deliveries.** The owner's Stop ends the running turn **and cancels that
conversation's queued deliveries** (`error_code 'stopped'`). The posts stay unread, so they come back
with the next post in a subscribed thread, or when the Buddy reads them. Queued owner messages keep
today's behaviour (`TurnQueue`: "interrupt stops the turn, not the queue"). Stop does not unsubscribe.
*Why:* Stop means "quiet down now", not "never tell me". Cancelling only the running turn would start
the next delivery a moment later.

**D2. Notify-only: no new parameter.** A requester that only wants the answer visible sends the
request and then `channel_read {threadId, follow:false}`. The answer still appears in the thread and
in `inbox.waiting_on`. *Why:* it reuses the unsubscribe primitive, and a `wake:false` flag would add
surface to `post`. *Revisit if:* this pattern becomes common enough to be worth a shortcut.

**D3. Owner messages go first.** Within one conversation, a queued delivery waits while an owner
message is queued there (`RunWaiting::OwnerFirst`). Across conversations, order is FIFO as today.
*Why:* the owner is never behind automation in their own chat; this keeps the September 13
motivation ("the human must still be able to talk to the lead"). *Cost:* a delivery can be delayed
for as long as the owner keeps typing. That is acceptable, because the owner is present.

**D4. Loop bounds without a hop cap** (owner, 2026-10-03: no cap). These bounds remain:
- a Buddy's own posts never deliver to itself;
- coalescing: a busy conversation takes one turn per burst, however many posts arrived;
- the delivery prompt says "end your turn without posting if you have nothing to add", and a
  Buddy-triggered delivery that ends silently is a normal outcome;
- `max_active_runs` and the per-turn deadline;
- the owner's Stop (D1), and `follow:false` for either Buddy.

No counter is added. *Revisit if* `pnpm token-audit` shows a Buddy-to-Buddy thread above an agreed
spend. The fix then is a visible spend signal, not a cap.

**D5. Pool accounting.** Unchanged rule: a run takes a pool slot only while it is `running`. A queued
delivery holds none. Foreground chat runs already share the Buddy's pool (path 1). Delivering into
owner chats means owner chats and deliveries now compete for the pool more often. This design does
not change that. *Flag:* CORE_DESIGN says "human foreground capacity is independent", and today it is
not. That is a separate decision.

**D6. Migration of queued rows** (pattern delete-and-migrate). One transaction in the schema rebuild
handles each queued row as follows:
- `reply`: subscribe (requester, request thread) to the run's `conversation_id` and replace the run
  with `Deliver{answer_id}`;
- `follow`: subscribe (buddy, root) to the follow's conversation; if posts are unread, enqueue a
  `Deliver` for the newest. The pending **timeout** wake is dropped and counted in the migration log;
- `failure_notice`: write the `run_failed` post, then deliver it.

Ended rows of the three kinds become `Retired` history. `thread_follow` is dropped after this. The
migration prints before and after counts. It must be tested on a temp copy built by the crate's own
fixtures, never against the live store.

**D7. The follow-up gate does not survive, including for threads a Buddy is already in.** A
participant is subscribed, so each new post by others is delivered, coalesced, to its seat, and the
Buddy may stay silent. *Tradeoff:* a gate call ran on the same model with the thread as context, so
it is not much cheaper than a resumed seat turn with a warm prompt cache. A delivery also lets the
Buddy act, not only decide. For big public threads, a Buddy is subscribed only where it posted, was
mentioned or followed, and it can `follow:false`. *Revisit if* token-audit shows delivery turns in
public threads that end silent for more than about half of their cost.

**D8. Subscription moves to the last writer.** If the lead posts in a thread from its owner chat,
later replies arrive in that chat and no longer in the thread's seat. *Why:* the conversation that
last spoke has the intent. *Alternative:* subscriptions per (conversation, thread), with marks per
conversation. That adds a table and lets one post wake one Buddy several times.

**D9. A delivery turn's authority and session.** It runs with the conversation's own session
audience, so the owner chat's provider session resumes instead of forking. Its authority follows its
trigger posts: owner authority only when every shown post is the owner's. This reuses
`seatTurnInput` (`owner_input` vs `buddy_post`). A worker's answer must never run with the owner
grant of the owner's chat (the B1 lesson, 2026-09-25).

**D10. Silence.** A delivery whose posts include an owner @mention or an owner DM post must end with
a post. Otherwise the existing visible `reply_failed` notice is written, as it is for seats today.
Any other delivery may end silently. A failed turn always leaves the notice.

## 6. Sonnet-sized Tasks, in order

Each Task is Sonnet work: concrete criteria, design settled here. Each Task updates
`docs/patterns.md` and the tags it touches in the same commit.

**Task 1: An answer reaches the conversation that asked, foreground included (closes U2 alone).**
This is the smallest change that works on today's machinery. `returnsFor` always returns
`Conversation(this conversation)`. The foreground guard is lifted, the busy check is narrowed (§4),
D3 `OwnerFirst` and the D1 Stop cancel are added, and D9 applies to return turns. Follow works from
foreground (the `not_following` branch is deleted).
Done when, through the real backend in `buddies-v2.test.ts` with the fake provider:
- (a) an owner DM chat sends a worker request; the answer starts a turn in **that** chat when it is
  idle;
- (b) while that chat is running, the answer runs right after the turn; an owner message typed during
  the turn runs before it;
- (c) a lead that reads the answer mid-turn settles the return `consumed`, with no turn;
- (d) the return turn resumes the chat's provider session (same session id) and holds no owner grant;
- (e) a failure notice also arrives in that chat;
- (f) Stop cancels the queued return;
- (g) follow from a foreground chat registers and wakes it.

"an answer to a request sent from a human chat starts no run…" and the crate test
`an_inbox_request_starts_no_run_for_its_answer_or_failure` are rewritten to the new rule, with a
comment that names this decision. CORE_DESIGN gets a successor paragraph and its table row edited
(D0). Estimate: +60/−40. **Blocked on owner confirmation of D0.**

**Task 2: Subscriptions and `deliver` in the crate.** Add `thread_read.conversation_id`,
`RunInput::Deliver`, `through_ord`, the generalized fence, coalesced compose across subscribed
threads, and the failure notice as a `run_failed` post. Then delete `Returns`, `send_back`,
`return_conversation_id` and the `reply`/`failure_notice` kinds, and run the D6 migration. The
runner gets one `deliverJob`. Done when:
- crate tests show that a burst of 5 posts in 2 subscribed threads during a busy turn produces
  exactly one delivery turn showing all 5;
- a mark advance cancels every covered queued delivery;
- the migration converts each queued legacy kind, with logged counts, on a fixture store;
- Task 1's tests pass unchanged;
- `query_plan.rs` covers the new fence and compose queries (no table scan).

**Task 3: Follow becomes subscribe + wait.** Change `channel_read` to `follow:{wait}|false`. Delete
`follows.rs`, `thread_follow` and the `follow` kind (D6 for queued follows), and remove `until`.
Done when:
- follow (a), (b), (c), (c mid-turn), (d) and (f) are rewritten and pass; (e), the timeout, is
  deleted;
- a 25 s wait returns a post that arrives at 20 s;
- `follow:false` stops deliveries.

**Task 4: Mentions, DM posts and seats on `deliver`. Delete the pair machine and the gate.** Done
when:
- mention, task-comment mention, DM owner post and retry-on-another-harness all run through
  `Deliver{NULL}` and open the same seat ids as today;
- `channel-pair.ts` and `channel-reply-gate.ts` and their tests are gone;
- these tests still pass: B1, "a seat reply is what the Buddy posts", "an effort pick keeps the
  seat's session", "explicit thread choice survives a failed attempt", "a retried post (same key)
  wakes its mentioned Buddy once" and "Buddy hand-offs are not capped";
- "an owner reply in a DM thread…" is updated: a Buddy's inform in a subscribed thread now delivers;
- "X is replying…" still renders, now read from running `deliver` runs (screenshot compare on the
  thread screen).

**Task 5: Owner messages become durable chat runs at send.** This absorbs
task_01a10ae8-38d8-7377-a315-c61fa920eaaf. Done when:
- an owner message queued behind a running turn survives a backend SIGKILL and runs once after
  restart (extend `execution-adoption.test.ts`);
- `OwnerFirst` reads queued chat runs exactly;
- the in-memory `TurnQueue` keeps no pending state that is not also in a run.

**Task 6 (optional; needs explicit owner approval because it changes every tool's output):** the
soft notice, "N new posts in threads you're subscribed to", on Buddy tool results.

## 7. Risks, and the guards that must keep passing

What this breaks or changes on purpose:
- **Automated turns appear in the owner's chat** (D0). That is the point, and it is also the
  September 13 concern. Mitigated by D3 owner-first, D1 Stop and D2 unsubscribe.
- **Privilege**: a worker's text running inside an owner chat. D9 must hold; this is the highest risk.
  The guard to extend: B1 "a seat turn holds owner authority only when the owner wrote its trigger
  post".
- **Session forks**: if a delivery used the `buddy_message` audience, the owner chat would start a
  fresh provider session and lose its context. That is criterion 1(d).
- **The 10-01 symptom comes back with a different meaning**: deliveries queued `conversation_busy`
  behind a long owner turn. Now they are real work, and the fence settles them when read. The
  waiting text must make that clear (Task 1 updates the waiting reason description).
- **Buddy informs wake Buddies**: in a subscribed thread they now deliver, where before a DM inform
  was inert. Buddy-to-Buddy chatter is bounded only by D4.
- **Seat routing moves with the last writer** (D8): a thread's replies may land in a DM or owner
  chat instead of the seat.
- **Follow timeouts disappear** (`until`); any Buddy relying on them must use `schedule`. Queued
  timeouts at cutover are dropped and counted.
- **Restart**: the pair machine was memory-only ("a restart costs each resumed seat one full-context
  prompt"). Deliveries are durable, so a restart now loses nothing. That is an improvement.

Guards that must stay green unchanged:
- `server/test/run-lease.test.ts`
- `execution-adoption.test.ts`
- `ctrl-c-adoption.test.ts`
- `execution-crash-checker.test.ts`
- `sqlite-locks.test.ts`
- `copied-store-guard.test.ts`
- `wire-v3.test.ts`
- crate `query_plan.rs`, `an_expired_lease_ends_its_run_like_a_failed_settle`,
  `a_renewed_lease_outlives_its_first_term`, `a_group_request_starts_one_run_per_recipient`,
  `two_answerers_race_and_exactly_one_answer_lands`
- buddies-v2: "a group-DM request starts a run for each recipient", "a Buddy spawns tracked workers…",
  "runs retry re-runs a failed worker…", "a scheduled run asks for help in the background…", B1, and
  "Buddy hand-offs are not capped"

Guards to rewrite deliberately, each with a comment naming this design:
- buddies-v2 "one full chat turn: … the return is delivered" (now delivered into the owner chat)
- "an answer to a request sent from a human chat starts no run…"
- "an answer the requester already read settles its return run…" (keeps its meaning under the fence)
- "a follow-up for a post a mention turn already read…" (becomes a fence test)
- follow (a)–(f)
- "an owner reply in a DM thread…"
- crate `an_inbox_request_starts_no_run_for_its_answer_or_failure`,
  `reading_an_answer_settles_its_queued_return_run` (generalized), and the five
  `a_follow_*`/`a_new_follow_*` tests

## Revisit this design if

- the owner rejects D0. Then Task 1 becomes "deliver into a background branch of the owner chat", and
  Tasks 2–4 still apply with that branch as the subscribed conversation;
- token-audit shows delivery turns in public threads ending silent for most of their cost (D7);
- one Buddy routinely needs two live conversations in one thread (D8).
