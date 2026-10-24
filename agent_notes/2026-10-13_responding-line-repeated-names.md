# "Game Designer, Game Designer, …" in a thread's activity line — root cause

Owner report 2026-10-12 (#buddies-dev thread post_01a1300e…), live thread:
room-runners #game-design, root post_01a11a20-28b7-76dd-aee4-161be40dbdaa.

## What happened (evidence: GET /api/buddies/runs?buddyId=buddy_01a119e3-9e69-765b-b91f-67b060894cfc)
- Game Designer's thread turn (conversation ee4bb646-…-8507cc8d79f5) sat in `background` state from
  10:41: the model was idle, waiting on its own background jobs.
- The thread was busy (CEO / Platform / Game Engineer posting every 1–3 min). Each post woke
  Game Designer as a follower and created ONE `deliver` run per post. Its seat was busy, so each
  run stayed `queued` (waiting `conversation_busy`, reach `next_step`).
- Nothing was lost: 50 such runs ended `cancelled` with errorCode `consumed` ("the reader already
  read it"), in batches at 12:57, 13:37, 13:54, 14:21, 16:28, 16:30, 16:34, 16:45 and 17:19.
  Each batch is the moment the live turn took a step and read the thread. Between batches the
  posts really were unread, sometimes for ~40 minutes.
- `respondingText` (client/src/components/buddies/channel-data.ts) named the Buddy once per
  row. It has done that since the line existed (before 8bb6f69 too), so the bug was latent. It
  only became visible when one Buddy had many rows in one thread.

## Why now
83fd4e1 / 302a5d7 / 8bb6f69 (2026-10-08) let a Buddy hold a turn open while it is idle on
background work and take new posts at its next step. That made hours-long busy seats normal.
With one run per post, a busy multi-Buddy thread piles up a run for every post.

## Fixed
Client: fix/responding-names-once f3a7a8c. Each Buddy is named once per verb, with a count
("Game Designer (16 posts) is …"). Guard: client/test/channel-response-status.test.tsx.

## Not fixed (proposal)
Delivery (crate deliveries.rs `wake`): coalesce to one queued delivery per (buddy, thread). The
reader consumes the whole thread at its next step anyway, so N rows carry no extra
information, only N claim-gate checks, N cancellations and N "waiting" rows. Needs an
owner/lead decision; it touches the run model.

## Follow-up 2026-10-13: "does the system handle it elegantly?" — correct, not elegant
Evidence: run lists by buddyId and conversationId, and both conversations' transcripts
(GET /api/conversations/:id/messages).
- The REAL Game Designer seat for the thread is 91eafe41-…-3b5ad8eca1c8 (Claude), active all
  day from 06:55. Its 10:41 turn ran about 3 h on background agents and received new posts
  live (stop-hook "new messages arrived" at 12:10).
- The 50 queued-then-`consumed` runs were all labelled with conversation
  ee4bb646-…-8507cc8d79f5. That conversation has NO messages on 10-12; its last activity is
  10-08, where every reply was "You've hit your weekly limit". Its last thread follow was
  10-08 06:33 (`follow:{wait:0}`). The thread_read subscription (deliveries.rs `subscription`)
  appears to have pointed at that dead conversation, and `wake` binds deliveries to it. Not yet
  proven why the 13:56+ runs bound to 3b5ad instead (likely runs.rs:442 requeue naming the
  seat, or bind_run). Open.
- Duplicate shown: the owner's 17:19 post was consumed at once on the dead seat's run, then
  shown again in 3b5ad at 17:32. Game Designer spent a turn saying "This is the owner's earlier
  message delivered again, and I've already handled it."
- Every post wakes every follower: 47 short turns 13:56–18:11 in 3b5ad, several of them
  "nothing new needs me, didn't post".
Proposals: (1) one pending delivery per (buddy, thread); (2) a subscription must never point at
a conversation that is not the Buddy's live thread seat (repair it on bind/claim); (3) never
re-show a post that is already past the read mark.

## Fixed 2026-10-13 (owner: "okay fix it")
Branch fix/delivery-seat-and-redelivery = f3a7a8c (display) + b8acb15 (delivery). Not pushed; the
live backend needs `pnpm addons` + restart to pick up the crate change.
- Follow placement (deliveries.rs `follow_placement`, called at bind_run + defer_run): a subscribed,
  unpicked delivery placed elsewhere re-points the follow. Existing stale follows heal on their next
  placed delivery; no migration needed.
- Held-Stop take: `SteerBoundary` stored as run.steered_boundary; a held Stop re-delivers only an
  owed post (@mention/DM). Tool-call takes keep 6c unchanged.
- (a) one-delivery-per-thread: deliberately NOT done. compose/fence already coalesce a burst into one
  turn; per-post runs carry picks, retries and idempotent intake.
Tests: crate 94/94; server full 337 pass / 8 skipped / 0 fail; client 267; typecheck; 9 client gates.
Each new guard was shown to fail with its fix removed (owed_only=false; bind or defer call removed;
native_tool wiring at the hold).
