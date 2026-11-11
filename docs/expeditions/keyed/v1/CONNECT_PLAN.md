# Connecting the expedition kernel to the real system

Status: **steps 1 to 7 built and on main, 2026-11-11, behind `UNLEASHD_EXPEDITIONS_V1=1` (off by
default). One real-agent run has passed (§10).** Step 8 (the Buddy tool) and step 9 are not built,
and §10 lists what the real run showed must change before real work runs on it. The plan below
was written from a read-only study of the code at `6a38b5d`; its `file:line` citations are from
that commit, and the "Built" notes in §8 record what each step did. Design: [DESIGN.md](DESIGN.md).

## 0. Findings that change the plan

1. **Gemini cannot run as a Buddy turn.** Its harness declares `mcpCapability: 'none'`
   (`vendor/agent-cli-tool/src/harnesses/gemini.ts:23`); Buddy turns refuse any provider that is
   not `'required'` (`server/src/buddies/turn-policy.ts:113-118`), and so do worker configs
   (`server/src/buddies/worker-config.ts:69-70`). The GTM plan and contract put the judge and the
   done review on Gemini, so GTM cannot run unchanged.
2. **No way to resume another call's conversation (`continues`).** A request run opens a fresh
   `buddy-run-<runId>` conversation (`server/src/buddies/runner.ts:317-331`) and reuses one only
   for its own previous attempt (`runner.ts:363-392`). `PostInput` cannot bind a request's run to
   another conversation (`crates/unleashd-buddies/index.d.ts:427-454`).
3. **No schema-forced output.** Nothing in `vendor/agent-cli-tool/src` takes an output schema and
   the server has no JSON Schema validator. The plan process validates `out` with zod
   (`server/src/expedition-kernel/authoring/index.ts:103-137`), but only after the kernel logged
   `passed` or started a paid judge. The executor must validate first.
4. **Dollar usage is weak.** Per-turn `providerUsage` is last-write-wins context size, not spend
   (`server/src/turns/runner.ts:644-648`). The only dollar source is the ingest store's
   per-request rows priced in `server/src/http/usage-routes.ts:56-87`: all Claude models get one
   flat rate (`:67`), so Opus is under-counted; Gemini, Cursor and Muse record nothing (`:58`).
   `UsageQuery` cannot filter by session (`crates/unleashd-ingest/index.d.ts:528-532`). Ingest
   lags the transcript. Codex's numbers come only from the rollout file (`runtime-types.ts:148-152`).
5. **Every Buddy turn starts a memory review afterwards** (`turn-policy.ts:621-635` →
   `policy-port.ts:147` → `memory-review.ts:539-547`): unbudgeted spend for expedition calls.
6. **Every Buddy turn gets the full Buddy tool set**, including `post` with `worker` (it can spawn
   agents) and `expedition` (`policy-port.ts:119-120`, `mcp.ts:800-813`).
7. **No run-settled event.** The runner emits a bare `{kind:'changed'}` on settle
   (`runner.ts:247`); answers arrive as `posted` (`runner.ts:409`). No lookup from a post to its
   run; the old host scans `listRuns({kind:'buddy'}, 2000)` (`server/src/expeditions/host.ts:460-463`).
8. **Cancelling a queued run leaves its request `awaiting` forever** (`host.ts:283-292`; crate
   `runs.rs:477`, `972-977`).
9. **Run cap per Buddy.** `max_active_runs` defaults to 5
   (`crates/unleashd-buddies/src/schema.rs:44`); capped runs wait `pool_full`. GTM's pools sum to 9.
10. **Port and view shapes.** `Leader.wake(event, view)` has no run id (`ports.ts:80-86`), so a
    wake cannot be idempotent or closed. `ExpeditionView.state` holds Maps (`timeline.ts:44-52`,
    `core/state.ts:70-92`), so it is not JSON. `ProviderOf` is synchronous (`canonical.ts:8-10`).
    No wake for "the owner wrote something" (`types.ts:134-141`).
11. **Rule violations and runtime needs in the kernel.** An unlabelled timer at
    `expedition-kernel/runner.ts:143`. The plan runner needs `tsx` at runtime (`runner.ts:15`), a
    devDependency. The typecheck gate's authoring entry lives in `docs/`
    (`test/expedition-kernel-e2e.test.ts:42-46`).
12. **`RunSpec` carries no repo and no base.** `{t:'launch'}` means the expedition's `baseSha`,
    and `contract.repo` is where checkouts and commands run (`types.ts:83`, `237`). The executor
    recovers both from the expedition id inside the run id
    (`<exp>/<key>@<hash>#<attempt>:<role>`, `test/fixtures/expedition-ports.ts:180-184`). The
    kernel logs `out` but not commits or files, so a judge or later call needs an executor-side
    ref store.
13. **Commands are strings; checks take argv.** `runChecks` takes `string[][]`
    (`checks.ts:136-171`), keeps only a 4,000-character mixed tail (`:202-204`, `:227-230`), has a
    fixed 2 h timeout and a fixed env (`:204`, `:219`).
14. **An old-host GTM record is live**: `gtm-evidence-thesis-buye-dd0984`, `running`, a1 `judging`
    on an owner-judged done.

## 1. Executor over Buddy runs (`server/src/expeditions-v1/executor/`)

**Durable state.** One record per run at `<expDir>/runs/<enc(runId)>.json` (tmp + rename, like
`record.ts:80-86`): `posting{postBody}` → `posted{postId, buddyId, crateRunIds[]}` →
`settled{raw, spent}`, plus `closed` (tombstone); fields `kind`, `deadlineAt`, `tree`. One ref
record per output at `<expDir>/refs/<enc(key@hash)>.json`:
`{out, answerPath, commit, branch, salvageRef, conversationId}`, written before `ok` is reported.
A context registry maps expedition id → `{dir, repo, baseSha, workspaceId}`, read lazily from the
log's `launched` line (`launch.ts:35-42`).

