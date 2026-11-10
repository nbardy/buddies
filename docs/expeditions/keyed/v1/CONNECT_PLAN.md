# Connecting the expedition kernel to the real system

Status: **plan, 2026-11-10. Nothing here is built.** Written from a read-only study of the code at
`6a38b5d`; every `file:line` is from that commit. The kernel (`server/src/expedition-kernel/`)
passes its tests against a scripted executor; this is the plan for real Buddy runs, the leader,
the owner, boot, routes and a timeline view. Design: [DESIGN.md](DESIGN.md).

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
  is `<expDir>/drafts/<n>/`, pre-filled with a copy of `plans/v<current>/` and a read-only
  `contract.md`. The prompt is a compact projection of the view: goal, spent/reserved/budget,
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
  `POST /preview {folder}` (dry-run diff and cost, writes nothing); `POST /launch
  {workspaceId, folder}` (base from `resolveBase`, `checks.ts:35-59`). Mutations go in
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

Replace `draft` (`tool.ts:67-89`) with `propose {folder}` (the Buddy writes the folder with its
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
3. Leader wakes and done reviews: bounded by `limits.leaderWake` and `limits.doneReview`
   (`kernel.ts:66-67`).
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

| # | Change | Test through a real boundary | Risk |
|---|---|---|---|
| 1 | Kernel: `wake(runId, …)`; `labelled` timer at `runner.ts:143`; a real `Clock`; types and `timelineOf` move to `shared/src/expedition-keyed.ts`; the `KeyedView` projection | e2e suite unchanged; a projection JSON round trip | low |
| 2 | Executor core: records, ref store, context registry, commands and checks (`runChecks` gets a timeout, extra env, a stdout buffer; tokenise, and refuse shell metacharacters in the static gate) | kernel + executor on a temp git repo with real `sh` commands and a scripted leader; kill mid-command → `errored` | low |
| 3 | Owner thread and asks: `owner-thread.ts` out of `host.ts`; `consumes(…, replyToId)`; the answer route | real core on temp stores: a reply settles the ask; a consumed reply wakes nobody | medium |
| 4 | Agent runs: post and key, status from the crate, watcher, cancel and close, minutes cap, `'call'` role, `TurnDirectory.call`, memory-review skip, JSON Schema validation, ingest usage, the seat Buddy | real backend with a fake `claude` on PATH (the `execution-adoption` harness): one crate run per run id across a SIGKILL; malformed → `errored`; close on a queued run → never claimed | high |
| 5 | Leader and Owner ports: draft folder, `dispositions.json`, approval post | a fake-CLI leader writes `plan.ts` → a `plan` v1 entry; a rejected rewrite → a `rejected` wake | medium |
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
| D11 | `grant.reads` / `web` | Advisory in the brief for v1 (nothing enforces them) |
