# Buddies core review: bugs, slop, target types, refactor plan

2026-10-07 · review worker for Task task_01a115b8 (Buddies Development Lead's request
post_01a115b8-87bd). Owner request (post_01a115b7-b4b3): "review code for bugs or slop and do a
refactor pass to cut code count, unified data model and types, and remove branching conditional
slop". Hard constraint: **no user-visible behavior change** (owner freeze, 2026-10-07).

Status: **review, proposed plan.** Nothing below is an owner decision. Every `file:line` is at
**027940c** (origin/main when the review started). The lease fix (`wrapup/2026-10-07`, merged
there as 4d34ca3, not yet on origin/main at writing) and keep-awake (Task task_01a11584) will move
lines in `server/src/buddies/runner.ts`, `turn-policy.ts`, `turns/runner.ts` and crate `runs.rs`;
findings in those regions are tagged **[lease lane]** and get re-read after the rebase.

Method: five read-only reviewers (crate; runner/policy/mcp; routes/channels/memory; turns and
conversation runtime; cross-layer types), then the lead-of-this-lane spot-read the top claims.
"Verified" = re-read by me at the cited lines; "cited" = reviewer citation, single-file-read
confirmed by that reviewer but not re-read by me. **No repro below has been executed yet**; each
bug is a code-path repro, and the ones I fix get a test that fails on the base first (phase 2).

## The visibility rule used here

Invisible = the fix changes no text, state, ordering, timing-class or routing that the owner or a
Buddy can observe, in **any** path (failure paths included). Internal bookkeeping (journals on disk,
timers, log lines, dead code) is invisible. Under this rule most real bugs are **visible**, because
their failure path shows up as a run outcome, a notice or a request state. Those are reported for
an owner decision, not fixed.

## 1. Bugs

### Visible — owner decision needed (ranked)