**Agent-backed kinds, common behaviour**

- `start`: write the record, then post with `key: 'xk:' + runId`. The crate replays a key with an
  identical payload and rejects a different one (`error.rs:12`), so the body must be a pure
  function of `(spec, refs)`: no timestamps. A record with a `postId` skips the post; a `closed`
  record makes `start` a no-op.
- `status`: no record → `unknown`; `posting` → `running` (finish the post at boot with the same
  key; never `unknown` here); `posted` → read the post and its runs (`host.ts:275-295`), settle if
  terminal; `settled` → the stored outcome.
- Observing settlement: subscribe to `changed` and `posted`, debounce 1.5 s with a `labelled`
  timer, plus a 60 s `labelled` backstop (pattern at `host.ts:857-883`). Each pass re-reads every
  `posted` record; the backstop is the fallback for a missed event.
- Terminal: every run of the post settled, and no decision-G attempt 2 queued (`runner.ts:368-375`).
- Outcome: answered → parse the answer; cancelled, or awaiting with every run settled →
  `cancelled`; failed → `errored`; minutes timer fired → `errored("exceeded N min")`.
- `cancel`: `core.cancelRun(OWNER, id)` then `events.emit({kind:'cancelled', run})`
  (`host.ts:464-467`). On an ask: no-op.
- `close`: write the tombstone; cancel any crate run under the post still `queued` or `running`.
  That is what "a late start is a no-op" means for a request posted but never claimed.
- Minutes cap: a `labelled` timer at `postedAt + max.minutes`, re-armed from the record at boot,
  then `cancel`, recorded as a timeout. Never `user_stop` semantics or the lease.

**Per kind**

| Run kind | Created by | Runs as | Answer |
|---|---|---|---|
| agent `by: buddy` | `core.post(buddyActor(id), self-DM, {kind:'request', purpose:'expedition_call', evidence:['expedition-run:'+runId], key})` (shape of `host.ts:422-435`) | the named Buddy, its profile | final text |
| agent `by: seat` | the same post from the **seat Buddy** with `runConfig: checkedRunConfig(...)` (`worker-config.ts:63-79`) | one workspace seat Buddy (D1) | final text |
| review judge | as above; body = rubric + the `of` ref | `spec.by` | `{verdict, why}` → `ok` / `no` |
| leader wake | §2 | the leader Buddy | a `LeaderAct` |
| command | host process: extended `runChecks`/`runOne` (`checks.ts:136-271`) in a detached worktree at the launch base or a ref's commit | host | exit 0 → `ok{out}` (stdout JSON when `output ≠ null`, else `{tail}`); non-zero → `no(tail)` |
| check judge | the same at `of`'s commit, `EXPEDITION_OUTPUT=<out.json>`, oracle files restored from the base (`checks.ts:156-158`) | host | exit code |
| ask | an owner-thread post (§2) | owner | text, or boolean for `confirm` |

- Commands across a restart: the record stores the process group id. At boot a `running` command
  has its group killed and settles `errored("host restarted during command")`; retry is explicit.
- Checkouts: `cambium add` (`cambium.ts:46-54`) in `contract.repo`, base = launch sha or the
  ref's commit, branch `expedition/<expId>/<slug(key)>-<hash8>-a<attempt>`. At producer end
  `tip()` (`cambium.ts:106-113`) gives the commit, then `release` to a salvage ref
  (`cambium.ts:64-74`). A cancelled call's salvage ref is its `partial`. `tree:'none'` runs in
  `<expDir>/runs/<id>/work`, never the owner's checkout (`briefing.ts:18-20`).
- Turn directory: add `{t:'call', runId, path}` to `TurnDirectory` (`briefing.ts:21-25`); the
  resolver (`server.ts:354-359`) maps a run whose post has `expedition-run:` evidence to it.
- Tools: a grant role `'call'` with an empty `toolsFor` (`mcp.ts:800-813`), chosen when the
  briefing is a call directory (`policy-port.ts:116-128`). With no tools the answer can only be
  the final text. `afterTurn` skips call turns (no memory review).
- Typed answer: last fenced json block (or the whole body) → `JSON.parse` → validate against
  `call.output`; failure is `errored("malformed answer: …")` before anything is judged.
- Usage: conversation `buddy-run-<crateRunId>` → its `currentSession`
  (`conversations/config-records.ts:152`) → ingest `usage(...)` grouped by session, filtered →
  priced by a per-model table (moved out of `usage-routes.ts:66-87`). Wait up to about 60 s for
  ingest, else `unreported` (the kernel charges the whole reservation). Poll every 60 s and
  cancel a call at 100% of `max.usd`.
- `continues`: does not exist. v1 degrades to a soft handoff: the earlier call's answer path and
  conversation id go into the brief.

## 2. Leader and Owner (`expeditions-v1/leader.ts`, `owner-thread.ts`)

- Kernel change: `wake(runId, event, view)`, run id computed at `kernel.ts:366-371`; settle
  already closes it (`kernel.ts:330-331`); recovery already settles an orphaned wake `errored`
  (`recovery.ts:32-38`).
- A wake is a leader-authored self-DM request, key `xk:<runId>`, role `'call'`. Its turn directory
  is `<expDir>/drafts/<n>/`, pre-filled with `plan.expedition.ts`, a copy of `plans/v<current>.expedition.ts`
  with the inline owner contract. The prompt is a compact projection of the view: goal, spent/reserved/budget,
  deadline, plan version, the event, one row per key (kind, attempt, outcome, why, spent, ref
  path), pending asks, the last 10 faults, owner notes, the folder paths. The answer is parsed
  with `LeaderAct.safeParse`; invalid → `errored`.
