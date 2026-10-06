# Pending delivery survives restart: one durable intake for every message path

Date: 2026-09-30. Author: Buddies Development Lead (buddy_d3f11f11), design-only run.
Status: PROPOSED (lead recommendation). Not owner-reviewed. No product code changed.
Task: todo_cc739f9c ("Make pending chat, DM, @mention and follow-up delivery survive restart").
Baseline: main `2690a95`; P1 branch `continuity/execution-adoption` (`26d9e28`, not merged).
Inputs: `2026-09-30_worker-continuity-double-audit.md` §6 (at 2690a95), `2026-09-30_execution-adoption-design.md`
(P1, uncommitted on main; committed on the P1 branch), `CHANNEL_CONVERSATIONS_2026-09-23.md`, `CORE_DESIGN.md`,
`docs/patterns.md`, `~/git/unleashd-wt-runindex/agent_notes/2026-09-30_buddies_queue_stall_handoff.md` (8 lost chats).

## 0. Where the in-memory state is today (evidence for everything below)

| Entry | Durable today | Memory-only today (lost on restart) |
|---|---|---|
| Ordinary chat send | a `queued` row in the diagnostics attempt journal (no text) | the `TurnQueue` entry and its text (`runtime.ts:687-723`) |
| Buddy DM / Wake / owner typing in a seat | a crate `chat` run, created only when the entry is the queue HEAD (`turn-policy.ts:357`) | text; entries behind the head; `recover_runs` cancels queued chat runs (`runs.rs:257`) |
| Channel @mention | the post | the `posted` event, pair queue, `seatHops`, `runReply` promise (`channels.ts:189-191`, `432-477`) |
| Channel follow-up | the post | the gate verdict, `gating`/`deferred`, `readThrough`; gate = bare CLI outside TurnRunner |
| Buddy request / worker / return | crate `post`/`reply`/`failure_notice` run, same tx as the post (`posts.rs:694`) | the `after` continuation (P1 re-derives it: `finishAdoptedRun`) |
| Memory review | nothing | the review ticket; P1 kills its execution at boot as unadoptable |

**Found while reading (bug, confirmed on a temp store):** the run key is `post:<post_id>`, not per recipient
(`types.rs:166`), and `enqueue` returns the existing row for a key (`runs.rs:105-112`). A request in a
group DM to Buddies A and B queues ONE run, for A; B is never started. Repro: owner `post` kind request to
direct `[owner, a, b]` → queued runs `[['a','post:post_…']]`. Fixed by W0's per-recipient keys below.

## 1. Lifecycle: one shape for every entry

**Intake → admit once → execute (shared TurnRunner, P1 journal) → deliver idempotently → settle once.**

- **Intake.** The input and its destination (conversation id) are written BEFORE the ack, in the SAME
  transaction as the message or post that caused them. After intake nothing is memory-only.
- **Admit.** A durable claim: the crate `claim_run` (lease) for Buddy work; the head of the records
  queue for ordinary chats (no pool, no Buddy). `conversation_busy` (existing claim rule) = one writer per
  conversation.
- **Execute.** Just before a side-effecting spawn the owner writes `executing_at` (after P1's
  `owner.json`, before the spawn). Before that mark a restart re-queues; after it, P1 adopts or the run ends
  visibly interrupted. Never a silent replay of an executed input (August rule, still holds).
- **Deliver.** The reply is the agent's own `post` (existing keys), the request answer (`run:<id>:answer`),
  the failure notice (`thread-reply:<post>:<buddy>`), or the provider transcript (chat). All replay-safe.
- **Settle.** `settle_run` under the lease (second settle = `lease_lost`), or deleting the input row
  (`changes()==1` exactly once). Settle happens BEFORE the P1 journal is deleted (see §8, ask to P1).

### Carrier per entry

| Entry | Carrier row | Written with | Destination |
|---|---|---|---|
| Ordinary chat (kind chat, builder) | NEW records-store `conversation_input` row | itself (it IS the message) | its conversation |
| Buddy conversation input (DM, Wake, owner in a seat, worker thread) | crate `run` kind `chat`, now with `body` | itself; enqueued at SEND, not at head | `run.conversation_id` |
| Channel @mention | crate `run` kind `mention` | the post, same tx | the seat id, resolved before the write |
| Channel follow-up | crate `run` kind `follow_up` | the post, same tx | the seat id |
| Buddy request / worker | crate `run` kind `post` (exists) | the post (exists) | bound at claim (exists) |
| Return / failure notice | `reply` / `failure_notice` (exist) | the answer / settle (exist) | origin conversation |
| Memory review (W5) | crate `run` kind `review` | idempotent enqueue before the turn's settle | none (bare CLI) |

Why not "every owner chat is a crate run" (§6): ordinary chats and the Builder have no Buddy, and
`run.buddy_id` is `NOT NULL REFERENCES buddy`. Their input belongs where their conversation lives, the
records store, which already has the precedent: `ConversationCreation` + `claim_initial_message_dispatch`
(a durable, leased first message, `records/store.rs:516`). Each conversation uses exactly ONE carrier,
chosen by its TurnPolicy (chat policy → records, Buddy policy → crate): one thin dispatch, never both.

### Crate schema delta (internal; `run` rebuild because STRICT `CHECK(input_kind …)` cannot be ALTERed)

```sql
-- run: rebuilt once in open() (create run_new, copy, swap, recreate indexes; ~4.4k rows).
input_kind TEXT NOT NULL CHECK(input_kind IN
  ('chat','post','reply','schedule','failure_notice','mention','follow_up','review')),
body TEXT,            -- JSON input that is not a post: chat {messageId, prompt:{resumed,fresh}, origin, inputId},
                      -- review {conversationId, attemptId, messageStart}. NULL for post-driven kinds.
hop INTEGER NOT NULL DEFAULT 0,   -- causal hop of the input (owner = 0); replaces seatHops
executing_at TEXT,    -- set by mark_executing just before a side-effecting spawn
CHECK(input_kind NOT IN ('chat','review') OR status NOT IN ('queued','running','cancel_requested')
      OR body IS NOT NULL)
-- settle clears body (the transcript holds it); keeps the runs table small.
```

Every new index/column must go through the on-open lists and the `every_ddl_index_is_recreated_on_open`
guard (`337da24`, unmerged): the 09-29 stall was exactly a base-DDL-only index.

Crate contract delta (napi, internal; no MCP/HTTP change):
- `RunInput += Mention{post_id} | FollowUp{post_id} | Review{run_id}`. Keys: `mention:<post>:<buddy>`,
  `follow_up:<post>:<buddy>`, `review:<run>`; `post:<post>:<buddy>` for new request runs (bug fix; old live
  rows keep their key and run once).
- `PostInput.wakes: Vec<Wake>` REQUIRED (empty allowed), `Wake = {buddyId, cause: mention|follow_up,
  conversationId, config?: RunConfig}`. `insert_post` validates each (active, same workspace, not the author),
  computes `hop` (owner 0; else the running run bound to `from_conversation_id` + 1; else 1), enqueues
  when `hop < 3`, and returns `PostWrite.capped: Vec<buddyId>` otherwise. The same tx cancels older QUEUED
  `follow_up` runs for the same (thread, Buddy) with `error_code='superseded'` (the "only the newest post" rule).