| id | where @027940c | bug (one line) | repro | conf | status |
|---|---|---|---|---|---|
| V1 | `server/src/buddies/turn-policy.ts:575-581` + `server/src/turns/runner.ts:496-512` [lease lane] | `settle()` calls `disarm()` before the crate settle lands, so the runner's documented retry ("`ended` stays on disk while this backend keeps trying") finds `execution === null` and returns: one transient store error and the run is never settled, its journal is deleted, its lease stops renewing, and it ends `lease_expired` (a `post` request is then re-run). | port whose `settle` rejects once; assert called twice and run settled | high | verified |
| V2 | `crates/unleashd-buddies/src/runs.rs:429-432`, `tasks.rs:198-202`, `team.rs:184-191` | Cancelling a **queued** run (owner Stop, task pause/epoch, Buddy archive) is a bare UPDATE that skips `end_run`/`close_request`; the request post stays `awaiting` forever in both inboxes. | extend `pausing_a_task_cancels_its_queued_runs`: assert asked post's request ≠ awaiting | high | verified |
| V3 | `runs.rs:497` + `server/src/buddies/runner.ts:607-608,714-718` + `server/src/turns/intake.ts:58` | A schedule fire is `RunInput::Chat` with no conversation. Once bound (`buddy-run-<id>`), a **retry** (or a re-queue after a crash between bind and markExecuting) keeps the conversation, takes the owner-chat path, and `JSON.parse`s the plain prompt: fails as `briefing_failed`. | fail a schedule run, `runs retry` it | med-high | verified (path) |
| V4 | `server/src/buddies/runner.ts:496-507` | `outOfOwnerChat` decides "is this an owner chat" from the last 100 runs instead of `record.kind` (AGENTS.md: kind is one stored value). Pre-10-07 subscriptions in public/task threads never move, so the shim is permanent, costs a 100-row query per delivery, and a second delivery during the first turn hits `conversation_busy` and posts "Couldn't reply". | old public-thread subscription naming an owner chat + two posts | medium | verified (code) |
| V5 | `server/src/conversations/runtime.ts:521-524` | A rejected chat fork returns without `releaseHead()`; the queue head stays `sending` and every later message only queues. | fork a chat whose source has no session, send twice | high (mech.) | verified |
| V6 | `server/src/buddies/turn-policy.ts:509-524,615-619` [lease lane] | A synchronous spawn failure after `startTurn` (mcpServers / journal create / executeTurn throws) leaves `this.execution` set; the owner chat refuses to start messages until restart. | executeTurn throws once | medium | cited |
| V7 | `runs.rs:652-669`, `team.rs:184` | Archiving a Buddy leaves its schedules enabled: every slot queues a run that waits `buddy_archived`; unarchive runs them all. | hourly schedule, archive, 3 `due_schedules` | high | verified (SQL) |
| V8 | `crates/unleashd-buddies/src/deliveries.rs:260-311` + `runner.ts:472,608,614` | `compose` computes covered threads with the run's conversation at compose time (NULL for a mention); after `bindRun`, `delivered` recomputes with the bound conversation and advances **every** subscribed thread: unseen posts marked read, their queued deliveries fenced. | see crate review C3 scenario (S subscribed to T3; @mention in T2) | medium | cited |
| V9 | `deliveries.rs:74-83` (`fence`) | `fence` cancels an owner's explicit retry (attempt > 1) as `consumed` when the thread's mark advances; `compose` exempts retries, `fence` doesn't. | retry reply P while X replies in same thread | medium | cited |
| V10 | `server/src/turns/runner.ts:716-735,570` [lease lane] | After an early `turn.complete` (Claude resume case) the rest of the answer streams with no watchdog and no lease renewal. | — | medium | cited |
| V11 | `server/src/turns/runner.ts:763` | Session rebind at drain passes `audienceKey = undefined` (cf. `:547`); after restart the Buddy's provider session is reset (context lost) when completion's session id differs. | — | med-low | cited |
| V12 | `server/src/turns/runner.ts:904-916`, `execution-state.ts:148-151` | Stop/promote between `turn.complete` and process exit turns a completed run into `cancelled`. | — | medium | cited |
| V13 | `server/src/turns/subagents.ts:139-146`; `runner.ts:833-894` | Sub-agents keep showing "running" after a timeout (no `host.changed`) or a crash (never settled). | — | high/med | cited |
| V14 | `server/src/turns/intake.ts:120-129`, `runtime.ts:651-663,878-882` | A queued message stamped `executing` whose spawn is then refused (model left catalog) is shown pending, then silently dropped at restart. | — | medium | cited |
| V15 | `server/src/buddies/routes.ts:484-485` | `buddy.archive` uses the constant key `archive:<id>`: archive → restore → archive replays the first result; the Buddy stays active. | over HTTP | high (mech.) | verified |
| V16 | `routes.ts:211-232`, `mcp.ts:471-501` | Answers skip `requireCanonicalPostMedia` (local image paths break when the worktree goes); a replayed answer key re-emits `posted`. | — | high | cited |
| V17 | `server/src/buddies/mcp.ts:702-708` | `runs get` has no workspace check: any Buddy can read any run's body and transcript tail by id. | — | med-low | cited |
| V18 | `server/src/buddies/mentions.ts:80-84` | Mentions inside code spans still wake Buddies (`wakes`, `threadSeats`, `mentionConfigsByBuddy` use the unprotected scan). | — | medium (may be tolerated) | cited |
| V19 | `server/src/buddies/routes.ts:440-444` | `reply.retry` is the one enqueuing route outside `write()`: no `changed` event, so the retry waits up to the 5 s backstop. | — | med-high | cited |
| V20 | `routes.ts:503-505,513-548`; `channels.ts:219,347-351` | Caller mistakes return 500 and are journaled as server failures; multer limits fall through to "Internal server error"; `newDirect` without config says "undefined is the one that failed". | — | high | cited |
| V21 | `server/src/buddies/runner.ts:283-288` | Every admit failure (incl. markExecuting, unregistered conversation) is labelled `briefing_failed`. | — | high | cited |
| V22 | `store.rs:194-201`, `posts.rs:25-30` | Public/task channel access never checks the workspace (archived_channels does). | — | low | cited |

### Invisible — fixed in phase 2, each with a test that fails on the base first

