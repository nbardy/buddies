# Code patterns

These are the structural patterns this codebase is being rebuilt around (lean rewrite, 2026-09-25). Each one
replaced measured bloat or a measured slowdown. Use them for new code, and keep them intact when you change code.

**Tagging rule.** Code that implements a pattern carries a one-line tag at the definition site:

```ts
// Pattern: one-write-path (docs/patterns.md#one-write-path)
```

(Rust uses `//` or `//!` the same way.) The tag says which invariant the code keeps. A reason comment explains why
this spot exists. Before changing tagged code, read the pattern here. If you must break a pattern, update this file
and the tag in the same commit and give the reason.

Find the implementations with `rg -n "Pattern: <name>"`.

---

## one-store-one-index
**Smell:** many hand-written views, each scanning all the data on every change.
**Pattern:** one normalized store (rows by id) plus ONE derived index, computed in a single pass. The index's
fields keep their identity when their content is unchanged. Per-id cursors (families) serve single-item views.
Updates cost what changed, not n.
**Here:** `client/src/atoms/conversation-index.ts` (about 10 full passes per event became one index).

## sum-types
**Smell:** nullable field bags, and "what kind / which provider is this?" checks inside core logic.
**Pattern:** the kinds are a sum type, fixed once at the boundary. One thin exhaustive dispatcher picks a handler,
and each handler has one clean path with no structural branching (see ~/.claude/CLAUDE.md "One Clean Path").
**Here:** `ConversationKindSchema` (chat | buddy | builder | worker, `shared/src/conversation-config.ts`) and its
list projection `RowKind`; crate `types.rs` (`ChannelKind`, `RequestState`, `RunInput`, `RunWaiting`); `McpServerSpec {kind:'stdio'|'http'}` in
agent-cli; the conversation's `TurnPolicy`, chosen once by kind (`policyFor` in `conversations/runtime.ts`:
`ChatTurnPolicy` / `BuddyTurnPolicy` / `BuddyBuilderTurnPolicy`).

## parse-dont-validate
**Smell:** the same validation repeated at every layer.
**Pattern:** canonicalize raw input once at the boundary into canonical types. After that, the core trusts the types,
with no re-checks and no silent fallbacks (a typed error or a typed "unknown" variant instead).

## capability-grants
**Smell:** the same permission check in N places (`send` was checked in 7+).
**Pattern:** authorize once and pass a capability object (e.g. `TurnGrant`) that carries the decision. There is one
`authorize(actor, op, subject)` rule and no second copy of it.
**Here:** crate `store.rs` `authorize`; `server/src/buddies/grants.ts` (T11).

## table-driven
**Smell:** long if/switch ladders keyed by name (tools, routes, harness features).
**Pattern:** a table of `{name, schema, handler}` rows plus one generic loop. Adding a case means adding a row.
**Here:** the MCP tool table (T11: 47 tools → 12, with task comments and answers folded into `post`); agent-cli `mcp-encoding.ts` (one handler per harness per
kind); `SUB_AGENT_FOLDS` in `server/src/turns/subagents.ts` (codex collab threads vs the generic Task fold).

## pure-core
**Smell:** logic interleaved with I/O and timers, so tests need heavy mocks.
**Pattern:** state machines are pure functions `(state, event) → (state, effects)`. I/O lives at the edges.
Test the core directly and the shell with one integration test.
**Here:** `TurnQueue` in `server/src/turns/queue.ts` (T08): transitions with no I/O, timers or broadcasts; the
conversation applies the effects.

## one-write-path
**Smell:** one mutation method or one table per variant of the same thing.
**Pattern:** one append/write path for a concept, with read models derived from it.
**Here:** crate `posts.rs`, where every DM, channel post, reply, request answer and task comment is a `post` in a channel; the MCP exposes those through one `post` tool; `records/store.rs` `put`, the one write of a conversation record and its session index. Ingest crate
`store.rs` `Writer::apply`: transcripts are parsed once, and the usage/cost numbers (`usage_turn`) and the context
meter (`session.context`) are read models of that one ingest. The server reads them through
`server/src/ingest/instance.ts` (`/api/usage` in `usage-routes.ts`, the meter in `session-context.ts`);
their own transcript parsers (1,209 lines) were deleted in T13b.
The conversation list and every message history are read models of the same store:
`server/src/ingest/conversation-list.ts` joins records with `listSessions` rows and serves pages from
`Ingest.messages` merged with the runtime's live-turn overlay; `onChange` becomes field patches (T13b S1/S2).
The TS transcript parsers, session cache and 5 s poller (`server/src/adapters/*`, ~5,000 lines) were deleted.