- Write access is by cwd only (Codex sandboxes writes to cwd; Claude does not). Accepted for v1.
- `dispose` reads `dispositions.json` from the draft folder; missing → `{}` → the rules gate
  rejects `undecided` and the next wake shows it (`change.ts:184-188`, `134`).
- Owner thread: one thread per expedition in the owner↔leader DM, root key `xk:<id>:thread`.
  Reuse `inform` / `postStatus` / `freshPosts` / `pageAfter` (`host.ts:229-253`, `481-521`),
  extracted to `buddies/owner-thread.ts`. An ask is its own keyed root; the first owner reply is
  the answer. `Owner.approve` is a keyed post resolved by a bare `approve`/`decline` or the route;
  it lives in memory, and a restart re-wakes the leader (`kernel.ts:514`). Bare commands at the
  root: `pause`, `resume`, `stop`, `extend Nh`, `retry <key>` (parsed like `brief.ts:117-135`).
  Other talk is stored as a note shown at the next wake.
- `HostCommands.consumes(channelId, body, replyToId)` must take the thread
  (`buddies/routes.ts:178-181`, `:215`), or an owner reply starts an unbudgeted leader turn
  (`routes.ts:223-225`).

## 3. Boot and shutdown

- Open every unfinished expedition at `server.ts:1099`, after `adoptExecutions`
  (`server.ts:1078-1096`) and before the runner starts (`server.ts:1041`); its own boot phase.
- Only when the execution gate is enabled (`execution-gate.ts:31-43`) **and**
  `UNLEASHD_EXPEDITIONS_V1=1`. Otherwise serve a read-only view folded from `log.jsonl` without
  `LogStore.open` (it truncates a torn last line, `log-store.ts:87-91`).
- `interruptBootLive` is unnecessary for v1: calls run on ordinary Buddies, so their turns are
  adopted (`adopt-executions.ts:207-213`). The crew special-casing (`adopt-executions.ts:170-173`,
  `191-224`; `shutdown.ts:7-8`, `27-29`, `110-112`; `server.ts:875-879`; `policy-port.ts:14-27`,
  `111`; `turn-policy.ts:190-192`; `briefing.ts:170-172`; `server.ts:1067-1075`, `361-367`) stays
  until the old host is gone.
- Shutdown: in `flushState` (`server.ts:863-874`), `detach()` every kernel and kill command
  process groups. Leave Buddy turns running.

## 4. API, wire types, UI

- Routes under `/api/buddies/keyed-expeditions`, registered before the Buddy routes
  (`expeditions/routes.ts:6-7`): `GET /` rows; `GET /:id` view; `POST /:id/act`
  (`pause|resume|extend|stop|retry key`); `POST /:id/asks/:ref`; `POST /:id/approval`;
  `POST /preview {file}` (dry-run diff and cost, writes nothing); `POST /launch
  {workspaceId, file}` (base from `resolveBase`, `checks.ts:35-59`). Mutations go in
  `shared/src/buddy-api.ts` beside `'expedition.act'` (`:356-368`).
- To `shared/src/expedition-keyed.ts`: all of `types.ts`; `Bar`, `BarEnd`, `Marker`, `Timeline`,
  `Fault` and the pure `timelineOf`; new `KeyedRow` and `KeyedView` (a JSON projection with lanes
  grouped by key on the server, markers, pending asks with text, pending approval, spent,
  reserved, budget, deadline, faults). Export as a namespace (`export * as keyed`): names collide
  with the old `shared/src/expedition.ts`.
- Client: a `ChannelsView` kind `keyed` (`channels-view.ts:31-32`); `RailExpeditions` lists keyed
  rows (`ExpeditionRail.tsx:36-45`); a `KeyedExpeditionView` reusing `Frame`, `Gone`,
  `ChannelLoader` and the pill styles (`ExpeditionView.tsx:50-81`) with one Timeline tab: a lane
  per key, bars coloured by outcome, plan-version markers, review ticks, pending asks with an
  answer box, act buttons.
- Client rules: `usePolledFetch(url, ms)` only; all hooks before any early return; no list
  derivation in `useMemo`; `jotaiStore.set` only in `atoms/`; shells never import each other;
  width `@media` only in shell CSS; later schema fields get `.default(...)`; a 404 or 503 renders
  as "not available".

## 5. The `expedition` Buddy tool

Replace `draft` (`tool.ts:67-89`) with `propose {file}` (the Buddy writes the file with its
own file tools; the tool runs the preview, returns gate issues and cost, and on a clean pass posts
a keyed card in the origin thread, `tool.ts:31-37`, `host.ts:933-936`), `status {id}` and `list`.
No acts from the tool in v1: only the owner steers.

## 6. Coexistence and cut-over

- Data root `~/.agent-viewer/expeditions-v1/`; the old loader skips directories (`record.ts:25-36`).
- Both hosts run side by side. The old GTM record stays on the old host until the owner gives it
  a verdict or stops it.
- Deleting the old host, in order: remove `draft` when `propose` ships; wait for no `running` or
  `paused` old records and retire them; delete `host.ts`, `brief.ts`, `record.ts`, `retire.ts`,
  the old `routes.ts` and `tool.ts` (move `cambium.ts` and `checks.ts`); delete the crew machinery
  in §3; delete the old shared types and client views.

## 7. Safety

Where this can spend money, start agents or touch a repo:

1. `open` at boot (recovery re-issues starts, `recovery.ts:57-58`): behind the gate and the flag.
2. `launch`: owner HTTP only, never from the tool.
3. Leader wakes and done reviews: bounded by the contract's `leaderWake` and `doneReview`
   (`defaulted` from the budget when the owner names none: DESIGN §5).
