# Architecture in One Page

Moved out of AGENTS.md (startup-context size limit). File-level roles live in
the AGENTS.md code tree map; this doc is the why behind the layout.

## Product direction: channels and thread inspection

Channels and Buddy DMs are the primary working UI. The classic `/chat/:id` view
is deprecated for new product development but remains supported for inspecting
underlying transcripts, tools and worker activity. Keep its inspection links and
fix regressions; do not launch another pane/composer rewrite or remove it as part
of the lean-refactor closeout. Removing it is a separate product decision after
Channels covers the required inspection workflow.

## 1) Provider abstraction is the integration seam

Provider-specific CLI details are expressed through a shared contract, split
between the build-time contract in `agent-cli-tool` (harnesses + builder +
types), the server provider runtime (`server/src/providers/*`), and shared
provider IDs/catalog schemas in `shared/src/provider-catalog.ts` (re-exported
through `shared/src/index.ts`). Selection intent, patches, and resolution share
`shared/src/conversation-config.ts`; see [pass-through pattern](pass-through-pattern.md).

## 1.5) Shared agent CLI stays a thin wrapper

The `vendor/agent-cli-tool` submodule is deliberately small. Its job is:

1. take one canonical request shape
2. map that request into harness-specific argv
3. run the real CLI process
4. parse harness-specific stdout/stderr
5. emit one unified event stream

The submodule implementation lives in `src/build.ts`, `src/process-runner.ts`,
`src/parsers/`, `src/execute.ts`, and `src/runtime-types.ts`.

### Core rules for `vendor/agent-cli-tool`

1. **One input model, one output model.**
   Callers should pass one canonical request object. Harnesses may have
   different raw JSON/event formats, but the submodule emits one shared event
   union (`session.started`, `turn.started`, `text.delta`, `tool.use`,
   `progress`, `stderr`, `error`, `out_of_tokens`, `turn.complete`).

2. **Harness-specific differences belong at the edges.**
   Harness config owns argv syntax. Harness parsers own raw-output translation.
   Do not spread provider conditionals through the generic executor.

3. **The submodule is not an app runtime.**
   No conversation model, no swarm orchestration, no sidebar/UI state, no
   product-specific subagent data model. The submodule only reports normalized
   runtime facts.

4. **Per-harness JSON in, unified JSON out.**
   Think of each parser as:
   `raw harness JSON/events -> unified events`
   The parser may keep small local state when the provider protocol requires
   it (for example streamed tool-call reconstruction), but that state must stay
   parser-local.

5. **Session helpers are separate from parsing.**
   Resume/fork/session-id capture are executor/session concerns, not parser
   concerns. Keep filesystem/session emulation out of harness config except as
   explicit helper hooks.

6. **When adding a harness, prefer extension over branching.**
   Usually this means:
   - add/update harness config in `src/harnesses/*`
   - add/update one parser in `src/parsers/*`
   - add a focused session helper only if the harness truly needs one
   Avoid growing `execute.ts` into another monolith.

7. **Test the contract, not implementation trivia.** Build-command contract
   tests, shim-CLI integration tests, and opt-in captures under
   `manual_tests/` (for studying harness drift — not every live-debug script
   becomes an automated test).

8. **MCP servers are a sum type: `{kind:'stdio'}` or `{kind:'http', url,
   headers}`.** Each harness has one encoder per kind (`src/mcp-encoding.ts`
   dispatches). HTTP header values (the per-turn bearer) travel in the CLI's
   environment wherever the CLI can expand them (claude `${VAR}`, codex
   `env_http_headers`, cursor `${env:VAR}`); muse cannot, so its token sits in
   a 0600 settings dir that `runCommand` deletes when the process exits.
   Claude (HTTP, verified 2026-09-25) and cursor (stdio, verified 2026-09-24)
   drop a failed server SILENTLY and the turn succeeds, so the runner probes
   every required HTTP server on every harness (`initialize` + `tools/list`,
   `src/mcp-startup.ts`) and fails the turn on a dead URL or rejected token.
   Muse reads `mcpServers`, not the legacy `mcp_servers`: with both keys
   present it drops every MCP server.

## 2) Transcripts: the ingest store