## idempotency-keys
**Smell:** ad-hoc dedupe, retry flags, "did we already do this?" queries.
**Pattern:** every externally triggered mutation carries a key, unique per actor and scope, recorded once in the event log.
A replay returns the original result.
**Here:** crate `store.rs` event log (`idem_key`).

## wake-on-write
**Smell:** one timer per entity, or fast polling of state that changes rarely.
**Pattern:** wake the worker when the thing it waits for is written (enqueue, settle, file change), plus ONE slow
backstop tick. Shared clocks run only while someone subscribes.
**Here:** `client/src/hooks/useTimeTick.ts` (8 intervals → 1); Buddy runner (T11); the shared chat-admission tick
(`buddies/turn-policy.ts`); `SwarmObservers` in `server/src/swarm/observer.ts` (one async poller per folder, only
while a turn runs there, replacing one blocking 2 s poller per running conversation). Ingest crate `watch.rs` +
`filewatch.rs`: FSEvents for discovery, a kqueue watch on each file that is being written, and a batch that closes
2 ms after its last event (was a fixed 50 ms window: append → onChange p50 68 ms → 4–6 ms). The 10-minute rescan is
the backstop.

## patches-not-snapshots
**Smell:** resending whole objects on small changes (5 MB on "mark done").
**Pattern:** send field patches, and apply them with structural sharing so unchanged parts keep their identity.
List payloads carry summary rows; bodies load on demand.
**Here:** `RowPatchSchema` / `applyRowPatch` / `applyDetailPatch` in `shared/src/conversation.ts`;
`handlePatch` in `client/src/atoms/actions.ts`; the tail-only transcript refresh (`refreshTranscript`);
T05's tail-only stream regroup. Guard: `server/test/wire-v3.test.ts`.
A field a patch moves must not also sit in a server-side row cache that a later `hello` re-serves:
the hello then contradicts the patch and nothing corrects it. `ListedRow` in
`server/src/ingest/conversation-list.ts` omits `run` for this reason (stale "running" native
children, 2026-10-01). Guard: `server/test/ingest-list.test.ts` "a hello after the quiet backstop…".

## ordered-ids
**Smell:** ordering rows by a timestamp, with a random id as the tie-break: rows written in the same millisecond read
back shuffled.
**Pattern:** ids are time-ordered UUIDv7 (RFC 9562) from ONE monotonic generator per process (a counter within the
millisecond), and reads order by the id, never by timestamp ties. Timestamps stay the true write time. Rows that must
keep an older id carry the ordered id in a separate column assigned in their original write order.
**Here:** `crates/unleashd-buddies/src/ids.rs`; `post.ord` (threads, pages, read cursors), run ids (claim FIFO).
29 of 50 back-to-back threads came back shuffled before (2026-09-25).

## one-type-source
**Smell:** the same type hand-copied in several layers, drifting apart.
**Pattern:** one definition plus codegen or inference (napi-generated `index.d.ts`, Zod-inferred TS types).
**Here:** `crates/unleashd-buddies/index.d.ts`, generated from the Rust.

## one-definition
**Smell:** the same helper, regex or constant pasted inline in many files.
**Pattern:** one named definition, imported everywhere.
**Here:** `shortenHomePath` in `client/src/utils/directories.ts` (it was inline in 13 files).
The Buddy run queue's `WAITING_REASON_SQL` in `crates/unleashd-buddies/src/runs.rs` is both the
list reason and the claim predicate (`reason IS NULL`), so an observation cannot drift from admission.

## deep-modules
**Smell:** wrappers, relays and adapters that only forward calls.
**Pattern:** few modules with small interfaces that hide real work. Delete pass-through layers.
**Here:** the `owner-mcp.ts` relay and the `ProviderEvent` re-typing layer were deleted (T11/T08).