4. The memory reviewer after each call: suppressed.
5. Owner replies in the leader DM waking the leader: consumed.
6. Decision-G automatic resume (`runner.ts:382-391`): inside the call's reservation.
7. UI retry and cancel on `expedition_call` runs (`index.d.ts:67`, `79`): refused for that purpose.
8. `resolveBase` fetches `origin` (`checks.ts:44`); Cambium creates branches and worktrees in
   `contract.repo`; commands run plan-authored text on the host with a scrubbed env.
9. Plan child processes are sandboxed (`expedition-kernel/runner.ts:58-111`).

Before the first real run on the live stores: gate enabled and flag set; `tsx` and `typescript`
available to the running server; the seat Buddy exists with `maxActiveRuns ≥ Σpools`; the leader
Buddy resolves; the plan has no Gemini calls; the check scripts exist in the target repo; a smoke
expedition passes on a scratch repo ($3 / 1 h: one agent, one check, one ask, one kill and restart
mid-call); ingest dollars match the provider dashboards for one Claude and one Codex call; memory
review suppression verified; the `'call'` role shows no tools.

## 8. Steps (the first real GTM run is reachable after step 7)

Built (2026-11-10, uncommitted at the time of writing): **steps 1 and 2.** The canonical types,
the timeline fold and the wire projection (`KeyedRow`, `KeyedView`) are
`shared/src/expedition-keyed.ts`, exported as `keyed` (the server reads `shared/dist`: rebuild with
`pnpm --dir shared run build`); the projection is `expedition-kernel/projection.ts`;
`Leader.wake(runId, …)`; the real clock is `expedition-kernel/clock.ts`; the typecheck gate checks
plans against `authoring/index.ts` itself (the docs `expedition.d.ts` re-exports it); commands are
tokenised by `expedition-kernel/argv.ts` and the static gate refuses shell syntax. The executor core
is `server/src/expeditions-v1/executor/` (records, refs, context, commands and check judges; agent,
review and ask runs settle `errored("not implemented: <kind>")`), tested by
`server/test/expeditions-v1-executor.test.ts`. Choices the plan left open: a `check` run spec now
carries `maxMinutes` (its call's `max.minutes`); a command runs in a detached `git worktree`, not a
`cambium add` (it keeps no commits, so it needs no branch); the context holds no `workspaceId` yet
(step 4 needs it and the launch line does not have it); record and ref file names are a slug plus
24 hex of the id's sha256 (keys can be long and hold any character).

Built (2026-11-11, uncommitted): **step 4.** Agent calls and review judges are Buddy requests in
`server/src/expeditions-v1/executor/calls.ts` (records `posting` → `posted` → `settled`; key
`xk:<runId>`; purpose `expedition_call`; evidence `expedition-run:<runId>`), with the typed answer in
`answer.ts`, the request body in `request.ts`, the seat Buddy in `seat.ts`, usage in `usage.ts`
over the shared price table `server/src/providers/pricing.ts`, the turn directory in
`expeditions-v1/call-directory.ts` and named-Buddy providers in `expeditions-v1/providers.ts`. Live
hooks, each inert unless the run's request carries purpose `expedition_call`: the `call` grant role
(no tools; `tools/list` still answers), `TurnDirectory.call`, no memory review after a `call` grant
(`grants.ts` `REVIEWS_MEMORY`), and the owner's / a Buddy's run cancel and retry refused
(`buddies/expedition-calls.ts`). Tests: `expeditions-v1-agent-runs` and
`expeditions-v1-agent-restarts`, on a real backend that runs the executor inside it
(`test/fixtures/expedition-backend.ts`). Choices the plan left open: `launched` carries
`workspace` (`{t:'none'}` by default for older logs, and an agent call there errors); a review run
spec carries its call's `max`; status never settles (a settle can wait up to 60 s on ingest, and
boot recovery reads every status in the kernel's queue), it schedules an observation; the settled
record keeps its `stop`; a cancelled agent call stores a ref with `out: null` (its partial: base
commit or branch tip, and the salvage ref); the seat's run cap only grows, to max(12, Σ pools).
Known limits: the crate has no per-request deadline, so a capped call's crate run reads "cancelled
by request" (the executor's record says `stop: minutes|usd`); no per-model price exists for any
Codex model, so a Codex call reports `unreported`.

Built (2026-11-11, uncommitted): **steps 3 and 5.** One composition, `createKeyedHost(deps)` in
`server/src/expeditions-v1/host.ts`, builds the executor, the real Leader and Owner ports, the
owner's thread and `consumes` from the old host's dependencies plus conversation records, ingest
and the installed agent; step 6 calls `start()`, `open(id)`, `launch(...)`, `view(id)`,
`answerAsk(id, ref, answer)`, `answerApproval(id, yes)`, `close()` and puts `consumes` in front of
the Buddy routes' HostCommands. `launch` and `open` refuse while the execution gate is closed.
Asks are `executor/asks.ts` (records `asking` → `asked` → `settled`; the answer is read from the
ask's own thread on every observation); the expedition's thread, its asks' roots, the read mark and
the owner's notes are `<expDir>/owner.json` (`owner/book.ts`, which also answers `consumes`
synchronously); the owner's replies are read by `owner/inbox.ts`; one grammar for both hosts is
`owner/words.ts` (the old `brief.ts` `chatAct` now reads it; its behaviour is unchanged). The
leader is `leader.ts` + `leader-brief.ts`, a `leader`-kind Buddy call in `executor/calls.ts` whose
end goes to the waiting wake, never to the kernel's `onSettled`. The Owner port is
`owner/approvals.ts`. Kernel changes: `Woken` is a sum (`acted` | `errored`, both with `spent`),
`Leader.dispose(at, diff, dropped)` gets the expedition and file and returns `Disposed`
(`decided` | `invalid`: an unreadable `dispositions.json` rejects the rewrite with its reason),
`RewriteForOwner` names its expedition, `ExpeditionView` carries `entries`. Tests:
`expeditions-v1-owner` and `expeditions-v1-leader`. Choices the plan left open: `consumes` takes
every owner reply under a root this host posted (the thread, an ask, and any reply the bus announces
under them), never a channel-root post (one leader DM can hold several expeditions); a command is
applied at most once (the read mark moves first: a crash loses it, unacknowledged, rather than
applying an `extend` twice), a note exactly once; every command, note and refusal gets one keyed
status line; a `confirm` ask takes `yes y yeah yep ok okay confirm confirmed approve approved
accept accepted pass true` / `no n nope nah decline declined reject rejected fail false`
(case-insensitive, trailing `.`/`!` ignored) and answers each other reply once; a stored ask answer
is a ref like any output; a rewrite must name its own draft plan.expedition.ts file (a relative path is read from
it); approval requests get a fresh key each time (a re-submitted rewrite posts again); a wake and a done
review are bounded by the contract's caps (first run: a fixed $2 / 20 min, see F3). Known limits: an owner reply that lands
before `start()` has loaded the `owner.json` files is not consumed (it wakes the leader, as before
this step); one in an expedition the host has not opened is consumed but read by no inbox; the Buddy briefing still appends its generic "Answer it with
`post({ answers })`" line to call and wake requests, which have no tools (the final message is the
answer either way).