| id | where @027940c | bug | test |
|---|---|---|---|
| I1 | `server/src/turns/runner.ts:310-345` | A failed spawn leaves its journal directory on disk until the next boot (discarded there as `unstarted`). | spawn throws → no journal dir remains |
| I2 | `server/src/buddies/runner.ts:196-204,757-759` [lease lane] | `pause()` doesn't stop a drain already in its `claimRun` loop. Pause is the reload-boundary tool (test-strategy "Preserve lifecycle"), not owner-facing. | pause mid-drain → no further claims |
| I3 | `server/src/buddies/memory-review.ts:480-486` | Memory-review receipts count attempted, not landed, writes (failed `doc_write`s, `revision_conflict` retries; any non-working kind filed under `longTerm`). Receipts are event rows the client never renders. | reviewer run with one conflicting write → receipt counts 1 |

I1–I3 are small. The high-value bugs are V1–V8; my recommendation to the lead is to ask the owner
for a single yes on "fix V1, V2, V3, V5, V6, V7 (each restores what the code already promises)"
and to treat V4/V8/V9 as one delivery-routing design question.

## 2. Slop (refactor material; all invisible unless marked)

Gated area = `crates/unleashd-buddies/src` + `server/src/buddies` (the line gate). Est. = reviewer
estimate; I discount them ~40% in the budget.

**Crate** (`crates/unleashd-buddies/src`)
- K1 dead shim: `types.rs:172-193` `legacy_key`, `runs.rs:144-146` (old `post:<id>` key; post runs are only enqueued with fresh ids). ~12
- K2 dead napi methods: `node.rs:44-47` `authorize`, `174-177` `enqueue_run`, `326-329` `list_events` (no server caller); `EnqueueInput` becomes crate-private. ~15
- K3 dead fields/variants: `EnqueueInput.after_run_id`/`.deadline` (always None in prod, `runs.rs:295`), `RunWaiting::AfterRun` + its WAITING clause (`runs.rs:47-49`), `RunQuery::Queued` (`types.rs:665`). Columns stay (no migration). ~20
- K4 second path: four SQL paths cancel a queued run (`runs.rs:429`, `tasks.rs:198`, `team.rs:188`, `deliveries.rs:76`) → one `cancel_queued(filter, code)`; error codes kept byte-for-byte. (Routing it through `close_request` is V2 and waits for the owner.) ~15
- K5 second path: three `INSERT INTO post` sites (`posts.rs:820-842,285-301,916-920`). ~25
- K6 duplication: "root of a post" written 7×, the `(root_id=?X OR id=?X)` fragment 5×. ~15
- K7 branching: `close_request(state: &str, failed: Option<…>)` (`runs.rs:881-899`) → `Closed::Failed{..} | Cancelled`. ~5
- K8 boilerplate: Workspace row mapped twice, manager CTE twice, ListScope→column twice, `Enqueue` trait with one impl (`runs.rs:131-177`). ~35
- K9 dead: `ids.rs:60-69` (`millis`, test-only `ceiling`). ~5. Stale comments naming removed `Returns` / post-writing schedule fires (`runs.rs:40,383,408-413`, `posts.rs:904`, `deliveries.rs:41`, `node.rs:310`).