- `EnqueueInput.body`, `mark_executing(runId, leaseToken)`, `promote_run(runId)` (ready_at = conversation
  head's − 1 ms), `recover_runs(keep)` rule change (§3).

### Records schema delta (unleashd-ingest, `RECORDS_SCHEMA_VERSION` 2 → 3)

```sql
CREATE TABLE IF NOT EXISTS conversation_input (
  id TEXT PRIMARY KEY NOT NULL,           -- the QueuedMessage id
  conversation_id TEXT NOT NULL REFERENCES conversation_record(conversation_id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  position INTEGER NOT NULL,              -- push back = max+1, push front / promote = min-1
  origin TEXT NOT NULL, input_id TEXT NOT NULL,
  prompt TEXT NOT NULL,                   -- {"resumed","fresh"}
  attempt_id TEXT NOT NULL, queued_at TEXT NOT NULL, executing_at TEXT,
  UNIQUE (conversation_id, position)) WITHOUT ROWID;
```
Ops: `put_input`, `promote_input`, `mark_input_executing`, `settle_input` (delete; true once),
`list_inputs(conversation)`, `conversations_with_inputs()`. Candidate deletion in W3: the initial
message becomes the first `conversation_input` row, retiring the separate dispatch-lease fields.

Authority and config: chat → `body.origin` + the conversation record's config (already durable); mention
/ follow-up → `seatTurnInput(trigger post)` (already pure over the stored post) + `run.config` from the chip
pick (map `ConversationConfig` → `RunConfig`; "model default" → absent, engineer to confirm the mapping is total).

Seat resolution moves BEFORE the write: one server function `planWakes(post, thread, picks, seats,
eligibility) → Wake[]` (pure; reads done by its caller) inside the one server `writePost` that every public
post goes through (MCP tool, owner route, runner). The required `wakes` field makes a skipped planner a
type error rather than a silent no-op.

## 2. What is deleted, what becomes pure

| Today | Becomes |
|---|---|
| `TurnQueue` entries behind the head | durable rows; `TurnQueue` stays the pure machine, hydrated from rows (`from(rows)`), each transition written through. Its wire view is unchanged. |
| `chatTicket`, `admittedChatRun`, `waitForChatRunSlot` admission TICK, runner `chats` Map | deleted. The runner claims a chat run and calls `host.admit(conversationId, claim)`; the conversation reads the text from `run.body`. Wake-on-write replaces the tick. |
| `channel-pair.ts` (`gating`, `deferred`, `queue`, `readThrough`) + `pairs` Map + `apply` | deleted. Queue = live runs for the seat (`conversation_busy` serializes); deferred = superseding at intake; `readThrough` = the existing `thread_read(reader=buddy, root)` row, marked when the seat prompt is composed. |
| `seatHops` Map, `hopsOf` | `run.hop`, computed in `insert_post` from rows. |
| `runReply` promise, `untilIdle` 250 ms loop, `trackRunSlot` | runner jobs `mention` / `follow_up` (`jobFor` stays pure over the run): compose at claim (= admission, seat idle by construction), turn, then `after`. |
| `postFailure` + `repliedSince` continuation | the job's `after`, re-derivable after adoption: pure `replyOutcome(thread, seatId, through) → replied | notice(reason)`; notice keyed `thread-reply:<post>:<buddy>` (existing). |
| Reply gate CLI (no run row) | a step INSIDE the `follow_up` run, before `executing_at`: side-effect-free (no tools, no session), so a restart re-asks it. Disposition first: `thread_read ≥ trigger.ord` → settle `complete` "already read". `<yes>` → the reply turn in the same run; `<no>` → complete; failed on an owner post → notice, then failed. |
| `/responding` from `pairs` | a query over live `mention`/`follow_up` runs joined to the trigger post's root; "waiting for a slot" = the existing `waiting_reason` `pool_full`. |
| Memory review ticket (W5) | `review` run, key `review:<runId>`, body = the ticket; `executing_at` before its spawn, so a restart mid-review ends it interrupted (memory writes are not idempotent). |
| `recover_runs` "abandoned chat turns" | kept only for legacy chat runs with `body IS NULL`. |

Net: the channel exhaustive interleaving search is replaced by crate invariants (one live run per key,
one running run per conversation) tested at the store, plus the end-to-end tests below.

## 3. Restart matrix

Boot rule, pure and shared by both carriers: `disposition(executing_at, journal)`:
`executing_at NULL` → **requeue** (same id, same position; crate: `status='queued'`, lease and
`started_at` cleared); journal running/exited → **adopt** (P1); journal lost → **interrupted, visible**;
`executing_at` set with no journal → **interrupted, visible** (defensive; unreachable once settle precedes
journal deletion). Adoption happens before the runner's first claim (P1 already orders it). An
interrupted mention/follow-up run gets `replyOutcome` at boot: its notice only if the seat did not post.

| Entry | A. before dispatch | B. waiting for a slot | C. mid-turn | D. reply posted, not settled |
|---|---|---|---|---|
| Ordinary chat | row queued → hydrated in position, head starts | n/a (no slot) | journal → adopted; head row stays executing; next row waits | adopted exited journal replays; `settle_input` deletes the row once; next row starts |
| Buddy DM / Wake / seat typing | queued run survives (no longer cancelled); claimed in order | same run, `waiting_reason` survives | kept run adopted; `conversation_busy` blocks the next chat run | replay → `settle_run` once; transcript is the reply (P1 overlay note) |
| @mention | run was written with the post, so it cannot be lost after the ack | same | adopted; the agent's post uses its own key | replay → `after`: `replyOutcome` sees the seat's post → no notice → settle once |
| Follow-up | same as mention | same | gate phase (no `executing_at`) → requeue → gate re-asked once; turn phase → adopted | as mention |
| Request / worker | exists | exists | P1 (`finishAdoptedRun`) | request already answered → `after` skips; key `run:<id>:answer` |

No second writer: one running run per conversation (crate unique + claim rule), and records inputs start
only when the head is not executing. No duplicate visible reply: every visible write has a replay key, and
the `posted` event fires only for `created`. No misreported miss: `replyOutcome` reads the thread, not memory.

## 4. Hot reload after this and P1

Shutdown waits only for in-flight mutations (milliseconds). Delete `ShutdownConversation.holdsUnadoptableWork()`
and the reload deferral for queued sends and slot waits: queued work is on disk, running work is adopted.
What a reload still costs: a gate in flight is re-asked (≈6 s of provider time); a memory review in flight
ends interrupted (visible in runs); the live overlay is rebuilt by replay. The dev watcher can reload
on every change instead of waiting for idle (the 20-minute starvation in `2026-09-29_dev-backend-reload-starvation.md`).

## 5. Guard tests and pattern

`server/test/pending-delivery.test.ts`, reusing P1's harness (`execution-adoption.test.ts`: real backend
process, temp HOME and stores, fake `claude` on a PATH with no real agent CLI; SIGKILL, then backend B):
1. **Before dispatch:** 3 ordinary-chat sends and 3 DM sends queued behind a hanging turn; kill; B runs them
   in order, each exactly once (the fake CLI logs prompts).
2. **Waiting for a slot:** Buddy with `max_active_runs=1` busy; an @mention and a DM message wait
   (`pool_full`); kill; B: both run once after the busy run ends.
3. **Mid-turn:** mention reply mid-turn; B adopts; exactly one reply post, no `reply_failed`.
4. **After post, before settle:** the fake CLI posts its reply, then blocks on a file; kill; release; B:
   one reply, no notice, run `complete`.
