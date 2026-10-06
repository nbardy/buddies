# Step back: how does new input reach a conversation?

Date: 2026-10-06. Status: PROPOSED by Buddies Development Lead. No owner decision yet.
Trigger: owner in #case-studies (thread post_01a0f659-342a-7691-92b8-31a8b3791401). The owner asked:
"We can't have workers write to a foreground chat? It goes straight to inbox?", "can a lead spawn a
worker and await its response … without the messages system", and "this feels like a bunch of
different methods and subsystems … describe use and interface and find the simplest way".
The trigger was the lead's own miss in that thread. It promised to report a worker's result, then
could not, because the worker's answer went to the inbox and nothing woke the lead.
Code read at main 47c5f40.

## 1. Use cases (what people actually need)

| # | Need | Today | Gap |
|---|---|---|---|
| U1 | Owner talks to a Buddy (DM, thread, @mention) | Works | – |
| U2 | Lead hands work to a worker and **continues when it returns** | Works only from a background turn. From the owner's chat or a thread, the answer lands in the inbox and nothing resumes the lead. | **Main gap**: the owner has to ping the lead |
| U3 | Buddy asks another Buddy a question and gets the answer | Same as U2 | Same |
| U4 | Buddies talk in a thread until they decide to stop (owner 10-03: no hop cap) | Thread seats + follow-up gate | One extra model call per post per participant |
| U5 | Long work posts progress, then a result | `post` can be called many times | Behavioural, not structural |
| U6 | Scheduled work | Schedules | – |
| U7 | Work and its result survive a backend restart | Turns are adopted; queued runs are durable; an unstarted owner message is not ([task](task:task_01a10ae8-38d8-7377-a315-c61fa920eaaf)) | Partly |
| U8 | Owner sees what is running and where, and can open it | Badge + runs | Badge counts entries, not jobs ([task](task:task_01a0f7ff-d00c-7169-be38-ef25e23ecb3e)) |
| U9 | Nobody pays a model turn for something already seen | Consumed fence (0313ce3), follow read mark | Each path has its own copy of the rule |

## 2. What exists today: eleven ways input reaches a conversation