Provider transcripts are read by ONE reader, the ingest crate
(`crates/unleashd-ingest`), which keeps its own SQLite cache
(`<appData>/ingest.sqlite`) and watches the provider roots. The server never
parses a transcript (T13b S2 deleted `server/src/adapters/*`: the TS parsers,
the 500-transcript startup window, the session cache and the 5 s poller).

- **List:** `server/src/ingest/conversation-list.ts` joins every active record
  with the store's session rows (`listSessions`). A session no record binds is
  discovered into a record (`discoverSession` in `server.ts`). `onChange` sends
  row patches; a transcript written by another process shows as running until
  it is quiet for `EXTERNAL_GRACE_MS` (one backstop timer, armed only then).
- **Bodies:** `GET /api/conversations/:id/messages` is `list.page`: the bound
  sessions' settled prefixes (`Ingest.messages`) merged with the runtime's
  live-turn overlay by `mergeSessionMessages`. While a turn runs, changes to
  its transcript queue; when its process exits they settle, and the provider's
  rows replace the overlay's. A replaced history bumps the page epoch and sends
  a `rewritten` patch so loaded clients refetch.
- **Runtimes:** `server/src/ingest/runtimes.ts` builds a runtime from a record:
  every app-created record at boot, any other conversation on first use (open,
  or a WS command). A runtime's `messages` is only the overlay.