5. **Gate:** the fake CLI blocks during the gate; kill; B asks the gate once more, replies once.
6. **Group request** (crate test): a request to A and B enqueues two runs (fails on today's key).
7. **Atomic intake** (crate test): an invalid wake rolls back the post; a created post always has its runs.
Mutation checks: drop the requeue rule (test 2 fails), enqueue mentions outside the tx (test 7 fails),
drop `mark_executing` (test 3 duplicates). Plus a table test over `disposition`.

`docs/patterns.md#durable-intake`: *Smell:* work acknowledged while its only copy is in memory (8 owner
chats lost on 09-29). *Pattern:* an input and its destination are a row before the ack, in the same
transaction as the message that caused them; in-memory queues are projections; `executing_at` splits
"requeue" from "adopt or interrupt". Tags at `insert_post` wakes, `recover_runs`, `conversation_input`
ops, `Conversation.enqueuePrompt`, runner `admit`, `disposition`.

## 6. Waves (lines are estimates; ± 40%)

P1 touches `runner.ts`, `turn-policy.ts`, `runtime.ts`, `runs.rs` (`recover_runs`), `node.rs`,
`index.d.ts`, `server.ts`, `shutdown.ts`, `turn-attempt-journal.ts`. It does NOT touch `posts.rs`,
`schema.rs`, `channels.ts`, `channel-pair.ts`, `channel-reply-gate.ts` or the records store.

| Wave | Content | Lines | Conflicts with P1 / order |
|---|---|---|---|
| W0a | crate: run rebuild (kinds, body, hop, executing_at), wakes in `insert_post`, supersede, per-recipient keys, crate tests | +300 Rust | none (`schema.rs`, `posts.rs`, `types.rs`); can land now, dormant (server passes empty wakes) |
| W0b | crate: `mark_executing`, `promote_run`, `recover_runs` requeue rule | +80 | `runs.rs`, `node.rs`, `index.d.ts`: after P1 merges |
| W1 | channels on runs: planner, mention/follow_up jobs, gate step, `/responding`; delete pair machine, maps, loops | −600 / +300 | `runner.ts`: after P1 |
| W2 | Buddy chats as bodied runs at send; delete ticket, tick, `chats` Map | −200 / +180 | `turn-policy.ts`, `runner.ts`, `runtime.ts`: after P1, after W1 (same runner) |
| W3 | records `conversation_input`; await write before ack; boot hydration; attempt-journal init skips pending | +250 / −80 | `runtime.ts`, `server.ts`, journal: after P1 |
| W4 | shutdown: delete `holdsUnadoptableWork` and the reload deferral; docs | −80 | after W2 + W3 |
| W5 | memory review as a `review` run | +120 / −60 | `turn-policy.ts`: after W2 |

Only W0a is independent of P1. Everything touching the runner or conversation must wait for P1 to merge.

## 7. Chat latency and other risks

Measured on a temp crate store (Apple M4, napi async round trip, 500 samples, 2 runs):
`enqueue_run` chat p50 0.20–0.23 ms, p95 0.45–0.50 ms, max 12.6–13.5 ms; public `post` p50 0.36–0.43 ms,
p95 0.91 ms; DM request (post + run, one tx) p50 0.64–0.72 ms, p95 4.9 ms, max 14.7 ms. Maxima look like
WAL checkpoints. The records store was not measured (not reachable from a script without a harness);
expect the same order (a small insert). So an awaited intake write costs ~0.3 ms typical, ~15 ms worst,
against a send that today acks synchronously. It already does one per-send write (the attempt journal).
- **Tail latency:** one crate connection serializes writes; a large write in front of a chat intake
  delays the ack. Show the message optimistically on the client and only mark it failed on a rejected write.
- **Disk full:** this machine's data volume is at 98%. A full disk now fails the send visibly (typed error)
  instead of losing it later, but it WILL surface.
- **Claim cost:** every queued chat message is now a queued run; `claim` evaluates `WAITING_REASON_SQL` per
  candidate, so deep blocked queues cost more. Extend the query-plan guard and measure in W2.
- **Runs table growth:** +1 row per Buddy chat message; the body is cleared at settle.
- **Promote across the pool:** `promote_run` moves `ready_at` earlier, which also puts it ahead of other
  conversations of the same Buddy. That is acceptable for an owner action.
- **Seat resolution before the write:** two concurrent picks on a new provider can both plan generation
  N+1. The ids are deterministic, so they converge; the second opens with the first's config.

## 8. Contradictions with §6 and P1

1. §6 "owner chat messages become crate run rows" only holds for Buddy conversations. Ordinary chats and
   the Builder have no Buddy, so their carrier is the records store. There are two carriers, one per
   conversation.
2. §6 "the gate becomes part of the reply run": agreed, but NOT as a TurnRunner turn. It is side-effect-free
   and runs before `executing_at`, so a restart re-asks it. No journal is needed.
3. P1 lists "a crash between a turn's journal removal and its run's settle → interrupted". This design
   needs **settle before journal removal** (P1 already shows that order is safe). With `executing_at`, the
   old order degrades to a visible interruption, not a duplicate turn. At boot, interrupted
   mention/follow-up runs go through the same `replyOutcome`, so a posted reply is never reported missing.
4. P1 boot still cancels waiting chat runs, and shutdown still waits for queued sends. W0b and W4 reverse
   both.
5. P1's `recover_runs(keep)` interrupts every non-kept running run. This design requeues the ones that
   never reached `executing_at`, so P1's spawn path must call `mark_executing` (in W0b/W2, after P1).
6. New: group-DM requests start only the first recipient (key bug above). W0a fixes it, independent of P1.

## Revisit if
- Per-message intake measurably slows chat acks (p95 > 20 ms in real use), or the runs table grows past
  what the query-plan guard tolerates.
- Owner decides the Builder or ordinary chats should become Buddy-owned. Then one carrier suffices.

---

## Revision 2 (2026-10-01)

Author: Buddies Development Lead, design-only run. Status: PROPOSED (lead recommendation). Not yet
owner-reviewed: CORE_DESIGN.md requires the owner to review schema changes, and Product review does not
replace that. The original text above stays as history. Where this section disagrees with it, this section wins.
Inputs: Product review `2026-10-01_pending-delivery-product-review.md` (uncommitted, sha256 prefix
`4d90729f57bbeda0`). Design text above at sha256 prefix `971f5937db7a913f` (before this append). Base:
main `8290148`, P1 = `continuity/execution-adoption` `26d9e28` + `continuity/ctrl-c-proof` `c98b9ce`.
Row shapes come from the crate's code and schema history only (`schema.rs` DDL plus on-open steps,
`runs.rs` enqueue/claim/settle/recover, `types.rs` keys). I opened no live store.

### R1. Legacy migration that opens (review 1)

**Which `run` row shapes exist today.** Derived from `schema.rs` history (`c3ff355` → `8586d1a`) and from
every write path (`runs.rs` enqueue/claim/settle/cancel/recover, `tasks.rs` epoch cancel, `team.rs`
archive cancel):
- Columns: the base DDL, plus `config` (added 2026-09-28, NULL on older rows), minus `retry_of` (dropped
  2026-09-27). `open()` already drops and adds those columns before any later step, so the rebuild
  copies one canonical column list.
- `input_kind` × `status`: all 5 kinds × all 6 statuses can exist. Chat runs (key `chat:<turnId>`) are
  created at queue HEAD (`turn-policy.ts`). Post runs have key `post:<postId>` (the old key, kept
  forever). Reply runs have `reply:<postId>`, schedule runs `schedule:<id>:<slot>` and failure-notice
  runs `failure:<runId>`.
- Live rows at migration time:
  - `queued` chat, no text anywhere durable. Today `recover_runs` cancels it a moment later.
  - `running` / `cancel_requested` of any kind. With P1, a running row may be ADOPTABLE: `keep` holds
    its id and its journal holds the prompt.
  - `queued` post/reply/schedule/failure_notice, which must stay claimable.
- Rows with `legacy` set (the v33 import, import CLI deleted on 09-27) and NULL `conversation_id`,
  `task_id`, `after_run_id`, `deadline` or `config`. Terminal rows carry a mix of `outcome` /
  `error_code` values.

**What is wrong in Revision 1.** (a) The CHECK requires a body on live chat rows, so copying a running
or queued legacy chat row fails the rebuild and the backend cannot open. (b) A hazard the review did not
name: W0b's boot rule "`executing_at` NULL → requeue" would also pick up every legacy running row. Those
rows were spawned before the column existed, so they would be REPLAYED (the August rule forbids this),
and a body-less chat row would fail the CHECK on requeue.

