# Decision: thread follow (wait for new replies) and structured channel search

**Date:** 2026-10-04 · **Status:** owner ACCEPTED the direction; lead chose the open details (below)
**Decision owner:** repo owner · **Prepared by:** Buddies Development Lead
**Thread:** #channels-feature, root post_01a1070e-ae96-7251-872c-5dbfcb748f07

## Question

Owner: "Do we have a MCP that will let us 'wait for new response' on a slack thread, so a worker
can wait for someone else's work or updates?" Then: "implement that and add it to the MCP; also can
we search with text, paginate, use complex queries, filter on channels and/or message names?"

## What existed (at main 39ae2db)

- `channel_read({read:{search}})`: posts containing ALL literal words, newest first, `next`/`before`
  paging. Backed by an FTS5 index (`crates/unleashd-buddies/src/schema.rs`, `post_search`) but the
  query is literal words (`posts.rs` searchPosts). No channel/author/date filter, no phrase/negation/OR.
- Thread wakes (`server/src/buddies/channels.ts` header): `mention` (must answer) and `follow_up`
  (each OTHER Buddy that posted in the thread gets a yes/no gate; only `<yes>` replies). This
  applies to Buddy-authored posts too. **Correction:** my first reply in the thread said "a thread
  post from a Buddy wakes nobody"; that was wrong for public threads. Pairs live in memory.
- Request/answer in DMs wakes the requester after its turn ends (the only "wait for work").
- Blocking synchronous `wait` was designed 2026-08-21 and not adopted
  (`agent_notes/2026-08-21_primitives-and-the-wait-design.md`; PLANNING_PRIMITIVES.md "Historical
  contract", doc at 879b906): holds a provider process, burns run budget, unmeasured tool timeouts.

## Decision 1: follow a thread (owner accepted; details are lead choices)

A caller reading a thread may add `follow: {until}`. The caller's turn then ends normally. The
next post in that thread (anyone, owner or Buddy, other than the follower) wakes the CALLER'S
conversation (the one that called follow, like a request's return route) with only the posts it has
not read. No yes/no gate: the follower asked to be told. If `until` passes with no post, it wakes
once with a typed timeout. One wake settles the follow; a caller re-follows to keep waiting.

Lead choices the owner did not answer (revisit if the owner says otherwise):
- **Any post wakes** (not only mentions/replies to the follower). Reason: "wait for someone else's
  work or updates" means any update; mentions already wake without following.
- **A field on `channel_read`, not a new tool.** Reason: the tool count is a ratchet (14→12
  densify task); follow is only meaningful on a thread read, which already returns the read mark.
- **Durable**, unlike the in-memory pairs: a backend restart must not drop a follow silently.
- Not blocking. Alternative (60 s long-poll) deferred; add only if quick back-and-forth needs it.

Model: Opus. The wake routing (which conversation, how it relates to the return-route Task
task_01a0f7c2 and the in-memory pair machine) is still design work.

## Decision 2: structured search (owner accepted; query shape is a lead choice)

Typed fields in the MCP schema, not a Slack-syntax string, because the schema validates them
and agents don't have to quote/escape: `search: {text, channels?, from?, after?, before?, inThread?}`.
`text` supports words (all must match), `"exact phrase"`, `-excluded`, `OR`. Keeps `next`/`before`
paging; filters apply BEFORE pagination (the 2026-09-11 filter-before-pagination defect).
Audience/authorization unchanged: only channels the caller can read.

"Message names" interpreted as AUTHOR names (`from`: Buddy ids or `owner`). Posts have no names.
A Slack-syntax box in the UI (`in:#x from:@y`) would be one parser onto the same typed query, so it's
out of scope here.

Model: Sonnet. Clear criteria; FTS5 already exists.

## Revisit when

- Follow wakes become noisy (busy threads), then narrow to mentions/replies or batch.
- Agents need sub-minute exchanges, then consider the deferred long-poll.

---

## Successor 2026-10-04 (later): short grace wait before following (owner direction)

**Owner, #channels-feature:** "and if they try and wait on a thread with no pending replies? I
think it should poll for a second or two see if anyone chimes in, or wait and let it cook another
step."

What changes from Decision 1: `follow` is no longer "register and end your turn". A follow read:
1. **Unread posts exist** past the caller's read mark: returns them at once. No follow registered.
2. **None:** holds the read open for a short grace (2 s, one named constant). A post arriving in
   the window comes back inline. No follow registered.
3. **Still none:** returns `following: {until}` with no posts. The follow is registered (the
   worker's design: a queued Follow run, due at `until` or moved up by a post). The agent may
   keep working ("cook another step") or end its turn.
4. **Already read:** if the agent reads the thread itself before the queued follow run fires and
   has seen the new posts, the run settles without a model turn (same rule as
   task_01a0f7ff-bbd6, answers already read).

What still holds: no long blocking wait (the 2026-08-21 reasons: provider process held, run
budget, unmeasured tool timeouts; 2 s is far under any of them). Durable follow, any post wakes,
field on channel_read.
Lead choice: 2 s (owner said "a second or two"). Revisit if handoffs routinely land at 3–10 s.

---

## Successor 2026-10-06: implementation (worker, Opus; proposed, awaiting lead review)

Branch `feat/thread-follow-v2` @ 545cb9a, based on main 0ed0f2b. Not merged, not pushed.

**Rescued code reused.** `rescue/2026-10-05/unleashd-thread-follow` @ 0711d5e was coherent: a
follow is a `thread_follow` row + one queued `follow` run in the caller's conversation, woken in
the post's own transaction, with a transactional run-table rebuild for the widened CHECK. It
predated revision 2, so it lacked steps 1/2 and the already-read rule. Cherry-picked onto main
(conflicts only where main moved: `claimRun(RunBudgets)`, structured search schema), then changed:

- **Read mark = the Buddy's `thread_read` row.** Its posts, a follow, a wake and now a plain
  thread read (`markThreadRead`, existing rows only) advance it. The rescued design used "the
  newest post this read returned", which could not express "already read".
- **Three-step read** (mcp.ts `followThread`): `catchUpThread` → 2 s `FOLLOW_GRACE_MS` wait on the
  `posted` event → `followThread`, which rechecks and registers in ONE transaction.
- **Wake is a sum type** `FollowWake = posts | already_read | timeout`; `already_read` → runner
  `skip` (run settles cancelled, no turn). Upper bound fixed at first delivery
  (`delivered_through`), because the runner calls `jobFor` again when an adopted turn finishes
  and must not mark posts read that the wake never showed.
- **Foreground chats** (Inbox route): steps 1–2 work; step 3 returns typed `not_following`
  instead of refusing the whole read. Same reasoning as the 2026-10-01 return-route decision.

**Open question answered: does a follow wake count against the pool of 5?** Yes, while its wake
runs: the claim gate's `pool_full` applies to every run. A queued follow costs nothing. The wake
also waits `conversation_busy` behind the follower's own turn, which is what gives criterion 2's
"never concurrent".

Revisit when: a Buddy needs to follow from a foreground chat (would need a run route into human
chats, which 2026-10-01 rejected).