Built (2026-11-11, uncommitted): **step 6.** `server/src/expeditions-v1/service.ts` is the one value
server.ts talks to, in one of two modes decided once at composition: **live** (execution gate
enabled AND `UNLEASHD_EXPEDITIONS_V1=1`) or **read-only** (anything else: rows and views folded
from `log.jsonl` by `shelf.ts` through `log-store.ts` `readLog`, which never opens for write; every
POST answers 503 with the reason; `consumes` is false; no boot phase, timer or directory). Live mode
`require`s the host lazily (its module graph cost 140-410 ms under tsx; guard: the first test of
`expeditions-v1-server`). Boot: the owner books load in `initialize` before the server listens
(`expeditions_v1_books`), which closes the step-5 race (no request, POST or not, can arrive
first); after adoption and before the runner, `expeditions_v1_open` starts observing and opens
every expedition whose plan is open or which still has a live call. Shutdown (`flushState`):
`close()` detaches every kernel (kills its plan process) and kills every command/check process
group, leaving their records `running` so the next live boot reaps them `errored` (D6); Buddy turns
go on. Routes: `expeditions-v1/routes.ts`, bodies and statuses from `buddyMutations['keyed.*']`
(new: `keyed.preview`, `keyed.launch`); mutations answer the refreshed `KeyedView` (launch 201),
409 refused, 404 missing, 422 a launch gate `{gate, issues}`, 400 a bad body naming the field.
Wire: `Bar.cost` (`holding | spent | charged | unknown`), `KeyedRow.needsYou`, `KeyedRow.workspace`
(the `LaunchWorkspace` sum, not a nullable id), each with a wire default. The call turn's prompt
says its final message is the answer (`buddies/expedition-calls.ts` `requestSeatOf`, used by the
runner and `call-directory.ts`). Test: `server/test/expeditions-v1-server.test.ts` (the real
server.ts, HTTP only). Known limits: with the flag off, an owner reply in an old expedition's thread
is ordinary DM talk again (it wakes the leader); the leader's approval lives in memory, so a
read-only view never shows one.

| # | Change | Test through a real boundary | Risk |
|---|---|---|---|
| 1 | Kernel: `wake(runId, …)`; `labelled` timer at `runner.ts:143`; a real `Clock`; types and `timelineOf` move to `shared/src/expedition-keyed.ts`; the `KeyedView` projection | e2e suite unchanged; a projection JSON round trip | low |
| 2 | Executor core: records, ref store, context registry, commands and checks (`runChecks` gets a timeout, extra env, a stdout buffer; tokenise, and refuse shell metacharacters in the static gate) | kernel + executor on a temp git repo with real `sh` commands and a scripted leader; kill mid-command → `errored` | low |
| 3 | Owner thread and asks: `owner-thread.ts` out of `host.ts`; `consumes(…, replyToId)`; the answer route | real core on temp stores: a reply settles the ask; a consumed reply wakes nobody | medium |
| 4 | Agent runs: post and key, status from the crate, watcher, cancel and close, minutes cap, `'call'` role, `TurnDirectory.call`, memory-review skip, JSON Schema validation, ingest usage, the seat Buddy | real backend with a fake `claude` on PATH (the `execution-adoption` harness): one crate run per run id across a SIGKILL; malformed → `errored`; close on a queued run → never claimed | high |
| 5 | Leader and Owner ports: draft folder, `dispositions.json`, approval post | a fake-CLI leader writes `plan.expedition.ts` → a `plan` v1 entry; a rejected rewrite → a `rejected` wake | medium |
| 6 | Host composition, boot, flag, read-only mode, routes, shutdown detach | real server: launch the fixture plan, kill the backend mid-call, the next backend adopts and the call settles once; a copied store refuses launch | medium |
| 7 | Client timeline view and rail rows | `pnpm screenshots` on a throwaway server; a unit test on the view model | low |
| → | **First GTM run** (judges on Claude/Codex, small budget) | | |
| 8 | Tool `propose` / `status` / `list`; remove the old `draft` | an MCP call over temp stores | low |
| 9 | Later: crate run-by-post lookup; real `continues`; a Gemini path; per-model rates; delete the old host | | |

## 9. Decisions (the recommendation is what gets built unless the owner says otherwise)