## quarantine
**Smell:** an optional feature's imports spread through the core, so removing it later means an archaeology dig.
**Pattern:** the feature lives in one folder with ONE entry module. Code outside the folder imports only that
entry, from a fixed list of files that a guard test pins; on the client every entry export is lazy, so core chunks
carry none of its code or CSS. Deleting the feature = delete the folder + the call sites of the entry.
**Here:** swarm/oompa (T10): `server/src/swarm/index.ts`, `client/src/swarm/index.ts`; guards
`server/test/swarm-quarantine.test.ts`, `client/test/swarm-quarantine.test.ts`.

## delete-and-migrate
**Smell:** compatibility shims, permanent flags, migration chains (33 schema versions).
**Pattern:** a one-time export into a clean shape, with zero-loss verification (counts plus content hashes). Then
delete the old path entirely.
**Here:** the Buddies v33 → v3 importer/verifier (`crates/unleashd-buddies-import`), the config JSON → records
store import (`crates/unleashd-records-tool`) and `record-migration.ts` ran once in the 2026-09-27 swap and were
deleted after it (last at 03fc931; runbook agent_notes/2026-09-25_lean-rewrite/T15-RUNBOOK.md). The server keeps
only a guard: it refuses to start on an unimported legacy data dir instead of creating an empty store over it.

## build-cache
**Smell:** every worktree cold-builds the Rust addons (~30 s each, three cores) though it never touched Rust, and an
edit to a one-time tool rebuilds the shipped addon it happens to live in.
**Pattern:** key each build output by a content hash of exactly its inputs, keep the outputs in one cache shared by
every checkout, and publish into the cache by an atomic rename under a per-key lock. A hit copies files and never
starts the compiler. Code that is not shipped lives in its own build unit, so editing it changes no shipped key.
**Here:** `tools/ensure-addons.mjs` (key: the crate's `src/**`, `build.rs`, `Cargo.toml`, `package.json`, its
reachable `Cargo.lock` entries, `rustc -vV`; cache `$UNLEASHD_ADDON_CACHE`); called by `pnpm run bootstrap`, the dev /
build tasks, `test:server` and the dev watcher on a saved `.rs`. One-time tools get their own crates for the same reason. Guards: `tools/ensure-addons.test.mjs` (a TS or tool-crate edit keeps the key;
a hit never spawns), `tools/watch-server.test.mjs` (a tool-crate save builds nothing). S12, 2026-09-26.

## tokens-and-shells
**Smell:** per-screen CSS values (45 font sizes, 172 paddings) and a copy of every screen per device.
**Pattern:** design tokens, then a few primitives, then views, then two thin device shells over the same views.
**Here:** `client/src/ui/tokens.css` (layer 1: `--fs-1…9` type, `--sp-1…11` spacing; the only file
allowed a px font-size/padding/gap) and `client/src/ui/primitives.css` (layer 2: `.ui-stack`, `.ui-row`,
`.ui-inline-row`, `.ui-truncate`, `.ui-card`, `.ui-muted`), T21a. Gates G7 (no literal px, breakpoints only
768px/340px) and G8 (total CSS lines never grow) in `tools/check-client-invariants.sh`. Views and shells: T20/T21.