Conversation records live in the Rust `ConversationRecords` store
(`crates/unleashd-ingest/src/records`), reached through
`ConversationRecordStore` in `server/src/conversations/config-records.ts`. The
store owns validation, the session index (session ID → conversation, written
in the record's own transaction) and compare-and-set revisions (`BEGIN
IMMEDIATE`, exact across processes), so a session lookup is one indexed query
and never a record scan. Until T23b (2026-09-26) records were `config-store.ts`:
one JSON file per conversation plus one per session, all read at startup —
18,850 reads of 8,019 records in the first 7s (T14b). Only the addon may open
the records file in this process: node:sqlite is a second SQLite library, and
two in one process broke POSIX locking (SIGBUS in the T12 parity run). The same
holds for any in-process descriptor on a store, even a plain read
(`docs/patterns.md#store-descriptor-isolation`).

Transcripts come from the Rust ingest (`server/src/ingest/*` over the
`unleashd-ingest` addon). There is no `server/src/adapters/`, session cache,
poller or disk loader any more (T13b S2). Adding a provider means adding a
harness, a server provider, and a parser in the crate (if it persists
transcripts). `pnpm addons` / `pnpm run bootstrap` bring the addons up (see
the dev runtime section below).

**Startup cost rules** (2026-09-25: the barrier took 67-102s on ~7,700 sources
and ~7,800 records; these brought it to 14-20s on the same data). Each is
guarded by a test; every one of them regressed by growing with history size.

- **No record scans.** Lookups and startup listing are indexed queries on the
  records store (`listSummaries`, 8,164 rows in ~100ms warm); the JSON-file
  store's per-startup scan and its lookup scope are gone.
- **No per-row work for a lone transcript.** `mergeSessionMessages` returns a
  single source unchanged; the general merge stringifies every row.
- **Do not reintroduce per-file work on boot** that scales with history size.
- **Recovery dispatches only pending first messages.** A record whose
  `initialMessage` is absent or dispatched skips the claim (two record reads).

### 2.0) A config record is not a conversation

The records store holds a record for every session the ingest has seen, tagged
`provenance: 'external_discovered'`. That record is a **sidecar for a
transcript, not evidence that a conversation exists.** At boot `recover()` in
`server/src/ingest/runtimes.ts` builds runtimes only for records the app itself
created (`user` / `legacy_inferred`) — the ones that may have nothing on disk
yet, e.g. a thread whose first message has not dispatched. Every other listed
conversation becomes a runtime on first use (`materialize`), from its record
and the store's session rows. Recovering every active record once produced
5,275 empty "New conversation — 1m ago" rows (2026-09-06); a recovered runtime
also keeps `record.createdAt`.

History is read on demand, never hydrated: `list.page` in
`server/src/ingest/conversation-list.ts` reads the bound sessions' rows through
`sessionMessages` (`ingest/history.ts`, over the crate's `Ingest.messages`) and
merges the live-turn overlay (`mergeSessionMessages`).
That is the body endpoint of the protocol v3 seam
(`GET /api/conversations/:id/messages?afterSeq=&limit=`), so there is no
startup window and no hydration cap. Guards: `server/test/ingest-history.test.ts`,
`server/test/ingest-list.test.ts`.

Stable tool instructions belong in native tool descriptions or the dedicated
model instruction channel. Keep authored text intact; scope generated workflow
context to the selected operation. Builder, Buddy and swarm envelopes must not
become user messages after reload. (The merge feature and its
`unleashd:merge-prefix` envelope were deleted on 2026-09-25.) See
`product/buddies/AUDIT_PROMPT_PLACEMENT_2026-09-12.md` for rationale and limits.

Transcript display rules live in the crate's parsers
(`crates/unleashd-ingest/src/parsers/*`), e.g. `parsers/codex.rs` drops Codex's
`AGENTS.md` / environment / `plugins.recommendations` blocks by their
`content_item_kinds` provenance tags (never by an `AGENTS.md` text prefix), and
keeps function/freeform tool calls in transcript order, deduplicated by call id,
with their full input. Guards: `crates/unleashd-ingest/tests/{formats,regressions}.rs`.

### 2.1) Rehydration: the durable record owns Buddy identity

A conversation's kind is ONE stored value, `record.kind` (chat | buddy |
builder | worker); a runtime takes it from the record, never from transcript
text. The Buddies page lists `conversation_links` rows in the Buddies SQLite;
the sidebar's Buddies group reads the runtime's kind — both now come from
durable state, so they agree after a restart.

This used to break Chat "Fork": the transcript loader resolved kind from the
`<!-- unleashd:buddy-context-v2 -->` marker, which a fork's first turn never
writes, so every restart demoted forks to `general` ("N conversations on the
Buddies page, N-1 in the sidebar"). The create command in
`conversation-websocket.ts` now resolves a fork's kind from its source and
stores it in `record.kind`, which is what survives. Guard: `server/test/wire-v3.test.ts`.

## 3) Conversation lifecycle and state authority

The `Conversation` class is created by `createConversationRuntime` in
`server/src/conversations/runtime.ts`: record + `TurnQueue` (`turns/queue.ts`) +
`TurnRunner` (`turns/runner.ts`) + a `TurnPolicy` chosen once by kind
(`turns/policy.ts`, `buddies/turn-policy.ts`). Timeouts are `turns/watchdog.ts`,
swarm observation `swarm/observer.ts` (outside code imports swarm only through
`swarm/index.ts`). `server/src/server.ts` composes its
dependencies and registers `server/src/transport/conversation-websocket.ts`.
Durable config and revision checks belong to `conversations/config-service.ts`
over the Rust records store (`conversations/config-records.ts`).

Flow is:
1. Client sends creation intent with stable command and conversation IDs.
2. Server validates and persists config, materializes the runtime, and acknowledges creation.
3. Sending a message (including an initial message) resolves an execution snapshot and spawns the provider.
4. Events update runtime state and stream to the client; completion reconciles and broadcasts authoritative snapshots.

`server` state remains authoritative while the provider process is active.
Transcript changes to a conversation whose turn is running wait until it is idle.

Transcript changes arrive from the ingest store's watcher, which resumes an
append-only file from its last offset (crate `read.rs`); the server re-lists
only the changed sessions.

Buddy provider-session bindings also persist the host-resolved disclosure audience.
On restart, the runtime compares that saved key with freshly resolved access before
resuming. Matching access preserves native conversation context and still receives
the current briefing and MCP configuration. Changed access or legacy bindings with
no saved audience start a fresh session while retaining display history. Memory
revision changes alone do not reset a session. Audience metadata is written when
the provider confirms its session ID, never inferred from transcript text.

### Chat "Fork" and provider-session inheritance

Chat "Fork" (`atoms/fork-actions.ts`) is a soft handoff: a new conversation with
`resumedFromConversationId` lineage and the transcript as draft text. Any
provider pair works.

It **opportunistically upgrades** to native session inheritance (CLI `--fork` /
`emulateFork`) on its first send when the source is the same provider *and*
that provider is in `FORK_CAPABLE_PROVIDERS` (`runtime.ts` `sendMessage`).
Everything else stays string handoff. That upgrade must never reject the send.
(Merge, the only other session-fork user, was deleted on 2026-09-25.)

It did once: the branch checked only `source.provider === this.provider`, so a
muse -> muse fork handed a session id to a harness with neither
`sessionForkFlags` nor `emulateFork` and the turn died with `Harness "muse"
does not support fork.` (`vendor/agent-cli-tool/src/session.ts`). muse -> claude
and claude -> muse worked, which made it look provider-pair specific — it was
capability, not pairing. Same latent bug applied to cursor -> cursor. The gate
is now `providerSupportsFork(this.provider)`; guard:
`server/test/conversation-runtime.test.ts`.

### Backend reload, drain, and the dev watcher (liveness rules)

`server/src/lifecycle/shutdown.ts` is the only mutation-admission and
process-lifecycle authority. States: `starting → idle`, and `starting|idle →
reloading → exiting`.

**No exit stops a running provider turn.** This covers reload, SIGINT/SIGTERM, and
the loss of the dev runner. Each turn runs from an on-disk journal, and the next
backend adopts it (docs/turn-lifecycle.md#execution-adoption). Only an explicit Stop
stops a turn.

**`reloading` is absorbing, so a source reload must not enter it while
memory-only work is active.** Memory-only work is anything a backend exit would
drop:
- a queued message not yet sent;
- a Buddy chat waiting for a run slot;
- an admitted mutation;
- startup;
- a memory review;
- a Buddy run's completion step or settle.

Running provider turns do not count. The reload policy while it waits:
- Admission policy stays in effect: `idle` accepts mutations; `starting` admits
  only WebSocket `create_conversation`.
- Other WS commands await the startup barrier.
- HTTP mutations, including New Buddy's builder request, receive
  `503 server_starting` until `idle`.

At an observed idle boundary, the controller:
1. pauses the scheduler;
2. synchronously rechecks all work counters;
3. only then enters `reloading` and exits.

If work appeared, it resumes the scheduler and keeps waiting.

Before 2026-09-30:
- A reload also waited for every running turn, which starved a reload for 20+
  minutes under steady Buddy work.
- SIGTERM stopped every running turn.
- An abrupt death orphaned every running turn anyway.

The alternatives and tradeoffs are recorded in
`agent_notes/2026-08-24_automation-execution-ownership-design.md` and its successor,
`agent_notes/2026-09-30_execution-adoption-design.md`.

The remaining hard bounds are specific to explicit shutdown and final flushing:

| Bound | Constant | Protects against |
|---|---|---|
| shutdown drain | `HOT_RELOAD_FORCE_EXIT_GRACE_MS` (3s) | memory-only work that never drains (it is dropped) |
| flush watchdog | `SHUTDOWN_FLUSH_GRACE_MS` (5s) | `exiting` wedged by a hung flush |

The flush watchdog is the subtle one: `exitOnce()` calls `clearTimers()` *before*
awaiting `flushState()`, so without it a `turnAttemptJournal.flush()` that never
settles leaves the process alive in `exiting` with nothing armed to rescue it —
the same user-visible error, but permanent. It is armed after `clearTimers()`
deliberately.

The startup barrier (`initialLoadComplete`) means "startup is no longer in
progress", **not** "startup succeeded". A reload arriving mid-startup makes
`completeStartup()` return false; every terminal outcome must still resolve the
barrier (see the `.finally` in `server.ts`) or non-create WS commands await it
forever with no reply. Recovery of durable records is per-record fault-isolated
for the same reason — it runs inside the barrier, so an unreadable record used to
reach `handleStartupFailure()` and exit the process.

**One dev process** (`tools/dev-supervisor.mjs` + `tools/dev-runtime.mjs`):
`pnpm dev` hosts the three TypeScript watch compilers (shared ESM, shared CJS,
agent-cli-tool), Vite and the backend runner in the supervisor process through
their JS APIs; only the backend server is a child. The backend and Vite start
after every compiler's first pass, so no compiler output lands on a backend
mid-boot and there is no separate pre-build. It replaced concurrently plus a
`pnpm --filter` wrapper per tool (18 processes → ~5, 2026-09-25); memory is
about the same, the saving is processes and a deterministic start order.

**Watcher contract** (`tools/watch-server.mjs`): keep exactly one backend
running the code on disk.

- **What to watch is derived, never configured.** The backend runs with Node's
  `WATCH_REPORT_DEPENDENCIES` protocol and reports every file it loads —
  `server/src`, `shared/dist`, and `node_modules` alike — and one recursive
  watch on the repository is filtered against that set. The hand-written list it
  replaced omitted `node_modules`, so a vendored Buddies upgrade never reloaded
  the backend (2026-09-23).
- **Rust crates rebuild on save.** The backend loads each crate's addon
  (`crates/<c>/*.node`), never its `.rs` files, so a saved `src/**/*.rs`,
  `build.rs` or `Cargo.toml` runs `tools/ensure-addons.mjs` for that crate (one
  at a time): a cache copy when any worktree built those sources, else a
  throttled cargo build. Only addon crates (a napi `package.json`) rebuild; the
  import CLI crates never do. The rewritten addon then reloads the backend like
  any loaded file; a failed build keeps the current addon (T14b, 2026-09-26).
  The two addons are `unleashd-buddies` (the Buddies core: `server/src/buddies/*`
  runs on it, no JS Buddies package) and `unleashd-ingest` (conversation records
  and transcript ingest). `pnpm addons` brings both up to date outside the
  watcher; `pnpm run bootstrap` (install + submodule + shared + addons) sets up
  a fresh worktree.
- **New code must build before the old backend is asked to drain.** One esbuild
  bundle of `src/server.ts` (~60ms) catches syntax errors and missing exports;
  on failure the current backend keeps serving.
- **Only a real content change reloads, judged after the writes settle.** Every
  `pnpm dev` start re-emits `shared/dist` and the agent-cli-tool `dist`
  byte-for-byte. Shared outputs now replace each file atomically; the CLI
  compiler can still truncate one while writing it. The runner
  compares touched files against the digests the backend loaded once events go
  quiet, never per event. Digesting per event read the empty intermediate as a
  change and restarted a backend mid-startup, so the history loaded twice
  (2026-09-25).
- **Any exit it did not request is a restart**, with backoff doubling to 30s and
  resetting after 30s of healthy uptime. It never gives up: giving up is what let
  `concurrently --kill-others-on-fail` tear down the whole dev runtime after a
  single `kill` (incident 2026-08-20,
  `agent_notes/2026-08-20_reload-drain-and-watcher-teardown.md`).
- **The backend never outlives the watcher.** `shutdown.ts` treats losing the
  IPC channel as SIGTERM; an orphan from 01:31 on 2026-09-23 kept the port and
  served stale code after its supervisor was replaced.

## 4) Client state frequency budget

Streaming is separated from structural state:

- Structural: `rowsAtom` (per-id records) and the one-pass `listIndexAtom`
  whose fields are the collection views. See
  [client state](client-state.md#an-event-costs-what-it-changed-2026-09-25).
- High-frequency stream text: dedicated stream buffers / streaming atoms.

`streamFamily(id)` is separate from `rowsAtom`. Pending creation and config
commands live in `commandsAtom`; they are not partial server
conversations. Summary transport projections do not replace the durable/runtime
record; full transcripts hydrate through the detail route.

Details and code patterns: [client state](client-state.md) and
[WS contract notes](ws-contract-surprises.md).

## Default workspace is not `process.cwd()`

The dev supervisor spawns the server with `cwd: <repo>/server` (tools/watch-server.mjs), so
`process.cwd()` resolved to the server PACKAGE. Every Buddy Builder conversation started in
`<repo>/server`, and an agent using root-relative paths ("server/src/...") hit
`<repo>/server/server/src/...` (ENOENT, "No such file or directory (os error 2)" on its first
read_file). Production runs from the repo root, so it only reproduced in dev.
`resolveDefaultWorkingDirectory` (server/src/http/path-utils.ts) resolves:
`UNLEASHD_DEFAULT_CWD` → the enclosing pnpm workspace root (at most 4 levels up) →
`process.cwd()`. It is only a default: a Buddy with a workspace uses its `root_path`.