1. Owner types → chat turn (queued behind the Buddy's run limit).
2. DM `request` → the recipient gets a fresh `buddy-run-<id>` conversation (run kind `post`).
3. Answer → the requester gets run kind `reply`, routed by `Returns`:
   - `Inbox` (sent from a foreground chat): no run.
   - `Conversation(id)` (sent from a background turn): a turn after the busy gate.
   - Deleted origin: a fresh turn.
   - The consumed fence skips the run if the requester already read the answer.
4. Failure notice → same route as 3.
5. Channel @mention → a reply turn in the Buddy's thread seat (pair state machine).
6. Thread follow-up gate → an ephemeral yes/no model call per participant, then a reply turn on yes.
7. `channel_read follow:{until}` → a 2 s inline wait, otherwise a queued `follow` run.
   Background only; a foreground chat gets `not_following`.
8. Owner plain post in a DM → wakes members through thread seats.
9. Schedule → a run.
10. Worker = a `request` with `worker{provider, model}` → path 2, then path 3.
11. Native sub-agents (Claude Task, codex `spawn_agent`) → awaited inline by the provider.
    They are not Buddy runs.

Concepts behind these paths:
- conversation kind and visibility (foreground/background)
- thread seats
- the pair state machine
- the `Returns` route
- 5+ run kinds
- the busy gate
- the follow-up gate
- read marks
- the consumed fence
- the follow grace window

Most of these exist to answer one question: **where does this new post go, and when?** Each path
answers it separately.

### Why foreground chats take no automated input

The guard is `runtime.ts:424` ("Automated Buddy inputs require a background conversation"). It dates
from 32bc0a0 (2026-07-28, "Decompose server and harden Buddies integration"). **I found no recorded
owner decision behind it**; the rationale is unknown.

The 2026-10-01 incident that motivated `Returns = Inbox` was a different problem. Answer runs sat in
the *Buddy's run pool* as `conversation_busy` rows for up to 2h44m behind the owner's turn, then
settled as no-ops. Making them inbox-only fixed the false queue, and it also gave up delivery. I
chose that tradeoff on 10-01 without naming the U2 loss. That is the lead's miss.

## 3. Proposal: one rule

> **A conversation is subscribed to threads. A new post by someone else in a subscribed thread is
> delivered to that conversation.**
> - Conversation idle → the post starts its next turn.
> - Conversation busy → the post is appended to *that conversation's* queue as the next input,
>   exactly like an owner message typed mid-turn. It holds no pool slot and creates no run row.
> - The reader's read mark is already past the post → nothing is delivered.

Subscriptions:
- the thread the conversation lives in
- any thread it posted a `request` into (so a worker's answer comes back)
- any thread it was @mentioned in
- any thread it explicitly follows

Foreground chats are subscribers like any other conversation.

Answers to the owner's questions under this rule:
- **Can workers write to a foreground chat?** Yes. The worker's answer appears in the owner's chat
  and the lead continues in the same thread. That covers U2 and U3 for every conversation.
- **Can a lead spawn and await?** Yes. "Await" means the lead ends its turn with "waiting on X", and
  the answer opens its next turn in the same thread. No polling and no blocking tool call. A blocking
  wait was rejected on 2026-08-21 because of provider tool timeouts
  (agent_notes/2026-08-21_primitives-and-the-wait-design.md). Native sub-agents stay as the
  in-turn option for short jobs.

What the rule would delete or merge:
- `Returns` (Inbox | Conversation): the route is simply "the conversation that posted".
- Run kinds `reply`, `follow` and failure-notice merge into one delivery path, or into the
  conversation's own queue.
- `follow` step 3 and `not_following`; the foreground special case at runtime.ts:424.
- The consumed fence and the follow read-mark check become one read-mark rule.
- Possibly the follow-up gate for threads a Buddy is already in: deliver the post and let the Buddy
  choose not to reply. This trades a cheap gate call for a full turn, so it is an open question for
  big public threads.

What stays distinct:
- mentions (a way to subscribe)
- schedules (a timer that posts)
- workers (a `request` that names a model)
- native sub-agents (provider-internal; badge only)

## 4. Risks and open questions

- **Owner chat order.** A delivery waits FIFO with the owner's own queued messages. Does Stop clear
  queued deliveries, or only the running turn?
- **Notify without waking.** Should a request be able to say "notify only" (e.g. `wake: false`) for
  results the owner just wants to see in the chat?
- **Durability.** The per-conversation queue must survive a restart. This is the same requirement as
  [unstarted message survives restart](task:task_01a10ae8-38d8-7377-a315-c61fa920eaaf); one durable
  conversation queue solves both.
- **Runaway Buddy-to-Buddy loops.** There is no hop cap (owner 10-03), so loops are bounded only by
  the run pool and budget.
- **Pool accounting.** A delivery to an idle conversation takes a pool slot when it starts. A delivery
  to a busy one takes nothing until it runs.
- **Migration.** Rows queued under the current `reply`/`follow` kinds at cutover need a defined path.

## 5. Next step

1. The owner picks the direction: §3 as written, a variant, or keep today's model and only fix U2.
2. If §3: an Opus design worker turns it into the concrete interface, data model and migration,
   listing what each deleted path is replaced by (systems design, so Opus per the 10-01 policy).
3. Sonnet engineering Tasks follow from that design.

## Successor 2026-10-06 06:00Z: mail, interrupts, steelman, follow-wait

Owner: "I like this consolidation", "I do like the 'wait for a message in thread' MCP design as
well". Asked: do we remove mail? Can Buddies interrupt each other? Is there a reason to keep several
mail methods?

The owner endorsed the direction. The interface and migration are not decided yet; that is the next
step (§5).

**Mail is already only DMs.** The crate has two channel kinds, `Public` and `Direct` (types.rs:94).
"Mail" is a `Direct` channel. The only remaining `mailbox` references are comments about the deleted
job. What remains specific to mail is the `request` flag, and it does two things:
- It records an obligation: the inbox lists what you owe, and a failure notice fires if the recipient's
  run dies.
- It decides where the recipient works: a fresh conversation per request.

Under §3 the flag keeps only the obligation. Delivery is the one rule. Because a request opens its own
thread, it naturally gets its own conversation.

**Interrupts.** No conversation ever interrupts a running turn. There are three layers:
1. Push: the one rule. A post to a busy conversation waits in its queue until the turn ends.
2. Pull: the follow-wait (`channel_read follow:{until}`, 2 s inline). A turn that wants input now reads
   or waits for it. Reading moves the read mark, so the queued delivery becomes a no-op (the consumed
   fence, generalized). Under §3 `follow` becomes "subscribe + wait briefly", and it works from
   foreground chats too, because delivery reaches every conversation.
3. Proposed soft interrupt: every Buddy tool result can carry "N new posts in threads you're
   subscribed to" on a single line. A busy turn notices at its next tool call and decides whether to
   read. This needs no harness support.

The owner's Stop remains the only hard interrupt.

**Steelman for keeping several methods.** Each real difference is a parameter of one mechanism, not a
separate system:

| Real difference | Belongs to |
|---|---|
| An answer that must be tracked or failure-noticed, vs a plain message | the `request` flag on a post |
| Parallel isolated work (3 requests run at once) vs continuity in one seat (serialized) | new thread vs reply in an existing thread |
| A persistent role vs a disposable model | recipient: Buddy vs `worker{}` |
| Who can read it | channel audience (Public / Direct / task) |
| The owner may not want automated turns in their chat (the likely intent of the 07-28 guard: noise, cost, a turn running while they type) | a per-request `notify only` option; the delivery queues behind the owner's messages |
| External email or Slack | adapters that post into threads, not a second internal path |
| A blocking wait inside a tool | rejected 2026-08-21 (provider tool timeouts); covered by the short follow-wait plus push |

So nothing in the steelman needs a second delivery path.