## route-at-send
**Smell:** work is queued first and its kind is discovered after it is claimed ("is the origin a human
chat? then there was nothing to do"). The queue's gates (busy conversation, pool cap) then hold rows that
were never work, and anyone reading the queue sees them as blocked.
**Pattern:** decide where a result goes from stable data stored before it is produced, and let one rule
read that data. Downstream code never re-derives the route; a post that reaches nobody queues nothing.
**Here (since 2026-10-06, owner decisions A–K; agent_notes/2026-10-06_buddies-target-system-review.md):
one delivery rule.** A Buddy's `thread_read` row is its read mark in a thread AND, when
`conversation_id` is set, the conversation SUBSCRIBED to it (one per Buddy and thread; the last writer
wins, decision F). A conversation subscribes when it posts in a DIRECT thread (a request included), when
it is opened for a request or a DM delivery (`bind_run`), or by `channel_read {follow}`. Posting in a
public or task thread subscribes nothing, and a seat opened there is bound but not subscribed (owner
decision 2026-10-07, reverting step 5's "every channel"), so a thread's deliveries go to the Buddy's
thread seat, never to whichever conversation wrote last. Every post by someone
else in the thread becomes a durable `deliver` run for that conversation, in the post's own transaction
(crate `deliveries.rs` `fan_out`, called from `posts.rs` `after_write`). An @mention, a task-comment
mention and the owner's plain post in a DM are deliveries too (`PostInput.mentions`, crate `wake`, host
`mentions.ts wakes`): to the Buddy's subscription, or with none to a run with no conversation, for which
the runner opens the Buddy's SEAT (`channels.ts openSeat`, same ids as before) when it claims it. An
owner's chip pick or a retry's model rides the run's config and applies to the seat, never to a chat that
merely follows the thread. Step 5 (2026-10-06) deleted the host's pair machine (`channel-pair.ts`), which stays
deleted. It also deleted the follow-up gate (`channel-reply-gate.ts`); the owner restored it on
2026-10-07: in a public or task thread every other Buddy that posted there gets a delivery with no
conversation (crate `follow_ups`), and the runner asks it one yes/no question (`followUpGate`) before
opening its seat; `<no>` settles the run with no turn. Mentions, subscribed conversations, DMs and
retries skip the gate. A subscribed delivery arrives as one coalesced delivery that it may answer
silently, except that the owner's @mention or DM post must end with
a post, else the thread shows a `reply_failed` notice (D10, runner `deliveryEnding`). A failed delivery
turn always leaves that notice (`noticeFailure`), which the owner's "retry on another harness" reruns
(`retry_delivery`). A delivery turn holds owner authority only when every post it shows is the owner's
(D9, `deliverJob`). F3: a resumed delivery sends only the posts past the run's `through_ord` plus an
envelope of at most 400 chars, also right after a backend restart (guard: buddies-v2 "a delivery after a
backend restart sends one post, not the thread"). A request's failure is a `run_failed` post (`runs.rs` `close_request`), delivered the same way. A
self-spawned worker writes in its spawner's thread without taking the subscription
(`from_own_worker`). Two deliveries of one Buddy to one thread with no conversation yet run one at a
time (`WAITING_REASON_SQL`), or both would open the seat and answer twice.
unread post of the threads its conversation subscribes to (`compose`), so a burst costs one turn. A
request's failure is a `run_failed` post (`runs.rs` `close_request`), delivered the same way. A
self-spawned worker writes in its spawner's thread without taking the subscription
(`from_own_worker`). Public and task threads subscribe only by `follow` until step 5 moves mentions
and seats onto delivery.
**Read fence:** whatever moves a Buddy's mark in a thread (a thread read, a follow, a delivery at
`mark_executing`, its own post) settles every queued delivery it covers `consumed`, with no turn
(`deliveries.rs` `fence`). Posting never moves the author's mark past a post it was not shown
(decision K, `catch_up`).
Replaced: the request's stored route (`Returns = Inbox | Conversation`, `post.return_conversation_id`,
`send_back`, 2026-10-01) and the `reply` / `failure_notice` / `follow` / `schedule` run kinds. Before
the stored route, the runner's post-claim `placement()` and its `mailbox` job let nine no-op replies sit
`conversation_busy` behind one owner turn for up to 2h44m (2026-10-01). A delivery into a human chat
is real work, ordered behind the owner: `owner_first` in the claim gate (`WAITING_REASON_SQL`), Stop
cancels queued deliveries (`cancelQueuedDeliveries`), and the turn resumes the chat's session without
the owner grant (`RETURN_ORIGIN` in `buddies/turn-policy.ts`).
Guards: crate `a_mark_advance_consumes_every_covered_delivery`,
`a_burst_in_two_subscribed_threads_costs_one_delivery_turn`,
`posting_never_marks_read_a_post_its_author_was_not_shown`,
`a_queued_owner_message_goes_before_a_delivery_in_the_same_conversation`,
`a_request_from_no_conversation_starts_no_run_for_its_answer_or_failure`,
`a_worker_request_runs_on_its_own_config_and_returns_to_the_spawner`; buddies-v2 "a worker's answer
returns to the owner chat that asked …", "one full chat turn …", the follow (a)–(h) suite.