**Revised constraint.** A body is required only while the row can still be requeued:
```sql
CHECK(input_kind NOT IN ('chat') OR status <> 'queued' OR body IS NOT NULL)
```
A running row does not need its body: once it is past `executing_at`, the P1 journal and the transcript
hold the prompt. Requeue only touches rows with `executing_at` NULL, and every such row of a bodied kind
was written with its body.

**Atomic migration, one transaction inside `open()`.** It runs after `drop_run_retry_of` /
`ensure_run_config` and before the server calls `recover_runs`. It is detected by the absence of
`'mention'` in the stored `run` CHECK text, so a second open does nothing.
1. `PRAGMA foreign_keys=OFF` (outside the tx; no table references `run(id)`, but the rebuild must not
   cascade), then `BEGIN`.
2. `CREATE TABLE run_new (...)` with the new kinds, `body`, `hop INTEGER NOT NULL DEFAULT 0`,
   `executing_at`, `lane`, `position` (R3) and the revised CHECK.
3. Disposition per shape, all in one copy statement. No body is invented:
   - queued legacy chat → copied as `cancelled`, `error_code='interrupted'`, error "queued before
     durable intake; the text was never stored", `ended_at=now`. This is the same terminal state
     `recover_runs` writes today, moved earlier so the CHECK holds. The text was already lost when the
     old process died; this only says so.
   - running / cancel_requested (any kind) → copied unchanged, with
     `executing_at = coalesce(started_at, created_at)`. They count as already executed: P1 adopts them
     (if in `keep`) or interrupts them visibly. They are never requeued.
   - every other row → copied unchanged. `hop=0`, `lane` / `position` NULL (legacy order: `ready_at, id`
     as today), `body` NULL, `executing_at` NULL for queued non-chat rows (they have not executed).
4. Drop `run`, rename `run_new`, then recreate every index from the ON-OPEN index list (never the base
   DDL only; the 09-29 stall). `COMMIT`, `PRAGMA foreign_keys=ON`, `foreign_key_check` must return empty.

**Required W0a test** (`schema.rs` tests, temp dir only). Build an OLD-schema file with the exact
pre-rebuild DDL, frozen as a test fixture string at `8290148` (plus a variant with `retry_of` and without
`config`, i.e. a pre-09-27 file). Seed one row per shape: chat × {queued, running in `keep`, running not
kept, cancel_requested, complete, failed, cancelled}; post (old `post:<id>` key) × {queued, running};
reply / schedule / failure_notice queued; an `after_run_id` chain; a `legacy`-set row with NULL
conversation and task; a run with and without `config`. Then `Store::open` and assert:
- open succeeds and is idempotent;
- the row count is unchanged;
- the queued chat row is `cancelled/interrupted`;
- running rows keep status and lease and have `executing_at` set;
- `recover_runs(keep=[kept id])` keeps the adopted one and interrupts the other;
- the old-key post row claims and settles;
- `foreign_key_check` is empty and every on-open index exists.

Mutation checks: drop the `executing_at` backfill (then a W0b requeue test over the migrated file
replays a running row). Drop the queued-chat disposition (then open fails on the CHECK).

**Rollback.** An older build opening a migrated file fails `RunInput::from_columns` on the new kinds,
and it does so loudly (`Corrupt`), not by losing data. W0a writes no new-kind rows while it is dormant,
so rollback is safe until W1 ships.

### R2. Read marks follow completed handling (review 3)

Revision 1 marked `thread_read` when the prompt was composed, and recovery skipped a follow-up when
`thread_read ≥ trigger.ord`. A crash between composing the prompt and `mark_executing` would therefore
silently drop an unanswered post. Revised:
- **The disposition comes from the run, never the cursor.** A follow-up / mention obligation is handled
  exactly when its run is terminal. A queued run, or a running run with `executing_at` NULL, is always
  requeued and re-asked. The "already read → complete" short-circuit is deleted.
- **The cursor is marked in `settle_run`'s transaction.** For mention / follow_up runs, `settle_run` takes
  `read_through` (the highest post ord included in the prompt that run composed, recorded in `run.body`
  at compose time, a side-effect-free write before `executing_at`). The settle and the mark commit
  together, or neither does. The cursor is now only prompt context ("posts since your last read") and an
  unread badge. If it is missing after a crash, the next prompt is longer; correctness does not change.
- **Duplicate-reply defence stays on posts:** `replyOutcome(thread, seat, through)` reads the seat's own
  posts after the trigger. A posted reply proves the obligation was handled; a read cursor does not.

New restart-matrix row (it replaces "gate" in §3):

| Follow-up crash point | Durable state | Boot disposition | Visible result |
|---|---|---|---|
| after compose, before gate answer | run running, `executing_at` NULL, no cursor change | requeue | gate re-asked once, one reply |
| after gate `<yes>`, before `mark_executing` | same | requeue | gate re-asked once, one reply |
| after `mark_executing`, mid-turn | `executing_at` set, journal | adopt (P1) | one reply |
| reply posted, before settle | journal exited, seat post exists | adopt → `after` → `replyOutcome=replied` → settle + cursor | one reply, no notice |
| settled `<no>` | run complete, cursor = through | none | no reply (decided, recorded) |

Test (in `pending-delivery.test.ts`): the fake CLI composes, then blocks inside the gate; SIGKILL; backend
B replies exactly once. Mutation: mark the cursor at compose and reinstate the cursor short-circuit →
the test fails with zero replies.

### R3. Durable queue order, and concurrent picks (reviews 2 and 4)

**Order rule (both carriers).** A conversation's inputs form a LANE with an explicit integer `position`.
`ready_at` and timestamps never decide order inside a lane.
- Crate: `run.lane` is `conv:<conversationId>` for chat runs and `seat:<rootPostId>:<buddyId>` for
  mention / follow_up runs. NULL for every other kind (pool order, unchanged).
  - Partial unique `(lane, position) WHERE status IN ('queued','running','cancel_requested')`.
  - Partial unique `(lane) WHERE status IN ('running','cancel_requested')`: one writer per lane, even
    before a seat's conversation id is bound.
- Records: `conversation_input.position`, as in Revision 1. Lane = the conversation.
- Push back = `max(position over live rows of the lane) + 1`. Push front / promote =
  `min(position over live rows) − 1`. Both are computed inside the write tx. The crate is a single
  writer and records is one connection, so two sends cannot read the same max.
- Requeue (boot, `executing_at` NULL) keeps the row's position. Positions are never reused while
  live, so a promote made during a claim still sorts ahead after requeue. That matches what the owner
  asked for.
- Claim: a lane row is claimable only when it holds the lane's minimum live position. New waiting reason
  `behind_in_lane` goes into `WAITING_REASON_SQL` (the one shared definition, so list and claim agree).
  Promote also sets `ready_at` to the lane's minimum, so it keeps its place in the pool.
- Promote's "interrupt the running turn" stays a server action. After a restart, the interrupted turn
  was adopted or interrupted, and the promoted row is head by position.

Tests:
- (crate) Three chat runs enqueued at one frozen `now` (`claim_run_at`) claim in send order.
- (crate) Promote the third, then reopen the store from disk: the claim order is 3, 1, 2.
- (crate) A requeued head keeps its slot ahead of rows pushed back after it.
- (records) The same three cases over `conversation_input`.
- (e2e, `pending-delivery.test.ts` case 1) Three sends behind a hanging turn, one promoted, SIGKILL:
  backend B runs promoted, 1, 2, each once (the fake CLI log is the oracle).
- Mutation: order by `ready_at` instead of position, and the frozen-clock case fails.

**Concurrent picks (supersedes §7 "they converge; the second opens with the first's config", which
silently discarded a pick).**
- Each accepted pick is persisted on ITS OWN run: `run.config` plus `body.configAuthor` (the post id and
  author). A pick is never merged into another run's.
- The seat generation is resolved AT CLAIM, not at intake. The lane serializes claims, so resolution is
  serialized for free.
  - The claimed run compares its config with the seat's current generation.
  - Equal, or no pick: reuse the seat.
  - Same provider, different model or effort: the existing same-provider reconfiguration (`cc1637b`).
  - Different provider: open generation N+1 with this run's config and bind `conversation_id` (the
    existing bind).