| # | Decision | Recommendation |
|---|---|---|
| D1 | Who runs anonymous seats | One workspace "Expedition seat" Buddy (empty soul, `maxActiveRuns` 12), so the leader's memory and run slots stay clean |
| D2 | Gemini judges in GTM | First run: Codex judges the Claude steps and Claude judges Codex's `attack`; a Gemini path outside Buddy turns later |
| D3 | `continues` | Soft handoff in v1; the crate binding after a run shows it matters |
| D4 | Memory review on expedition calls | Off |
| D5 | Unreported usage | Charge the whole reservation; add per-model prices before trusting Opus spend |
| D6 | A command interrupted by a restart | `errored`, explicit retry |
| D7 | Owner talk in the expedition thread | A note shown at the next wake; no paid wake |
| D8 | Acts through the Buddy tool | None in v1 |
| D9 | Flag and namespace | `UNLEASHD_EXPEDITIONS_V1=1`, `/api/buddies/keyed-expeditions`, `~/.agent-viewer/expeditions-v1/` |
| D10 | The live old GTM record | The owner gives it a verdict or stops it; the old host is deleted only after |
| D11 | `grant.reads` / `web` | Superseded 2026-11-11 (F1): each turn kind has a capability set (`server/src/expedition-kernel/access.ts`) that agent-cli turns into the harness's own flags; the preview reports each grant enforced or advisory |

## 10. The first real run, and what is open (2026-11-11)

**Format changed after these runs:** authoring, propose, preview and launch now use one
`<name>.expedition.ts` file (`file` on the wire), with the owner contract and all briefs/rubrics
inline. Versions are `plans/v<N>.expedition.ts`; drafts contain one editable plan file. The
contract arrives first over IPC; rewrites still cannot change it. No live keyed expeditions
exist, so no migration or folder compatibility path is provided. The run evidence below records
the earlier format, not another supported authoring path. See [DESIGN.md](DESIGN.md) §2.

The conversion's full-suite run exposed a reply-publication race (one failed test process): a
question could be read before the owner book indexed it, so a fast reply bypassed consumption.
Owned ask and expedition roots now enter the synchronous reply index before the book write can
yield, and the shared owner-thread publisher awaits registration/durability before announcing.
Guard: `expeditions-v1-owner`, which holds the book write open while reading and checking consumption for the
already-visible roots; the affected server suites pass after the fix.

One expedition ran with real agents on a throwaway server with fresh stores, using the installed
`claude` and `codex` CLIs and their existing logins: a Claude seat call judged by a host command,
a Codex seat call judged by a Claude review, one leader wake at a review, one owner question, and
done criteria of a command plus an owner acceptance. It finished `met` in 3 min 43 s with 4 agent
turns and $0.58 recorded of a $3 budget. Every answer parsed first time. The backend was
SIGKILLed 3 s into the first call; the next backend adopted the turn and the call settled once.
For the Claude calls the recorded cost equals the transcripts' token counts at the rates in
`server/src/providers/pricing.ts`, to the last digit. Evidence is in the gitignored
`output/expedition-smoke-2026-11-11/` (log, prompts, raw answers, transcripts, screenshots).

Not covered by that run: the live stores and the owner's real server; Codex as leader; a leader
rewrite with a real agent; a checkout call that commits; a named Buddy with memory as a seat; a
fan-out wider than one call per provider.

### Findings to act on, most important first

