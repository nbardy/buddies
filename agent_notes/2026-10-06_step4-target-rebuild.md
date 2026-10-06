# Step 4: one crate rebuild (deliver, subscriptions, durable queue, one migration)

Date: 2026-10-06. Author: Opus worker for Buddies Development Lead (request post_01a11051-7036).
Status: IMPLEMENTED on branch `feat/target-rebuild` (base origin/main `fda9fa3`). NOT merged, NOT
pushed: the merge migrates the owner's live store and needs the owner's explicit go.
Task: task_01a11013-a8fc-77a4-9d3f-7223f40cf2b1. Sources: `2026-10-06_buddies-target-system-review.md`
(decisions A–P accepted ~07:15Z), `2026-10-06_delivery-model-design.md` §3/§5/§6 Tasks 2–3,
`2026-09-30_pending-delivery-design.md` Rev 2–3, 8–10 and the fold successor.

Everything below marked **worker decision** is an engineering choice made here, not an owner or lead
decision. Each says what would justify revisiting it.

## What landed

- **Crate** (`crates/unleashd-buddies`):
  - `run.input_kind` = `chat | post | deliver`. Ended rows of `reply`, `failure_notice`, `follow`,
    `schedule` stay as `RunInput::Retired` history; the CHECK refuses a queued one.
  - New columns `body` (CHECK: queued chat needs it), `executing_at`, `through_ord`. `snapshot` dropped
    (an imported value moves into `legacy`). No lanes (H2).
  - `thread_read.conversation_id` is the subscription. New `deliveries.rs` holds `fan_out`, `fence`,
    `catch_up` (K), `compose`, `delivered`, and the Store API: `follow_thread`, `catch_up_thread`,
    `deliver_posts`, `delivered_to`.
  - Removed: `Returns`, `post.return_conversation_id`, `send_back`, `notify_author`,
    `settle_read_returns`, `follows.rs`, the `thread_follow` table, and `schedule.limits` (where the
    v33 `max_tokens`/`max_cost_usd` lived, never read).
  - Failure notice is a `run_failed` post (`close_request`). Schedule fires are posts (`fire_slot`,
    `fire_schedule` for "Run now"); `schedule.root_id` is the schedule's thread.
  - W0a/W0b ported, not cherry-picked: `enqueue_chat` with body, `mark_executing`, and the claim gate
    requeues a dead holder's unexecuted run.
  - G: `after_settle` → `resume`, J: `RunConfig.model` optional plus `record_run_model`.
  - ONE index list (`schema::INDEXES`), created on every open (task_01a0ee7e).
  - ONE migration (`migrate.rs`), with a pre-migration `VACUUM INTO` copy (9acd4bd's rule).
- **Server**:
  - `runner.ts`: one `deliverJob`, `requestJob` continuation (G and same-provider retry),
    `markExecuting` as the last await, J resolution at claim, host `available()` (materializes)
    and `reconfigure()`.
  - `mcp.ts`: `follow: {wait ≤30}|false`, legacy `{until}` canonicalized, answers carry
    `fromConversationId`, posts carry `mentions`.
  - `channels.ts`: gate skips `deliveredTo`, `seatWoken`, seat mark.
  - `routes.ts`: `seatWoken`, Run now = `fireSchedule`.
  - `policy-port.ts` / `grants.ts` / `turn-policy.ts`: `returns` removed, chat body,
    `cancelQueuedDeliveries`.

## Decisions to review (worker decisions)

1. **Step-4/step-5 seam: public and task threads subscribe only by `follow`.** Posting subscribes the
   posting conversation only in a DIRECT channel (requests, answers, DM threads). If seats subscribed
   by posting, a public thread's next post would wake the seat twice: once by the crate's delivery and
   once by the pair machine's mention or gate. Mentions and the owner's plain DM posts reach the crate
   as `PostInput.mentions`, and the fan-out skips those Buddies; `channels.ts seatWoken` is the one
   definition both writers use. The follow-up gate skips Buddies the crate delivered to
   (`deliveredTo`, replacing `delivering_followers`). Step 5 deletes all three. *Revisit:* in step 5.
2. **Self-spawned workers keep the spawner's subscription** (`deliveries.rs from_own_worker`, and
   `answer`'s `spawner_owns`). Found by `a_worker_request_runs_on_its_own_config_and_returns_to_the_spawner`.
   Spawner and worker are one Buddy in one thread, and D8 allows one subscription per (Buddy, thread),
   so the worker's answer:
   - was excluded as the Buddy's "own post";
   - moved the subscription to the worker;
   - marked the answer read before it was delivered.

   The fix:
   - the worker's posts in its own request thread neither subscribe nor move the mark;
   - an answer or failure of a self-request is delivered explicitly to the spawner's subscription
     (`deliver_to_spawner`);
   - compose shows posts that have a live delivery to this Buddy even when they are its own.

   *Revisit:* if per-conversation subscriptions are ever adopted (D8's rejected alternative).
3. **K in general form.** A post moves its Buddy author's mark only when nothing it was not shown lies
   between its mark and the post: a post by someone else, or a post still being delivered to it. The
   owner's mark moves as before, because the owner reads in the app. Seats tell the crate what their
   prompt showed (`channels.ts`, `markThreadRead` after the turn), because their own posts no longer
   read the thread for them. A request's recipient reads through the request at `bind_run`.
4. **Marks move at `mark_executing`, not at compose or settle.** This keeps R2: a holder that dies
   before the spawn leaves the posts unread, and the requeued run shows the same posts (its
   `through_ord` is fixed). It also coalesces early: sibling deliveries are fenced when the turn
   starts. *Cost:* a delivery turn that later FAILS (execution_failed) has already marked its posts
   read, and nothing re-delivers them. D10's visible notice belongs to step 5.
   *Revisit:* if failed delivery turns show up in practice; the fix is a `run_failed`-style notice.
5. **G scope: request (`post`) runs only.** A delivery or chat whose holder died after executing ends
   `lease_expired`, as before. "Same conversation" needed a real fix: `RunnerHost.registered` was a sync
   in-memory check, and a backend that boots after a restart materializes conversations only on use.
   Every return and follow wake after a restart therefore used to fall back to a fresh conversation (a
   pre-existing gap; the old follow (f) test documented it). `available()` now materializes. Guard:
   run-lease (the resume keeps its conversation on the surviving backend).
6. **Rule 5 manual retry** stays in the failed attempt's conversation when the model changes within
   one provider. The runner reconfigures that conversation to the retry's model (`host.reconfigure`).
   It starts fresh when the crate cannot prove the provider is unchanged: the failed run carried no
   config (profile), and the retry names one.
7. **Schedule thread.** The first fire is a top-level post. It goes in the schedule's Task channel,
   or else in the Buddy's own DM (`member_key` = its id). Later fires reply in that thread
   (`schedule.root_id`). Fires are authored by the Buddy and written as system posts, so they leave the
   Buddy's mark and subscription alone. They are delivered explicitly, so the fan-out's "never your
   own post" rule does not drop them. The Schedules panel history shows the runs of the conversation
   that took the first fire.
8. **Legacy queued rows at migration (D6):**
   - a `reply` becomes a subscription plus `Deliver{answer}`;
   - a `failure_notice` becomes a subscription plus the `run_failed` post;
   - a `follow` becomes a subscription, plus a `Deliver{newest unread}` if anything is unread. A
     timeout-only follow is dropped and counted (it stays subscribed);
   - a `schedule` row fires its slot as a post;
   - a queued `chat` becomes `cancelled/interrupted` (R1);
   - running rows get `executing_at` backfilled.

   Mutation guard: `without_the_executing_backfill_a_legacy_running_turn_would_be_replayed`.
9. **Claim-gate hardening:** a running chat row with no body is never requeued. Only a pre-rebuild row
   could be one. The CHECK would fail the requeue UPDATE, which would fail EVERY claim. The migration
   test's mutation found this. It now ends `lease_expired`.
10. **`follow:false` returns the unread posts** too (marked read) with `kind:'unsubscribed'`. A follow
    result is `unread | subscribed | unsubscribed` (`following`/`not_following` are gone).
    `FOLLOW_GRACE_MS` stays as the 2 s default wait.
11. **`run_failed` body** names the run, its error code and text, and the `runs retry` hint, with the
    run id inline.
12. **Query-plan guard:** `compose` sorts by `+ord` (an index walk of `post` otherwise). CTE scans and
    a materialized-subquery scan are allowed. A new index `schedule_root` is needed because every post
    insert probes `schedule` for the new foreign key.

## Changed guards (deliberate rewrites, each commented in the test)

- run-lease "a holder that dies …": lease clearing is unchanged; the request now RESUMES (G) instead
  of `failed`, and the resume keeps the conversation.
- buddies-v2: `reply`/`failure_notice` → `deliver`; delivery prompts; schedule "Run now" via
  `fireSchedule`; the follow suite moved to subscriptions: (a)–(d), (f) rewritten, (e) the timeout
  deleted, (g) a 25 s wait catches a post at 20 s, (h) `follow:false`. (f) uses the legacy `{until}`
  form end to end.
- crate: return/follow tests generalized into fence, burst, K, G, J, requeue, schedule-fire and
  migration tests.
- tool-contract: LEGACY_FORMS gains `follow:{until}`; the snapshot follows the additive changes
  (`worker.model` optional, `follow.wait`, `follow:false`).

## Not done / open

- Step 5 scope untouched: mentions, DM posts, seats, the pair machine and the gate run on today's
  paths.
- Soft notice (Task 6): not done.
- `body` is not cleared at settle (W0a cleared it); it is inert after the run ends.
- The owner-chat 15-minute `owner_first` bound stays until step 6.
- `migrate.rs` (268 lines) is one-time code. Delete it after the live migration has run everywhere,
  like the v33 importer (delete-and-migrate).
