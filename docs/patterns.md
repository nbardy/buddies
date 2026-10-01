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
**Pattern:** decide where a result goes when the thing that will produce it is created, from stable data,
and store the decision as a sum type on it. Downstream code reads the stored route and never re-derives it;
a route that needs no work creates no queued row at all.
**Here:** `Returns = Inbox | Conversation(id)` (crate `types.rs`) is fixed by the sending turn's grant
(`returnsFor` in `server/src/buddies/policy-port.ts`, from the conversation's visibility, which never
changes) and kept on the request (`post.return_conversation_id`; NULL on a request is Inbox). The crate's
`send_back` (`posts.rs`) is the one place an answer or failure notice becomes a run; Inbox enqueues none.
Replaced the runner's post-claim `placement()` and its `mailbox` job: on 2026-10-01 nine no-op replies
sat `conversation_busy` behind one owner turn for up to 2h44m and a Buddy offered to cancel that turn.
Decision: `agent_notes/2026-10-01_return-route-decision.md`. Guards: buddies-v2 "an answer to a request
sent from a human chat starts no run and never queues behind that chat"; crate
`an_inbox_request_starts_no_run_for_its_answer_or_failure`.

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