**Server Buddies** (`server/src/buddies`)
- B1 dead: `sendAutomation`/`stopAutomation`/`rejectAutomation` (`turn-policy.ts:125-127,219-224,770-776`) and unused host members `view`, `provider`, `refuseAutomationTranscript`, `on`, `emit` (`turn-policy.ts:51-68`); runtime side in T2. ~30
- B2 second path [lease lane]: two settle paths (`SETTLE_RUN`, `port.settle`, `finishChat`, `crateOutcome` vs `finishRun`, `turn-policy.ts:275-318`, `policy-port.ts:48,108-126`). ~35
- B3 duplicated defaults: Builder policy restates ~20 no-op methods of the default policy (`turn-policy.ts:132-225` vs `turns/policy.ts:148-215`). ~35
- B4 branching: four `RunInput` switches (`runner.ts:242,564,585,647`) + `execute`'s kind/conversation check (`:716`) → one handler record per `RunInput` kind; the trigger post is fetched up to 4× per delivery. ~25
- B5 branching [lease lane]: `claimed`/`admittedChatRun`/`execution`/`lease` = one state in four nullables (`turn-policy.ts:338-342`) → `Slot = Idle | Claimed | Admitted | Executing{lease}`. ~15
- B6 fallbacks: `runner.ts:381` (`?? buddy-run-…` after bindRun), `:553`, `!` at `:277-281,622`, `turn-policy.ts:725-732` re-validation, `worker-config.ts:24`. ~12
- B7 second path: `mcpServers` vs `builderMcpServers`, grant issue-then-promote, two pass-through layers for queue/promote/cancel (`policy-port.ts:78-106`, `grants.ts:105-110`). ~20
- B8 branching: MCP `scopeQuery`/`readTaskRows` repeat the same 3-way `in` check (`mcp.ts:137-142,359-364`); one conversion table to napi `ListScope`/`TaskQuery`. Advertised schemas unchanged. ~15
- B9 shim: legacy MCP tool forms (`mcp.ts:103-113,177-187,403-443,900-912,944-958`) exist for turns started before 0554cf1 (2026-10-06 21:12 +0800). The longest a turn lives is `TURN_MAX_RUNTIME_MS` (24 h), so they are dead after **2026-10-07 21:12 +0800**; delete then, with their guard test, and check `runs list` for any running run older than that first. ~75
- B10 duplicates: `execution-gate.ts:36-44` restates default store paths from `core.ts:116,136`. ~3
- B11 routes: snake_case `buddyExecutionPreferences` adapter hand-built at 3 sites (`channels.ts:136`, `briefing.ts:136`); tasks-route nested ternary vs runs-route table (`routes.ts:320-329` vs `257-262`); cursor→before twice; dead archive filters (`routes.ts:397`, `search-channels.ts:27`); `Exclude<SeatRequest,{kind:'resolved'}>` of a non-variant, `MentionDispatch` alias, unreachable `ownerPost` kind check (`routes.ts:236`), 11 exports with no outside caller; `announcePost` re-reads a channel the caller holds. ~45
- B12 duplicated flag tables: restricted-CLI flags in `channel-reply-gate.ts:55-78` and `memory-review.ts:206-285`. ~10
- B13 hidden default: `memory-review.ts:130-137` renders any unknown `ContentPart` as `[swarm launch] …` → exhaustive table. 0
- Stale: `channel-reply-gate.ts:22` (nonexistent file), `briefing.ts:27` ("12 tools", guide names 11 — visible text, left), `runner.ts:463-467,499`.

**Turns and conversation runtime** (not gated, counted separately)
- T1 dead file: `server/src/conversations/await-turn.ts` (no importers; `buddy-turn-started` has no listener). 32
- T2 dead: `sendSessionRelativeMessage`, `sendAutomationMessage`, `stopAutomationTurn`, `SeatTurnInput` (`runtime.ts:453-461,669-673,49,62`; `turns/policy.ts:125-126,212-217`; `input.ts:21`). ~35
- T3 redundant type: `TurnBroadcast` (`turns/runner.ts:120-129`) restates shared frames, with a stale `content` field. 12
- T4 duplicate bodies: `retireInFlightHead` ≡ `finishHead` (`queue.ts:75-78,107-110`). ~12
- T5 dead fallbacks: `activeAttemptId ?? randomUUID()` (`turns/runner.ts:289-303,352`); `start()` busy guard duplicates `runtime.ts:495`. ~10
- T6 dead setter: `kind` setter (`runtime.ts:283-289`). 5
- T7 `OwnerInput` written inline 3× more (`input.ts:18`, `buddy-creation-service.ts:37,41`, `transport/conversation-websocket.ts:81`). ~6
- T8 provider branches in the provider-neutral runner (`turns/runner.ts:600-619`) → harness table. ~6
- (`runner.reset()` kill path, ~25, is reachable only in tests; deleting it means reworking `execution-crash-checker.test.ts`. Deferred.)

## 3. Target types (one canonical type per concept)

Finding: the crate side is already canonical. `RunInput`, `Delivery`, `ChannelRef`, `ChannelKind`
are `#[napi]` enums in `crates/unleashd-buddies/src/types.rs`, generated into
`crates/unleashd-buddies/index.d.ts`, and every TS consumer imports them as types. **There is no
hand-written TS copy of those four.** The duplication is elsewhere:

| concept | canonical | duplicates / hidden variants | target |
|---|---|---|---|
| run input | `RunInput` (`types.rs:147-203`) | **hidden variant**: schedule fire = `Chat` + `conversation_id == None` + `turnId` prefix `schedule:` (`runs.rs:282-289`, `runner.ts:504,578-580,714-718`, client `BuddySchedules.tsx:96`). TS `RunRecord.kind 'chat'|'runner'` and `OwnedChatRun` restate `Run`/`Claim` fields (`turn-policy.ts:275`, `runner.ts:32`). | `RunInput::ScheduleFire` **changes `input.kind` in HTTP rows and the MCP `runs` output → visible; owner decision (O1).** Without it: one TS classifier `runJob(run) → OwnerChat | Fire | Request | Deliver` at the runner boundary so handlers stop re-asking; `RunRecord` becomes `Pick<Run,…> & Pick<Claim,…>`. |
| delivery | `Delivery` (`types.rs:913-923`) | placement decided in TS by null checks inside the `posts` handler (`runner.ts:471-494`); covered roots not carried (V8). | `Delivery::Posts` carries `route: Subscribed | Seat | Own | FollowUp` computed in Rust; `deliverJob` becomes a thin dispatcher. Same placement → invisible, **except** it is the natural place to fix V4/V8, which are visible. Do the type move invisibly first. |
| post target | `ChannelRef`, `PostInput`, `AnswerInput` (`types.rs:121-127,542-576`) | post-vs-answer is two optionals (`channel?`, `answers?`) with the extras-refusal written twice (`mcp.ts:473-487`, `routes.ts:211-226`). | one `toPostTarget(input) → {t:'answer'} | {t:'post'}` used by both entry points; each keeps its own error text verbatim. MCP zod input union stays (it is the advertised tool contract). |
| conversation kind | ingest `ConversationKind` (`crates/unleashd-ingest/src/records/types.rs:198-206`) | hand copy `ConversationKindSchema`/`BuddyVisibilitySchema`/`WorkerRoleSchema` in `shared/src/conversation-config.ts:152-177` (never `.parse`d); background branch = `buddy` + `visibility:'background'` + nullable parent, tested by null checks (`turn-policy.ts:752`, `runtime.ts:331`); "owner chat" inferred from run history (V4). | re-export the ingest type from shared (type-only) if the client build tolerates it, else a compile-time equality check; one `buddyThread(kind)` classifier derived from stored fields (no storage change). Storing it as a sum would be a records migration: **out of bounds.** |

No schema migration is proposed. Rust `BuddyContext.knowledge_scope` drift vs zod is harmless and
removing it would need a data migration (out of bounds).

## 4. Commit sequence (phase 2, after origin/main has keep-awake)

Each commit: one concern, tests named, line gate lowered in the same commit.

1. I1, I2, I3 — invisible bug fixes, each with its failing-first test.
2. Crate dead code: K1, K2, K3, K9 (+ regenerate `index.d.ts`).
3. Crate one-path: K4, K5, K6, K7, K8.
4. Server dead code: B1 + T2, T1, T3, T6.
5. Server one-path: B2 (after reading the merged lease code), B3, B7, B10.
6. Runner/policy types: B4 classifier + handler table, B5 `Slot`, B6.
7. MCP/routes: B8, B11, B12, B13, post-target normalizer (§3).
8. Conversation kind: shared re-export + `buddyThread` classifier; T4, T5, T7, T8.
9. B9 legacy MCP forms, only after 2026-10-07 21:12 +0800 and a `runs list` check.
10. Delivery `route` type move (§3), if time allows; pure placement-preserving.

Visible findings (V*, O1) stay in this note for the owner.

## 5. Line budget (proposed before edits)

| area | @027940c | reviewer est. cut | budget (cut) |
|---|---|---|---|
| crate `src` (gate; excl. migrate.rs) | 5314 | ~150 | −100 |
| `server/src/buddies` (gate) | 5987 | ~350 (incl. B9 75) | −220 |
| **gated total** | **11301** | ~500 | **−320** |
| `server/src/turns` | 2805 | ~35 | −25 |
| `server/src/conversations` | 2574 | ~80 | −60 |

The new ceiling = measured count after the last commit; expected ≈ (count after keep-awake) − 320.
After-numbers are filled in below when phase 2 lands.

## 6. Owner-decision list (one line each)

- O1 Add a `ScheduleFire` run-input kind (run rows and MCP `runs` output show a new kind; fixes V3 at the root).
- V1–V22 as above; recommended bundle: V1, V2, V3, V5, V6, V7 ("make the code do what it already promises").
- V4/V8/V9: one delivery-routing question — move pre-10-07 subscriptions off owner chats and fix covered-thread accounting.