## durable-intake
**Smell:** an input lives only in a process's memory until it runs (a queued owner message, a wake), so
a restart loses it; or an input that may already have run is replayed after a crash.
**Pattern:** every input is a row before it is acknowledged, and the row says whether it has executed.
`executing_at` is stamped as the holder's LAST await before the side-effecting spawn
(`mark_executing`). A dead holder's run with no stamp goes back to the queue (nothing ran); one with
the stamp is adopted from its journal or ends visibly, never replayed.
**Here:** crate `runs.rs` (`enqueue_chat`, `mark_executing`, the requeue in `expire_leases`) and
`schema.rs` `RUN_TABLE` (a queued chat run must carry its `body`). Callers: `buddies/runner.ts`
(`admitChat`, `runJob`). From durable-pending W0a/W0b (95028f0, 745515f), shipped in the 2026-10-06
delivery rebuild (`migrate.rs`, ONE live migration with a pre-migration `VACUUM INTO` copy).
Step 6 (2026-10-07, task_01a11013-bac6): owner messages are rows AT SEND, one carrier per conversation
kind (`server/src/turns/intake.ts`, `InputCarrier`). A Buddy conversation's are crate `chat` runs
(`buddies/turn-policy.ts` carrier; the runner's CLAIM hands the run to the conversation, which rebuilds
the entry from `run.body` after a restart, `runtime.ts admitChatClaim`). Chats and the Builder use the
records store's `conversation_input` (ingest `records/store.rs`, schema v3, pre-migration copy
`*.before-input-v3.records-v2.*`); `hydrateInputs` re-queues unstamped rows at boot. `TurnQueue` stays
the pure machine and wire view, every pending entry backed by a row. The head starts only after its
stamp (`carrier.stamp`), because a turn spawned before it could be adopted AND requeued. Deleted: the
chat ticket, the 1 s admission tick, the runner `chats` map, the reload "wait for empty queues" hold
and the 15-minute `owner_first` bound.
Guards: `execution-adoption.test.ts` "an owner message queued behind a running turn survives a backend
SIGKILL", crate `a_queued_owner_message_survives_a_restart_and_still_goes_first`, ingest
`a_v2_file_is_copied_then_migrated_with_its_records_intact`, crate `a_dead_holder_requeues_an_unexecuted_run_and_fails_an_executed_one`,
`without_the_executing_backfill_a_legacy_running_turn_would_be_replayed` (tests/migration.rs).

## store-descriptor-isolation
**Smell:** backend code opens a file that happens to be a live SQLite store (or its `-wal`/`-shm`): a
second SQLite library, a directory walk that reads every file, a copy, a hash, a file watcher.
**Pattern:** inside the backend process, only the owning addon's connections hold a descriptor on a
store file. POSIX locks belong to the process, so any other in-process `close()` on the inode silently
drops every lock the store holds; the next opener in any process then believes it is alone, resets the
mapped `-shm` (SIGBUS) and deletes the WAL on close. Work that must read store bytes runs in a child
process, whose descriptors carry its own locks.
**Here:** the uploads GC scans the app data and Buddies directories from a child process
(`server/src/uploads/gc.ts`, `runUploadsGcInChild`). It ran in a worker thread until 2026-09-30,
dropped all four stores' locks at every boot, and two SIGBUS deaths followed. Earlier:
node:sqlite in the parity harness (2026-09-25). Comment at `crates/unleashd-ingest/src/store.rs`.
Guard: `server/test/sqlite-locks.test.ts` boots the real backend on temp stores, runs a GC pass
that scans them, then opens every store from a second process and fails if the WAL or `-shm` is
reset or deleted.