- Two concurrent picks X then Y therefore produce: run 1 opens N+1 on X and replies; run 2 opens N+2 on
  Y and replies. Both picks are honoured in post order, with no conflict error and no silent override.
  The destination stored at intake is the lane (durable). Only the concrete seat id is late-bound, the
  same as request runs today.
- Test (e2e): two posts with different provider chips, written back-to-back. Two seats are created, each
  fake CLI is invoked with its own provider, and there are two replies in post order. Mutation: resolve
  the generation at intake, and the second run runs on X (the test fails).

### R4. Remaining review points

- **Review 5, group requests.** Removed from W0a. The per-recipient key repair, with today's
  one-answer semantics and its first-answer / late-second-answer tests, belongs to
  task_01a0f65c-a0e1-7373-95a8-11001b1f9684. Changing what a group request means publicly needs its
  own owner decision; this design does not make one. W0a keeps `post:<post>` keys unchanged.
- **Review 6, numbers.** In §7, read the 0.2–0.7 ms medians and the ~15 ms sample maximum as
  `enqueue_run` / `post` microbenchmarks on a temp crate store (500 samples × 2). They are not
  end-to-end chat-send latency and not a worst-case bound. Records-store intake is UNMEASURED. W3 must
  measure send→ack p50/p95 through the real WS path before and after, and the §"Revisit if" threshold
  applies to that measurement.
- **Review 6, W5.** Memory-review durability is OUT of this Task. It becomes its own scope decision and
  does not block user-message continuity. The `review` kind is dropped from the CHECK. Adding it later
  costs another rebuild, which is cheap and keeps this proposal minimal.
- **Owner before/after** (internal schema, no MCP/HTTP change):

| | Before (`8290148`) | After |
|---|---|---|
| `run.input_kind` | chat, post, reply, schedule, failure_notice | + mention, follow_up |
| `run` new columns | none | `body` (JSON; required while a chat is queued), `hop` (int, default 0), `executing_at`, `lane`, `position` |
| `run` new indexes | none | live `(lane, position)` unique; running `(lane)` unique |
| crate ops | enqueue, claim, settle(outcome) | + `mark_executing`, `promote_run`; settle takes `read_through` for mention/follow_up; `insert_post` takes required `wakes` |
| boot | `recover_runs(keep)` cancels queued chats, interrupts non-kept running | requeue when `executing_at` NULL; adopt / interrupt otherwise; cancel only body-less queued chats (none after migration) |
| records | schema v2 | v3: `conversation_input` table |

### R5. Waves, revised against P1 (`26d9e28` + `c98b9ce`)

P1's own diff (`git diff main...continuity/ctrl-c-proof`):
- crate: `runs.rs` (the `recover_runs(keep)` hunk only), `node.rs`, `index.d.ts`, `tests/core.rs`,
  `tests/query_plan.rs`;
- server: `buddies/{runner,turn-policy,policy-port,mcp,grants}.ts`, `conversations/runtime.ts`,
  `lifecycle/{shutdown,adopt-executions}.ts`, `turns/{executions,policy,queue,runner,watchdog}.ts`,
  `server.ts`, `turn-attempt-journal.ts`;
- tools: `dev-supervisor.mjs`, `watch-server.mjs`.

It does not touch `schema.rs`, `posts.rs`, `types.rs`, `channels.ts`, `channel-pair.ts`,
`channel-reply-gate.ts` or the records store. Correction to Revision 1: W0a DOES touch `runs.rs` (RUN_COLS,
`run_row`, `WAITING_REASON_SQL`). Those hunks are separate from P1's `recover_runs` hunk, so the overlap
is textual and small, but it is real.

| Wave | Content | Lines (±40%) | Conflicts / order |
|---|---|---|---|
| W0a | crate: run rebuild + R1 migration and test; mention/follow_up kinds; body/hop/executing_at/lane/position; `behind_in_lane`; wakes in `insert_post`; supersede; R3 crate order tests. No key change. | +330 Rust | `schema.rs`/`posts.rs`/`types.rs` free; `runs.rs` (cols, waiting reason) and `query_plan.rs` small overlap with P1 → land AFTER P1 merges (rebasing it is cheap either way). Dormant: the server passes empty wakes. |
| W0b | crate: `mark_executing`, `promote_run`, `recover_runs` requeue rule, settle `read_through` | +90 | `runs.rs` `recover_runs`, `node.rs`, `index.d.ts`: after P1, rebased onto its `keep` signature |
| W1 | channels on runs: planner, mention/follow_up jobs, claim-time seat resolution (R3), gate step before `executing_at`, cursor at settle (R2), `/responding`; delete pair machine, maps, loops | −600 / +320 | `buddies/runner.ts`: after P1 |
| W2 | Buddy chats as bodied lane runs at send; delete ticket, tick, `chats` Map | −200 / +190 | `turn-policy.ts`, `runner.ts`, `runtime.ts`, `turns/queue.ts`: after P1, after W1 |
| W3 | records `conversation_input`; await before ack; hydrate `TurnQueue` from rows (replaces P1's `hasPending()` reload hold); measure send→ack | +260 / −80 | `runtime.ts`, `turns/queue.ts`, `server.ts`, journal: after P1 |
| W4 | shutdown: delete `holdsUnadoptableWork`, P1's `hasPending()` deferral and the reload deferral; docs + `docs/patterns.md#durable-intake` | −90 | `shutdown.ts`, `dev-supervisor.mjs`, `watch-server.mjs`: after W2 + W3 |
| ~~W5~~ | memory review as a run | — | out of scope (R4) |

Nothing lands before P1 merges. W0a is the only wave whose overlap with P1 is a trivial rebase.

### Revisit if (additions)
- A real need appears for multi-answer group requests (owner decision; see R4).
- Claim-time seat resolution shows owner-visible latency for a new-provider seat on a busy pool. Then
  consider resolving at intake while still keeping each pick on its own run.

---

## Revision 3 (2026-10-01): staged rollout, the W0a build must accept normal sends

Author: Buddies Development Lead. Status: PROPOSED (lead recommendation). Still subject to the
CORE_DESIGN.md owner schema review; Product's positive design review does not replace it.
Trigger: Product Development Lead review of Revision 2, request `post_01a0f80e-5107-743c-aaf4-0e64828e4454`.
Design text above (Revisions 1 and 2) at sha256 prefix `824750b009b15aec`, computed just before this
append; the file is uncommitted. Revisions 1 and 2 stay as history; where this section disagrees, it wins.

### The defect (accepted)

Revision 2 called W0a "dormant until W2", but its CHECK
`input_kind <> 'chat' OR status <> 'queued' OR body IS NOT NULL` applies to EVERY new insert. The only
chat producer in the W0a build is today's `admitChatRun` (`turn-policy.ts`, the `enqueueChat` call),
which goes through `policy-port.ts enqueueChat` to `runner.ts enqueueChat` and inserts
`{kind:'chat', turnId}` with no body, status `queued`. So on the W0a build every Buddy DM, Wake, owner
message in a seat and worker-thread message fails at intake. The seeded-old-rows test could not see it:
it opens a migrated file but never sends through the intermediate server.

A second instance of the same class, found while fixing the first: W0a adds `executing_at`, but nothing
in the W0a build sets it on new claims. Running rows created by the W0a build would carry
`executing_at NULL`, and W0b's boot rule "`executing_at` NULL → requeue" would REPLAY them (the August
rule forbids this). The migration backfill only covers rows that existed at migration time.

### Decision: producers satisfy each invariant from the first build that has the column

Not "gate the constraint until W2". A CHECK cannot be added later without another `run` rebuild (STRICT
`CHECK` is not ALTERable), and a dormant flag would be a second, unconstrained state the core has to
reason about. Instead W0a carries the minimal compatible producer change, so schema and producer
activate together:

1. **Body at intake (W0a).** `enqueueChat` takes the queue-head `TurnInput` it already holds in
   `gate()` and writes it as `body` (the W2 body schema: `messageId`, `prompt`, `origin`, `inputId`,
   whatever of these the head input carries; W2 may add fields, the CHECK only needs non-NULL). Three
   call sites change (turn-policy → policy-port → runner) plus the crate's `EnqueueInput`. In the crate
   the chat variant's `body` is a required field of the type, so a body-less chat enqueue does not
   compile; the SQL CHECK is the backstop for SQL paths. No consumer reads `body` until W2: it is
   written, cleared at settle, and otherwise inert. W0a no longer claims to be server-free.
2. **`executing_at` at claim (W0a).** Until W0b, `claim` sets `executing_at = started_at` for every
   kind. That is today's semantics stated in data: a claim is followed by a spawn with no side-effect-free
   step in between, so a claimed run counts as executed and is never requeued. W0b then moves the stamp
   from claim to `mark_executing` only for kinds that gain a pre-spawn step (mention/follow_up gate,
   compose). Every build in the sequence therefore leaves running rows that the next build's boot rule
   classifies correctly.
3. **Still dormant in W0a:** the `mention`/`follow_up` kinds, `hop`, `lane`/`position` (NULL lane is
   outside both partial unique indexes), `behind_in_lane`. Nothing in the W0a build writes them.

Rollback stays safe: an older build reads named columns and ignores `body`/`executing_at`; it fails
loudly only on the new kinds, which the W0a build never writes.

### Required tests for the intermediate build (in addition to Revision 2's migration test)

Run on the W0a COMMIT, temp stores and fake CLIs only:
- **Normal sends on the W0a build** (`server/test`, real backend path like `execution-adoption.test.ts`):
  a Buddy DM, a Wake and an owner message in a seat each create a chat run with non-NULL `body`, are
  claimed (`executing_at` set), run, settle `complete` with `body` cleared, and the reply lands.
  Include a slot-wait case (pool of 5 full): the sixth chat sits `queued` with its body and runs once a
  slot frees.
- **Upgrade then send:** a store written by the pre-W0a build (fixture DDL at the P1-merged main) with a
  queued chat waiting for a slot and a running adoptable chat; open with the W0a build; the queued one is
  `cancelled/interrupted` per R1, the running one is adopted, and a NEW send on the W0a build succeeds.
- **W0a → W0b boot:** a running chat created by the W0a build, backend SIGKILLed, booted on the W0b build:
  adopted or interrupted, never requeued (fake CLI log shows one invocation).
- **Mutations:** (a) drop `body` from `enqueueChat` (via a test-only bypass of the typed API): the
  normal-send test fails with the CHECK error, proving the test exercises the constraint. (b) drop the
  `executing_at` stamp from claim: the W0a → W0b boot test replays the turn.
- `pnpm test:server` green on the W0a commit apart from known main failures.

### Waves, corrected

| Wave | Change from Revision 2 |
|---|---|
| W0a | + `enqueueChat` writes `body` (3 server call sites, crate type); + claim stamps `executing_at`; + the intermediate-build tests above. ~+60 lines over Revision 2's estimate. Lands after P1 (unchanged). |
| W0b | `mark_executing` replaces the claim stamp only for kinds with a pre-spawn step. |
| W2 | first CONSUMER of `body` (reads the text from the run); the producer already exists. |

Revisit if: a future wave adds a column with a CHECK or a boot rule that reads it. The same rule
applies: the first build that has the column must write it on every producer path, with an
intermediate-build send test.

## Revision 4 (2026-10-05): drop `hop`; exact before/after for the owner's schema review

Author: Buddies Development Lead. Status: PROPOSED, awaiting the CORE_DESIGN.md owner schema review.
Revisions 1–3 above are at sha256 prefix `20d8066821b90980` (file uncommitted), computed just before this append.
Trigger: owner asked "Whats left here? Can we complete it" (post_01a10bca-e0b4-76f8-9747-716141747264);
PDL completion request post_01a10bcc-901d-755c-928d-3391c7f64f39. A general completion request is not
approval of this schema, so it goes to the owner as an explicit before/after.