## Results (phase 2)

Two workers, 2026-10-07. Worker 1 (run_01a115b8, answer post_01a115ea-cb63) landed 82f8279..ed6a23e;
worker 2 (run_01a115eb) landed the rest below. No V or O item was touched.

**Commits** (origin/main):
- da9c0d5, 37ea5ac, 1931101, ad689b0 (+b4626ac format), 828848d, 24d1c98: K1/K9 shims, B1+T1+T2
  dead automation surface and `await-turn.ts`, B3 shared `NoRunPolicy`, B2 one settle path, K5/K6
  one `write_post` and `Post::root()`. 05fcf02, ed6a23e: test-only re-syncs.
- e59dd0d: **I1, I2, I3**, each with a test shown failing at ed6a23e (I1: 1 journal left;
  I2: 3 claims after pause, expected 1; I3: receipt `writes.working` 2, expected 1). All three
  stayed invisible on re-check: I1's leftover journal only produced a boot log line, a discard
  and a no-op terminal call (`finishAttempt` ignores terminal attempts); I2's runs start on the
  next backend instead of the exiting one, an ordering the reload already allowed for any write
  arriving after the pause; I3's receipts are `event` rows nothing in server or client reads.
- 4da76ea: T3 `TurnBroadcast`, T6 `kind` setter, T4 `retireInFlightHead`, T7 `OwnerInput`.
- 52dbbc0: K4 one `cancel_queued` (codes and texts byte for byte), K8 (`Enqueue` trait → two
  functions, `workspace_row`, `manages` reused by `reject_cycle`, `ListScope::column`), B8
  `TASK_QUERY`, B11 `profileExecution` (one of the B11 list; see "left").
- 298eff5: one `ConversationKind`: shared re-exports the ingest crate's generated type
  (type-only workspace devDependency, as `buddy-api.ts` does for buddies-core); the unparsed zod
  copy is gone.

**Lines** (gate excludes migrate.rs):

| area | 82f8279 | ed6a23e | final | Δ phase 2 |
|---|---|---|---|---|
| crate `src` | 5334 | 5306 | 5305 | −29 |
| `server/src/buddies` | 6010 | 5947 | 5951 | −59 |
| **gated** | **11344** | **11253** | **11256** | **−88** (ceiling 11256) |
| `server/src/turns` | 2873 | 2871 | 2869 | −4 |
| `server/src/conversations` | 2576 | 2522 | 2519 | −57 |
| `shared/src` | — | 3465 | 3450 | −15 |

Worker 2's own groups are +3 on the gate: the I fixes and their why-comments cost +8, the
refactors returned 5. The −320 budget in §5 was not met; reviewer estimates were inflated
(K4 and B8 remove a second path, not lines).

**Left, in order:**
1. B9 legacy MCP forms (~75 lines): only after 14:00Z 2026-10-07 and a `runs list` check for
   live runs started before 2026-10-06 13:30Z. Worker 2 ran at ~11:00Z, so it was not eligible.
2. Rest of B11: dead archive filters, unreachable `ownerPost` kind check, `Exclude<SeatRequest…>`,
   `MentionDispatch` alias, 11 exports with no outside caller, `announcePost` re-read. The tasks
   route nested ternary stays: a table would change the missing-scope error text (visible).
3. K2/K3 dead napi methods and fields (K2's `list_events` has test callers; keep it or move the
   tests to another read), K7 `Closed` sum, B5 `Slot`, B6 fallbacks, B7, B10, B12, B13, T5, T8.
4. Stale Rust doc comments that still name `ConversationKindSchema`
   (`crates/unleashd-ingest/src/records/types.rs:195`, `markers.rs:213`); editing them rebuilds
   the ingest addon, so they wait for the next ingest change.
5. Delivery `route` type move (§3), then the owner's V/O decisions.

**Test notes:** `posts_read_back_in_write_order_within_a_millisecond` (crate tests/core.rs) fails
its "shared a millisecond" guard whenever the machine is loaded (suite time 39–60 s instead of
1.5 s); it passes alone on every commit here. Server tests that failed only under load and passed
3/3 alone: run-lease freeze, buddies-v2 briefing (ENOTEMPTY in scratch cleanup), dependencies
"first boot installs missing tools once".