## lease-heartbeat
**Smell:** one number used both as "how long the holder may stay silent" and as "how long the work may run",
or a startup sweep that ends everything the previous process held.
**Pattern:** a claim carries two separate values. The **lease** is a short heartbeat that the live holder renews.
The **deadline** is the work's absolute budget, which the holder enforces as its own timeout. A dead holder is
noticed in ONE place, the gate that hands out new claims: it ends every run whose lease ran out, exactly as a
failed settle would. Liveness is "the lease was renewed recently", with no separate progress field. Nothing is
swept at boot, so a second live process on the same store keeps what it holds.
**Here:** crate `runs.rs` `claim_run_at` (the gate, `expire_leases`, `end_run`) and `renew_run`; the
`RunBudgets` type. The lease is `BUDDY_RUN_LEASE_MS` (5 min) in `server/src/constants/timeouts.ts`. Renewal is
`BuddyTurnPolicy.bridgeAlive`, called by `TurnRunner` on every event that ticks the watchdog's bridge clock, at
most once a minute. Renewal rides the bridge clock and not provider progress, because a model may think
silently for the 60-min idle budget while agent-cli heartbeats keep ticking. The runner's `start` renews
adopted turns before its first claim. The deadline is the run's `deadline` column, `TURN_MAX_RUNTIME_MS` for a
chat (passed explicitly) and `BUDDY_BACKGROUND_TURN_MS` otherwise.
What the gate does to a dead holder's run depends on `executing_at` (Pattern: durable-intake): unexecuted
→ back to the queue; executed → `lease_expired`, and an executed REQUEST then continues once in its own
conversation (decision G, `runs.rs` `resume`; a second death sends the failure post, a stop is never
undone).
The gate never ends a run its OWN process drives: `claim_run_at(now, budgets, held)` renews the caller's
`held` runs `(run_id, lease_token)` in its own transaction BEFORE `expire_leases`. The runner's `holds` map
(`BuddyTurnPolicy.arm` → `hold`, released at `disarm`) is passed with every `claimRun`. The lease is compared
with the wall clock, so a process frozen longer than the lease (macOS Maintenance Sleep: 306 s against the
300 s lease, 2026-10-06 16:53Z; five live runs ended 9 ms after the wake) finds it lapsed at wake. A renewal
awaited in TypeScript before the claim (f6d3bab) is check-then-act and failed the SIGSTOP guard: the freeze
lands between check and act and the napi threadpool runs the queued claim before any JS. Only the crate
transaction has no gap. Never move it back to the host. Accepted residual: a DIFFERENT backend's gate on the
same store still ends this one's lapsed runs.
Findings: `agent_notes/2026-10-07_live-turn-lease-loss.md`.
History: on 2026-09-10 a 600 s lease used as a chat deadline killed healthy owner chats. The fix made the lease
24 h, and dead holders' runs then stayed `running` until the next boot: a 9.5 h overnight lie on 09-30→10-01,
and 14 and 10 orphaned runs at 12:34Z/14:09Z on 09-30. The boot sweep also ended runs a second live backend held.
Decision: `agent_notes/2026-10-01_return-route-decision.md`, "Successor 14:48Z" and its successor.
Guards: `server/test/run-lease.test.ts` (a dead holder is cleared within the lease while the backend stays up;
a heartbeating silent turn outlives its lease; the idle timer still kills a turn with no provider progress),
plus crate tests `an_expired_lease_ends_its_run_like_a_failed_settle`, `a_renewed_lease_outlives_its_first_term` and
`a_held_run_is_renewed_by_the_gate_before_it_can_expire`; run-lease.test.ts "a live turn keeps its run across a freeze
of its backend longer than the lease" (SIGSTOP 2× lease).