| # | Finding | Evidence | Proposed change |
|---|---|---|---|
| F1 | **A call turn is not tool-less.** The `call` role removes the Buddy tools only. Claude ran with `--tools default` and bypassed permissions (sub-agents, web, file writes, shell, cron and remote triggers); Codex ran with `danger-full-access`. A brief's "do not change files" and "no web" are advice (D11). | the leader wake's `init` event and the CLI command lines in the run's watch log | Pass a restricted tool list and permission mode per call through `vendor/agent-cli-tool` (each harness's own flags), derived from the call's `grant`; report each grant as enforced or advisory in the preview |
| F2 | **Calls inherit the owner's global agent instructions.** Codex's prompt began with the global AGENTS.md (3,057 characters). Each Claude call wrote 14-15k cache tokens, which suggests CLAUDE.md loads too (not verified). | the Codex rollout's first message; the Claude usage rows | Decide whether a call should load them. If not, run calls with the harness's "no user instructions" setting; either way record the choice in the brief header |
| F3 (done) | **A leader wake reserves $2 whatever the budget.** `DEFAULT_LIMITS` in `server/src/expeditions-v1/host.ts`, with no override. On a $3 budget it held most of it while spending $0.04. | budget after step 2: $0.54 spent, $2 reserved | Put the wake and done-review caps in the contract, defaulting to a fraction of the budget |
| F4 | **A call's prompt is kept nowhere in the expedition directory.** A closed run record drops the posted body and the journals are deleted at settle. | the run's `runs/` records | Keep the rendered brief beside the ref (it is already part of the call's hash) |
| F5 (done: the ask post and the view carry the candidate summary and answer-file path (`AskAbout`)) | **The owner is asked to accept an opaque ref.** The done question shows `rank@<64 hex>`, not the result. | the live screenshots | Show the candidate's summary and a link to its answer file in the ask and in the view |
| F6 (done: Codex models are priced from OpenAI's published rates (`providers/pricing.ts`); a model off that page stays `unreported`) | **Codex and every non-Claude model are `unreported`,** so each is charged its whole reservation. Safe, but the budget then measures reservations, not work. | $0.50 of the run's $0.58 | Add rates for the models in use, or count tokens from the Codex rollout |
| F7 (done: `continue` carries a required `why`) | **The leader's `continue` carries no reason** in the timeline, though it explained itself in prose. | the review marker's empty "why" | Add `why` to the `continue` act |
| F8 (done: one words table by call kind and state (`keyed-timeline.ts`)) | **Wording.** A waiting ask reads "Why: Still running."; an owner-accepted criterion reads "Its judge passed it." | the screenshots | Say "Waiting on you" and "You accepted it" |

Also known and not fixed: the time and dollar caps end a turn through the cancel path, so the
crate run reads as cancelled by request (needs a per-request deadline in the crate); a pending
rewrite approval lives in memory and is abandoned by a restart; the typecheck gate needs `tsc`,
which is a devDependency, so a published install cannot run it; real CLIs leave a project folder
per temp path in the owner's home.

### Next work, in order

1. F1 and F2: what a call may do and what it is told. Nothing unattended should run before these.
   **Built 2026-11-11, F4 too** (see "F1, F2, F4 as built" below); the second real run confirms
   the limits with the real CLIs.
2. F3 to F5 and F7, F8: small, and they make a run legible to the owner.
3. A second real run covering what the first did not: a leader rewrite, a checkout call, Codex as
   a seat with a rate, a 5-wide fan-out.
4. Step 8: the Buddy tool (`propose`, `status`, `list`) and a launch button, so an expedition is
   started from the app and not from an HTTP call.
5. Turn the flag on for the live server and run the GTM case with its judges off Gemini (D2).
6. Step 9: delete the old host once its last record is settled (D10), real `continues`, the crate
   deadline.

### F1, F2, F4 as built (2026-11-11)

- **One policy table**, `server/src/expedition-kernel/access.ts`: a `call` (`tree: none`) reads
  its inputs' directories and `grant.reads` (relative to the repo), writes nothing, no shell, web
  only with `grant.web`, no instructions; a `checkout` call reads and writes its worktree with a
  sandboxed shell, web only with `grant.web`, the repository's own instructions; a review `judge`
  reads the judged output and its producer's read roots, nothing else; a `leader` wake reads the
  expedition directory and writes only its draft folder. Every turn: no sub-agents, no scheduling
  or remote triggers, no MCP server, never the owner's user-level instructions or memory.
- **The canonical set** is agent-cli's `TurnCapabilities` (a sum, no optional fields), passed as
  `capabilities` on the turn request; each harness config maps it to its own flags and reports
  each capability `enforced` or `advisory(reason)` (`capabilityReport`). A request without one
  builds the same argv as before, pinned by `vendor/agent-cli-tool/test/capabilities.test.ts`.
- **Claude**: `--tools` (the whole visible set), `--permission-mode dontAsk` and
  `--permission-prompts none` (a refused tool returns an error result, nothing waits),
  `--setting-sources ""` or `project` (CLAUDE.md follows the sources: verified in 2.1.322, and the
  smoke transcripts show the 2,251-character global CLAUDE.md in every call),
  `permissions.blockReads/WritesOutsideWorkingDirectories`, `--add-dir` per read root, an
  `Edit(//dir/**)` pre-approval for the one writable directory, Claude's sandbox for Bash,
  `--strict-mcp-config` with no servers, `--disable-slash-commands`. All enforced, except reads
  once a shell is granted (the sandbox does not confine reads).
- **Codex**: `--ignore-user-config` (drops the owner's MCP servers, plugins and
  `danger-full-access`), `--ignore-rules`, `approval_policy="never"`, `-s read-only` or
  `workspace-write` (cwd only, no network, TMPDIR and /tmp excluded), `web_search`, features off
  (multi-agent, apps, plugins, hooks, browser and computer use, local automation),
  `project_doc_max_bytes=0` when no instructions. Advisory: reads (the sandbox does not confine
  them), shell off (Codex reads through its shell), agents (**not held**: the second run's seat
  call started a sub-agent through `collaboration.spawn_agent` with `multi_agent` and
  `multi_agent_v2` disabled), instructions (`$CODEX_HOME/AGENTS.md` always loads, and so does a
  listing of the owner's skills).
- **F4**: every call's, judge's and wake's exact request body is kept at
  `runs/<name>.prompt.md` beside its record, written before the post and never rewritten; each
  view bar names its producer's and judge's prompt files (`Bar.prompts`).
- **Known gaps**: grant paths are passed as directories (a file path is not narrowed); the other
  harnesses run unrestricted with every grant reported advisory. (A review judge of a checkout
  call could not read the branch's files until the fixes below.)

### The second real run (2026-11-11)

One expedition on a throwaway server (fresh stores, the committed code in its own worktree, the
installed `claude` 2.1.322 and `codex` 0.160.0): a 3-wide Haiku fan-out judged by host checks, a
Claude and a Codex probe call (`tree: none`; the Codex one judged by a Claude review), a Claude
checkout then a checkout on top of it, a review, an owner question, done = check + owner. It
finished `met` after 16 agent turns, $0.43 recorded. Evidence: the gitignored
`output/expedition-run2-2026-11-11/`.

- **Limits held with the real CLIs, except Codex sub-agents.** Claude `tree: none`: tools were
  exactly `Read,Grep,Glob`; reads outside its roots (a sibling repo directory, a temp file,
  `~/.zshrc`) refused by `blockReadsOutsideWorkingDirectories`; no write, shell, web, Task or Cron
  tool. Claude checkout: Write and Bash writes outside the worktree refused, Bash network denied by
  the sandbox, no web tool, the repo's CLAUDE.md loaded. Leader: Write outside its draft refused,
  no shell. Codex seat: writes and network refused, no web search, the canary outside its roots
  readable (advisory, as reported), but **`collaboration.spawn_agent` worked**; the report now says
  so (agent-cli `codex.ts`).
- **Fixed: a Codex checkout could not commit.** `workspace-write` makes only the cwd writable;
  a linked worktree's `index.lock`, objects and branch ref are in the main repo's `.git`. A
  checkout's capability set now names that metadata (agent-cli `TurnGit`, resolved from the made
  worktree by `worktreeGit` in `executor/calls.ts`), and Codex gets it as
  `sandbox_workspace_write.writable_roots`; the repo's `.git` itself stays read-only. Verified
  without a model turn (`codex sandbox` with the run's exact policy) and by
  `expeditions-v1-worktree-git`; not yet by a real Codex checkout. Claude's sandbox already
  handles a linked worktree.
- **F2 and F4 hold.** None of the 14 Claude transcripts holds the global CLAUDE.md (the first run's
  each held it twice); cache writes fell to 2.8-5.4k on a seat call. Every turn's stdin contains its
  kept prompt file verbatim. Codex still loads the global AGENTS.md and a skills listing (advisory).
- **Fixed: Claude spend was under-counted by about 27%.** Every Claude turn wrote its cache at the
  1-hour tier (`cache_creation.ephemeral_1h_input_tokens`); `providers/pricing.ts` priced cache
  writes at the 5-minute rate (1.25x input, not 2x), and the ingest rows did not split the tiers.
  Recorded $0.332 against the CLIs' own $0.455. See "Fixes after the second run".
- **Fixed: a rejected leader act re-woke the leader at once, with no limit but the budget.** The
  leader answered `retry` for a `failed` call twice (2 wasted wakes). The act list and the
  `ended-unmet` line now say retry is only for errored, cancelled or refused calls, and two
  rejections in a row now go to the owner.
- **Fixed: the preview** reported access only for first-wave calls, so checkout calls behind the
  first wave were not previewed.

### Fixes after the second run (2026-11-11)

- **A review judge reads the code it judges.** The judge of a call whose ref has a branch (a
  `tree: checkout` producer) runs with tree `judge-checkout` (`executor/records.ts`): a detached
  checkout of exactly the judged commit at `<run>/tree` (`addDetachedTree` in
  `expeditions/checks.ts`, the half of `withDetachedTree` that outlives one call; HEAD verified),
  added to its read roots, and `git diff <base> <commit>` written to `<run>/work/changes.diff`,
  its cwd, so it needs no shell. The ref records the call's base for this (`RefRecord.checkout.base`;
  a branch ref stored before it does not parse). The prompt opens with a `THE CODE` section naming
  both; when the producer committed nothing it says so ("the diff is empty; judge it as work that
  changed nothing") and the judge still runs. The checkout is removed when the judge ends (settle,
  close, refused post) and remade, HEAD verified, if a restart replays the post. Still read-only,
  no shell, no web: the `judge` row of the policy table is unchanged; a judge of a `tree: none`
  call is unchanged. Guard: `expeditions-v1-agent-restarts` (a committed and an empty checkout).
- **Cache writes are priced by tier.** The ingest crate records, per usage turn, the part of the
  cache write at the 1-hour tier (`usage_turn.cache_write_1h`, from Claude's `cache_creation`
  split; `UsageGroup.cacheWrite1H`). A record that names no tier (an older Claude CLI, OpenCode,
  pi) counts it all as 1-hour, and so do rows written before the column (NULL): a budget never
  under-counts. The column is added to an existing store at open, no schema bump. `priceUsd` uses
  1.25x input for the 5-minute part and 2x for the 1-hour part (claude-api skill); the usage
  panel's estimate is unchanged. The run's `probeClaude` row now prices at $0.0319513, the CLI's
  own figure (was $0.0238993). The owner's backend needs a restart to load the new addon.
- **Two rejected leader acts in a row at one wake point ask the owner.** Each act's fate is logged
  (`act` entry: accepted, or rejected with the gate's issues); the fold keeps the run of rejections
  per wake point (`State.leaderActs`), so a restart between them keeps the count. At two the host
  stops waking the leader there and asks the owner in the expedition thread (key
  `owner/leader-stuck-<n>`, naming the event, both acts and their reasons): `continue` (go on as
  planned), `stop` (not met), or `rewrite` (one more wake, telling the leader the owner waits for a
  rewrite). The answer is logged as the owner's `leader-stuck` act; a reply that names none of the
  three is asked again. An accepted act, an applied plan or the ruling clears the count. The rule
  that a second rewrite with no new judged pass goes to the owner is unchanged (and a rewrite the
  owner declines counts as a rejected act). Guard: `expedition-kernel-e2e` (two rejections across
  a restart, one ask, no third wake; four rejected rewrites with two rulings).
- **The preview covers the cast table.** The authoring library sends the plan's cast table (each
  `steps({...})` table once, before any call: protocol `cast`), the dry run collects it, and the
  static gate reports access for every agent step from it (producer and review judge), then for
  each first-wave call, then the leader and done reviews; each row says where it comes from
  (`TurnAccess.from`: `cast-table`, `first-wave`, `contract`; `unstated` from an older server).
  The launch card lists every turn, advised limits first. Guard: `expedition-kernel-runner` (the
  GTM plan's unreached `collect` and `packet` checkouts are reported).
- **Codex sub-agents are charged.** They still cannot be blocked (no flag; reported advisory). The
  run's evidence shows where their spend is: not in the parent rollout (its `token_count` totals
  are its own), but in a sibling rollout of the sub-agent's own thread
  (`rollout-…-01a1c93f-1c46-….jsonl`: 13,258 input, 5 output) whose `session_meta.source.subagent.
  thread_spawn.parent_thread_id` is the parent's thread. The ingest crate already read that parent
  into the session row; the usage key now carries it (`UsageKey.session.parentSessionId`) and the
  call meter (`executor/usage.ts`) adds every session descending from the call's. Known limit: a
  sub-agent rollout ingest sees only after the call settled is not charged to it.
- **Not exercised yet:** the Codex commit fix (`TurnGit`) by a real Codex checkout turn, and the
  checkout judge with a real Claude or Codex reviewer. Both are for the next real run.