**What changed since Revision 3.** Owner preference 2026-10-03 (#bugfixes): Buddy-to-Buddy conversations
continue with no arbitrary hop cap. Main no longer has a seat-hop cap (`git grep -i 'seatHops|MAX_HOP'`
at 235fc41: no hits). The `hop` column existed only to replace `seatHops` and enforce `hop < 3`, so it and
`PostWrite.capped` are dropped. Everything else in Revisions 2–3 still holds; P1 is now merged with main as
`continuity/p1-state-main` @ 3a21efd, so W0a's "lands after P1" precondition is about to be met.

**Exact before/after (internal schema; no MCP tool or HTTP change):**

| | Before (main 235fc41 + P1) | After W0a–W3 |
|---|---|---|
| crate `run.input_kind` | chat, post, reply, schedule, failure_notice | + mention, follow_up |
| crate `run` columns | (none added) | `body` JSON (non-NULL while a chat is queued/running; cleared at settle), `executing_at`, `lane`, `position` |
| crate `run` indexes | — | unique live `(lane, position)`; unique running `(lane)` |
| crate migration | — | one `run` table rebuild on open (STRICT CHECK is not ALTERable); R1 disposition of legacy queued chats |
| crate ops | enqueue, claim, settle | + `mark_executing`, `promote_run`; settle takes `read_through`; `insert_post` takes required `wakes` |
| boot | recover_runs(keep) cancels queued chats | requeue when `executing_at` NULL; adopt/interrupt otherwise |
| records (ingest) | schema v2 | v3: `conversation_input` table (ordinary chats + Builder pending inputs) |
| deleted (W1–W4) | in-memory pair machine, chat ticket/tick, `chats` Map, `hasPending()` reload hold | — |

Revisit if: the owner rejects a durable records-store table for ordinary chats (then W3 is replaced by
holding the reload while a chat queue is non-empty, which is today's behaviour and loses input on crash).

## Revision 5 (2026-10-05): build starts; the live migration keeps its own gate

Author: Buddies Development Lead. Status: BUILD ACCEPTED by owner instruction; live activation still gated.
File before this append: sha256 `ce59e1e328dc69bb844298752b25205a0a5ec8113992607851b57c6d766f19d6` (uncommitted).

**Trigger.** Owner, #buddies-dev thread post_01a10bca-e0b4-76f8-9747-716141747264, 2026-10-05, replying to the
lead's status post (post_01a10bdc-a00a) that named the schema review as the one open owner decision:
"close out and implient all posible work".

**Reading (lead's interpretation, not a verbatim "approve").** The owner wants the whole continuity Task finished.
Building Revisions 2–4 in full (option 1, including the records `conversation_input` table) on a branch has no
effect on live stores, so it starts now. The one irreversible step is the live migration: merging the crate
`run` rebuild and records v3 into main reloads the live backend, which then migrates `~/.buddies/buddies-v3.sqlite`
and the records store in place, and an older build cannot reopen them. That step gets a one-word confirmation
when the integrated branch is green, with the evidence in hand. The non-schema pieces (copied-store guard,
outage tool delivery) merge to local main when green under the same "close out" instruction. Never pushed.

**Alternatives.** (a) Treat the message as full approval including the live migration: rejected, the owner's
DM question (post_01a10bcf-7055) is still unanswered and the migration is one-way. (b) Keep waiting for the
DM answer before building: rejected, it contradicts "implement all possible work" and building is risk-free.

Revisit if: the owner answers the DM with "approve without the chats table" (drop W3, keep the reload hold)
or "hold" (stop the worker; branch stays).

## Revision 6 (2026-10-05): owner approves merging, migration included

Decision-maker: Owner. Status: ACCEPTED. File before this append: sha256 prefix `c097b36e19c79d04` (uncommitted).
Owner, #buddies-dev thread post_01a10bca-e0b4-76f8-9747-716141747264, 2026-10-05, after reading the lead's reply
(post_01a10bdf-7249), which said the live migration would wait for a one-word "go" and offered "without chats" or "hold":
"okay commit merge and coplete al work".

The lead reads this as the "go" that Revision 5 reserved. The reply came after the gate and the alternatives were
named, and it says "merge". So the full design, chats table included, merges to local main once the integrated
branch is green. That merge migrates the live stores when the watcher reloads at an idle boundary. The green bar is
unchanged: the Revision 5 integration gates plus the combined close test. If they fail, nothing merges and the lead
reports. Main is never pushed.
Revisit if: the integration gates fail, or a wave needs a schema change beyond the Revision 4 table.

## 2026-10-05 successor: owner asked "can we not migrate the current DB?" (lead recommendation, PROPOSED)

- Context: owner direction to merge and push for launch (#general thread post_01a10b92-ac79-73f7-9509-523b6fd094e9, launch integration task_01a10beb-c8be-742f-8bf0-010f4ed8c22d). Durable pending was excluded from that push.
- Clarified to owner: the plan always migrated the live DB in place (Revision 2, one transaction in `open()`). The "separate go" was about rollback. After migration, an older build refuses the DB (schema-version ceiling), so a post-launch rollback needs the pre-migration file.
- Lead added a requirement, sent to worker run run_01a10bdf-377f-7784-b491-a70db9739fe4 (post_01a10bfa-a8ad-705c-a8e7-55b6c80bfa6f): before its first write, the migration leaves a timestamped, schema-versioned copy of the DB file next to it and logs it, with a test that the copy opens at the old version.
- Status at 12:12Z: implementation in progress in ~/git/_wt/durable-pending (feat/durable-pending, 19 uncommitted files, nothing committed). Not ready for the launch push.
- Lead recommendation (not owner-accepted): launch without it and ship it right after, because a schema change hours before launch is the riskiest addition. Asked the owner whether it can merge as soon as tests pass, backup included, without a further check (post_01a10bfa-d042-7002-af9a-c2ee4d16f9aa). Pending answer.
- Revisit if: the owner holds launch for it, or the worker finds the migration can't be made idempotent/backup-safe.
- 2026-10-05 ~12:15Z: owner ACCEPTED. Asked whether durable pending could merge once its tests pass, backup included, without a further check, the owner replied "yea fully implement yes" (#general thread post_01a10b92-ac79-73f7-9509-523b6fd094e9). Interpretation: full scope (chat, DM, @mention, follow-up, Buddy request) plus the in-place live-DB migration with automatic pre-migration backup; merge and push on green, sequenced after the launch integration push so main has one writer. Worker notified (post in run run_01a10bdf thread); the worker commits to the branch only, and Release Engineer does the merge.

## Revision 7 (2026-10-05/06): W0b landed; W1 must cover two causes main added (worker, PROPOSED)

Author: worker run for the lead (Opus), request post_01a10cf8-96a5-7785-b5ad-6a87c71bee65. Status: PROPOSED.
File before this append: sha256 prefix `bb88c324f21ed222`. Branch `feat/durable-pending`.

**Landed.** `745515f` W0b: the claim no longer stamps `executing_at`; holders call `mark_executing` as the
last await before the spawn (runner chat admission + job path); the claim gate requeues a running run with
`executing_at` NULL (keeps lane position) and still ends executed ones through `end_run`. Lanes for chat runs
(`conv:<id>`, back/front placement), `promote_run`, `release_run` (unexecuted reply back to the queue bound
to its busy seat), settle of a complete mention/follow_up marks `thread_read` (R2). Two corrections made while
reviewing the uncommitted draft: the requeue UPDATE repeats `run_lease`'s partial-index condition (query-plan
guard), and a second bare UPDATE ending unexecuted `cancel_requested` runs was dropped because it skipped
`after_settle` (the 2026-10-01 bug class). `mark_executing` refuses a mention/follow_up without
`read_through`, so a W1 job that forgets it fails at mark time, not as a Corrupt settle.
`9acd4bd` pre-migration copy: `VACUUM INTO <db>.before-durable-intake.run-v1.<UTC>.sqlite` before the
rebuild's first write, logged; a failed copy fails the open (nothing migrates without its way back).
`017160e` merge of origin/main 551feb9; `d42e0ec` main's new tests pass `wakes: []`.

**Gap found for W1 (design says mention | follow_up only).** On main `channels.ts` has four causes:
`mention`, `follow_up`, `direct` (owner's plain post in a DM wakes the DM's Buddies, added 2026-09-30) and
`retry` (owner reruns a failed reply on a chosen harness, key `retry:<failedPostId>`); task-channel comments
also wake by mention. Proposal: `direct` and task mentions are intake `WakeKind::Mention` (same must-answer
semantics, written in the post's tx by `planWakes`); `retry` is NOT a post wake but an owner action, so it
needs its own enqueue op and a key that is not `mention:<post>:<buddy>` (that key's run is already terminal
for the original trigger and must not be confused with the rerun). Engineer to confirm whether the crate
derives `input_key` from `RunInput` alone; if so, `retry` needs either a `retry` kind (another `run`
rebuild, cheap only BEFORE this branch merges) or a key field on the enqueue. Decide before W1 code: adding
the kind now costs nothing; after merge it is a second migration.

Revisit if: the lead prefers keeping `retry` off runs (then a retry lost at restart is acceptable, as today).

## Revision 8 (2026-10-05): retry kind landed; main's `follow` kind folded into the one rebuild; W1 seam map (worker, PROPOSED)

Author: worker run for the lead (Opus), request post_01a10d59-452c-73c0-815e-8a87afa98f41 (resume of
post_01a10d44-4961-7421-8a67-88632c8712e0). Status: PROPOSED. File before this append: sha256 prefix
`5903cbce7c4ad43c`. Branch `feat/durable-pending`.

**Landed.**
- `58982f4`: the `retry` run kind (Revision 7's open choice, decided "add it before merge": no second
  rebuild later). `enqueue_retry(actor, notice_id, config)` requires a `reply_failed` post by a buddy,
  queues in the notice's seat lane `seat:<root>:<buddy>` (back), key `retry:<notice>`; a double click
  returns the live run. `thread_read_through(reader, root)` exposes the R2 cursor for resumed-seat
  prompts. This finished the killed run's uncommitted edits. Correction to its test: posting the notice
  already follows the thread (posts.rs `follow`), so the cursor is at the notice before the retry; the
  test now asserts it moves past a later post only at settle (R2), not at `mark_executing`.
- `c0fb42d`: merge of origin/main `db82ba6`. Main had added thread follows: a `follow` run kind and
  `widen_run_input_kind`, a SECOND run-table rebuild keyed on `'follow'`. Resolution: one migration.
  `rebuild_run` (keyed on `'mention'`) copies the same v1 columns from files with or without `'follow'`,
  so it replaces `widen_run_input_kind`. `RUN_TABLE`'s CHECK names `follow`, and `RUN_INDEXES` gains
  `run_follow_queued`. The durable_intake rebuild test gained a `follow` variant (the live store's
  shape after a thread-follow build opened it, with a queued follow row) in place of main's widen test.
  Retry runs list the owner as requester.
- Gates on `c0fb42d`: buddies crate 9+44+10+1+7 pass, ingest crate pass, `pnpm typecheck` clean (with
  the submodule synced to the merged pointer 7a41287), targeted server files buddies-v2 + channel-pair +
  run-lease 57/58. The one failure, "a failed gate on an owner post is shown", passed alone (1.7 s). It
  is a timing test (400 ms sleep) run under load from parallel workers. No full test:server (brief).

**W1 seam map (read on c0fb42d; for the next run, so it starts coding).**
- Producers: exactly three server post writes pass `wakes: []`: `routes.ts:163` (owner),
  `mcp.ts:429` (buddy) and `channels.ts:450` (failure notice, which must never wake). W1 is a
  `planWakes(channel, post-draft, picks)` called at the first two. It must return `Mention` for
  @mentions (public/task) and for the owner's plain DM post (`direct`, same must-answer semantics as
  Revision 7), and `FollowUp` for thread participants minus author, mentioned and delivering
  followers. Picks (the owner's chip choice) become `Wake.config`. The crate already refuses
  inactive, foreign and self wakes, and supersedes a queued follow_up in the lane.
- **Design question to decide before coding (lead):** `planWakes` needs thread participants and
  `deliveringFollowers` BEFORE the post exists. Option A, the server plans: two awaits before the
  write, racy against a concurrent post in the same thread, which only affects follow_up targeting.
  Option B, the crate derives follow_up wakes inside `insert_post`: it already holds the thread and
  `follows`, so this is one transaction with no race, and the server plans only mentions/direct/picks.
  Recommendation: B. It is the one-write-path pattern, and it deletes `followUps()` outright.
- Consumers: `runner.ts` `jobFor` throws for `mention|follow_up|retry` today. W1 adds one job per
  kind, all going through the existing `runReply`/`seatPrompt` body (Reply built from the run's post),
  with `mark_executing(read_through = composed.through)` as the last await before
  `sendSessionRelativeMessage`. The follow_up job runs the gate first: `pass` → settle cancelled,
  `failed` → `postFailure` + settle; `respond` → mark + send. `seatPrompt`'s resumed-delta mark comes
  from `core.threadReadThrough`, not `pairs`.
- Deleted by W1: `PairEntry`, the `pairs` Map, `apply`, `channel-pair.ts` (`step`/`idlePair`), the
  events listener's `wake`/`followUps` calls, and the `channel-pair.test.ts` interleaving test, whose
  invariant moves to the crate lane tests. `/responding` reads live/queued runs by lane `seat:%`.
- Retry route: the current `retry` cause → `core.enqueueRetry`.

Revisit if: Option B is rejected, or the gate step cannot run inside a claimed run without holding
the seat's lane past the chat deadline (gate latency counts against `chat_deadline_ms`).

## Revision 9 (2026-10-06): W1 seam: the crate derives follow_up wakes (Option B), lead decision

Decision-maker: Buddies Development Lead (internal architecture; no schema or public-surface change, so not an
owner gate). Status: ACCEPTED. File before this append: sha256 prefix `38f6fca54f065567` (branch @ c0fb42d).

**Question (Revision 8):** `planWakes` needs thread participants and delivering followers before the post exists.
A: the server looks them up before the write. B: the crate derives follow_up wakes inside `insert_post`.

**Choice: B.** The crate already holds the thread and `follows` in the write transaction, so targeting is atomic
with the post. A has two awaits before the write and races a concurrent post in the same thread, and that race
silently mis-targets follow-ups. B is the one-write-path pattern (docs/patterns.md) and deletes `followUps()`
outright. The server plans only what it alone knows: mentions, the owner's direct-DM must-answer, and picks
(the chip config).
**Tradeoff accepted:** more logic in the crate, so follow-up rules change in Rust (rebuild) instead of TS.
**Revisit if:** follow-up targeting needs server-only state (e.g. live presence) that the crate can't see.

## Revision 10 (2026-10-06): W1 status; two findings that need a decision (worker, PROPOSED)

Author: worker run for the lead (Opus), request post_01a10d95-b9de-74c7-903c-908e0accf712. Status: PROPOSED.
File before this append: sha256 prefix `568589c9681b98e5`. Branches: `feat/durable-pending` @ `2cb2549`
(landing commit), `feat/durable-pending-w1-wip` @ `4c22edc` (NOT landing; 2 commits on top of `2cb2549`).

**Landed (`2cb2549`).** The crate derives follow_up wakes in `insert_post` (Revision 9, Option B).
`Wake` lost its `kind`: a host-planned wake is always must-answer (`mention` run), so a host cannot plan
a follow-up. `follow_up_targets` (posts.rs) carries the reasoning comment. Rule, unchanged from
`followUps()`: public/task replies only; participants = buddy authors of the thread (failure notices
excluded) + buddies with a live run in a seat lane of the thread; minus author, this post's
must-answer wakes, inactive buddies and delivering followers. Gates: crate 9+44+11+1+7 pass (new
`a_thread_reply_derives_follow_ups_for_participants_only`), `pnpm typecheck` clean. Between this commit
and the consumer, a follow_up run fails at claim ("no job handles"), so do not ship `2cb2549` alone.

**WIP (`6eb8d1f`, `4c22edc`).** Producers (`planWakes` at routes/mcp/upstream), runner `SeatJobs`
(one job per seat kind, `afterFor`/`failedFor` re-derived from the run, busy seat → `release_run`,
`mark_executing` last await with the reasoning comment), `runCoordinationMessage(prompt, input, …)` so
seat turns keep B1 authority and their thread audience, retry → `enqueueRetry`, `/responding` from live
seat runs, and the deletions (`channel-pair.ts`, `pairs`, `apply`, `followUps`, `wake`, `directPost`,
`untilIdle`, `channel-pair.test.ts`). Typecheck clean; run-lease 2/2; buddies-v2 50/55.

**Finding 1 (blocks 4 tests: 13, 14, 15, 43): a "default model" chip pick cannot ride a run.**
`RunConfig.model` is required, so `runConfigOf` resolves "default" against today's catalog and the seat
records an explicit model (`claude-opus-5-5 · medium`) where the owner chose "default". Options:
(a) `RunConfig.model` optional (absent = provider default), a crate type change before merge;
(b) `Wake.config` carries the `ConversationConfig` verbatim as JSON (pass-through rule in AGENTS.md).
Recommendation: (a), since it keeps one run config type. Needs a lead decision.

**Finding 2 (blocks test 11, a real bug): posting moves the author's read cursor past unseen posts.**
posts.rs `follow` marks `thread_read` through the author's own post. A seat turn composed before P2/P3
arrived posts its reply after them, so the cursor jumps past P2/P3. Then the next resumed prompt omits
them, and a follow_up for P3 settles "already read" though the seat never saw P3. The pair machine
never had this: its mark came only from the prompt's `through`. Proposed fix: do not move the reader's
`thread_read` when a post comes from a seat conversation with a live seat run. Alternatively, keep the
R2 settle mark as the only seat cursor in a separate column. To decide with R2's owner.

Revisit if: either finding's fix changes the crate schema (then it must go into the one rebuild before merge).

## Successor 2026-10-06 ~07:05Z: proposal to fold into the delivery-model design (lead, PROPOSED)

File before this append: sha256 prefix `fcb6029ebb00c777`. The owner asked in #case-studies (thread post_01a10e04) whether durable
pending belongs in the delivery-model line of work.

**Recommendation:** fold it in.
- **Keep** W0a/W0b, the backup, and Rev 9's Option B (wakes derived inside `insert_post`).
- **Replace** W1's `mention`/`follow_up`/`retry` kinds, the lanes, and the gate step with the delivery design's
  single `deliver` kind keyed by `conversation_id`.
- **Ship** both as ONE `run` rebuild and ONE live migration.
- **Rev 10's two findings** become decision J (optional `model` = provider default, resolved and recorded at claim) and
  decision K (posting never moves the author's mark past posts it was not shown).

Full comparison: `agent_notes/2026-10-06_buddies-target-system-review.md` §7, decisions H/H2/J/K. No worker was running on
this branch at the time; branches `feat/durable-pending` @ 2cb2549 and `-w1-wip` @ 4c22edc are untouched.

The owner's approvals of the schema (Rev 6) and of full implementation stand as history. They do not decide the fold, and
the owner has not answered it yet.