## persisted-state-machine
**Smell:** one thing's truth is spread over several stores (an in-memory flag, a file, a DB row) that are
updated one after another, so a crash between two writes leaves them disagreeing, and recovery code guesses
which one to believe.
**Pattern:** the thing has ONE persisted state, a sum type. One pure transition function (a thin dispatcher
over a phase × event table, one straight-line handler per cell) returns the next state and the side effects
it licenses. The state is written to disk BEFORE any of those effects runs, and every effect is idempotent,
so a crash at any point resumes from a state that explains it, and recovery redoes the effects. Recovery reads
only that state (plus facts it can observe, like process liveness). An exhaustive small-scope checker injects
a crash at every step, and a mutation check proves it catches a broken rule.
**Here:** `server/src/turns/execution-state.ts` (`Phase = running | stopping(intent) | abandoned |
ended(outcome) | settled`, `TRANSITIONS`, `ADOPTIONS`, `GRANTS`, `applyStep`). The phase lives in the
execution's journal directory (`phase.json`, beside agent-cli's `pid`/`exit.json`; written by
`turns/executions.ts`). `TurnRunner` runs the effects (`EFFECTS`), and boot adoption
(`lifecycle/adopt-executions.ts`) reads the phase and restores grants before the Buddy MCP endpoint attaches to
its relay ([hold-through-outage](#hold-through-outage)).
History: P1 review, 2026-10-01. In 2a, a stop revoked the grant in memory only, so a backend killed inside the
3 s kill grace left a turn the next backend adopted as live, with its tools back. In 2b, the journal was
removed before the run settle landed, so a finished run recovered as interrupted.
Decision: `agent_notes/2026-10-03_p1-single-execution-state-decision.md`.
Guards: `server/test/execution-crash-checker.test.ts` (every crash point, and the mutation check), plus the
real-backend tests in `server/test/execution-adoption.test.ts`: "a Stop survives a backend crash inside the
kill grace", "a timeout survives…" and "a crash between the drain and the run settle".

## hold-through-outage
**Smell:** a client that outlives its server, calling it over a transport that turns "server restarting" into an
immediate error (connection refused, 503), with delivery left to whoever reads the error and decides to retry.
**Pattern:** a small relay that outlives the server owns the address the client was given. It accepts the
call and holds it until a server is attached, then forwards it unchanged. It gives up before the client's own
timeout, with an error that says the call was not delivered. The server attaches over a connection it holds open
for its lifetime, so the relay knows the moment the server dies (the kernel closes the socket, even on SIGKILL)
and never forwards to a stale port. A forward that fails before the response starts is resent, which is safe
only because every write carries an idempotency key ([idempotency-keys](#idempotency-keys)). Authority stays with
the server: the relay passes credentials through and never interprets them.
**Here:** `server/relay/buddy-mcp-relay.mjs` (plain node, spawned detached so a terminal's Ctrl+C does not end it;
`HOLD_MS` = 55 s) and `server/src/buddies/mcp-relay.ts` (find or start the relay, attach, re-attach).
`startMcpEndpoint` in `buddies/mcp.ts` serves on an internal port and attaches after boot has restored adopted
grants. The stable port and attach key are in `<data dir>/buddy-mcp.json`.
History: Ctrl+C proof case 4 (2026-10-01): a Buddy call made during an outage got ECONNREFUSED and was lost,
because neither claude nor codex retries a refused connection or a 503. Both wait on a held request, and claude
gives up at 60 s. Measurements and the alternatives that lost: `agent_notes/2026-10-05_outage-tool-delivery.md`.
Guards: `server/test/ctrl-c-adoption.test.ts`, the three outage cases (lands once and its replay creates nothing;
over the hold, a clear error at ~55 s; a Stopped turn's held call gets 401). All three fail on 3a21efd.

## fix-guards
**Smell:** a fixed slowdown or bug quietly comes back.
**Pattern:** every fix leaves three things:
1. a 1–3 line reason comment (what broke, the measured cost, the guard's name);
2. a regression test that fails on the bad pattern itself;
3. runtime visibility. The event-loop stall monitor records any stall of 100 ms or more, with its cause.
**Here:** `server/src/observability/event-loop-stall.ts`; the "reconcile tick never scans a table" query-plan test;
the crate's query-plan guard; Buddy sigils render in a worker (`sigil/client.ts`, guard
`client/test/sigil-off-main-thread.test.ts`: 12 inline renders blocked "Loading thread…" 0.6–3.5 s). For visual regressions the guard is the screenshot compare loop:
`pnpm screenshots` before, `pnpm screenshots --baseline <run>` after, which exits non-zero when any screen's
changed pixels exceed `--threshold` (`tools/lib/screenshot-compare.mjs`; masks in `tools/lib/headless-chrome.mjs`).
