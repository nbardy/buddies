# Execution adoption: provider turns survive backend replacement

Date: 2026-09-30. Author: Buddies Development Lead (buddy_d3f11f11).
Status: PROPOSED by the lead and being implemented under an explicit owner requirement.
Decision-maker for the outcome: the owner, who asked in #case-studies
(post_01a0f2bc-03b8-772d-b42b-ea7b6c73daaf) that web-server restarts stop dropping workers and
turns. The owner did not choose this mechanism; the mechanism is the lead's recommendation below.
Handoff: Product Development Lead, post_01a0f2c4-f9c0-70b6-894f-a0c83f51ff7c, Task
buddy_project_33bb3d10-9da0-4db3-84fe-7f9143ff5592.
Inputs: `agent_notes/2026-09-30_worker-continuity-restart-triage.md` (PDL trace, baseline 7859e70),
`agent_notes/2026-09-30_backend-death-drops-workers.md` (UI Engineer incident timeline).

## What this reopens, and why

- `agent_notes/2026-08-21_turn-lifecycle-design.md` (at 7859e70) rejected a supervisor DAEMON in
  review round 2 and chose reload-deferral. It kept "detach-and-adopt" as an optional durability tail. It
  proved empirically that adoption needs FILE-BACKED stdio, because piped stdio dies with the parent. Round 2
  also found that adopting adds zero streaming paths while a daemon adds one.
- `agent_notes/2026-08-24_automation-execution-ownership-design.md` (at 7859e70) accepted a single
  backend owner with explicit interruption on replacement. It deferred (did not reject) option B, detached
  execution with durable events, as "the correct architecture if crash-transparent execution becomes a
  product requirement".

What changed: the owner has now made it a requirement. Reload-deferral also did not hold in practice:
- Two abrupt backend deaths on 2026-09-30 (12:34Z, 14:09Z) orphaned 14 and 10 runs.
- A queued reload starved for 20+ minutes (`2026-09-29_dev-backend-reload-starvation.md`).
- The replacement started a second Codex writer on a thread whose old writer was still alive.

What still holds from August:
- No daemon. Its objections still hold: a new local socket surface, contract skew, and the
  supervisor's group kills.
- One streaming path.
- One settlement path.
- Explicit stop still kills.

This design is the August "detach-and-adopt" tail, built completely.

## The one idea

Every provider execution writes to an on-disk journal directory. The backend always READS its
turn from that directory, including for a turn it spawned itself. So "live" and "adopted" are the
same code path. Adoption is simply "a backend started reading a journal it did not spawn", and it replays from
byte 0.

A replay into a fresh backend rebuilds exactly the in-memory overlay a never-restarted backend would
hold. This works because `Conversation.messages` is only an overlay, merged with the provider's native transcript by
`mergeSessionMessages` (`server/src/lifecycle/session-history.ts`). The adopted overlay starts with
the turn's original user message and send timestamp, so the merge pairs it with the native turn exactly as it does
live.

## Journal directory (internal, not a public concept)

`<agent-viewer dir>/executions/<attemptId>/`, mode 0700:

| file | writer | meaning |
|---|---|---|
| `execution.json` | agent-cli, before spawn | harness, mode, parser inputs, owned temp paths, start time |
| `owner.json` | server, before spawn | who owns it: conversation, attempt, user message, policy record (run lease, grant), deadline |
| `stdin` | agent-cli | the prompt, when the harness reads stdin |
| `pid` | the wrapper itself, first instruction | the process-group leader |
| `stdout`, `stderr` | the provider (file fds, not pipes) | raw output, append-only |
| `exit.json` | the wrapper, after the provider exits | exit status, written atomically (tmp + rename) |

The wrapper is `/bin/sh -c` with `trap : TERM INT`. The trap lets it record the exit of a signalled
child, and traps reset to default in the exec'd CLI, so the CLI still dies on TERM. The wrapper is
spawned detached (own session and group) with no pipes. It therefore survives SIGKILL of the backend and group kills
by `watch-server.mjs` / `dev-supervisor.mjs`.

States, all derivable from the directory:
- no `pid` file: never started.
- `pid` alive with the wrapper command line naming this directory: running.
- `exit.json` present: exited.
- `pid` dead with no `exit.json`: lost, meaning an external SIGKILL of the group. This is the
  distinguishable owner-death case.

Why a directory and not a table: this is process state, like the harness's `ownedPaths` temp
config. It has one writer per file, and it must be readable without the backend that wrote it. The authoritative
work records are unchanged: the Buddy `run` row, the conversation record and the attempt journal. The directory is deleted
once its turn settles.

Credential note: `owner.json` holds the turn's MCP bearer so a replacement can re-register the same
grant. That token is already readable by the agent's shell (grants.ts T07 comment), and muse
already writes it to a 0600 file. The directory is 0700 and deleted at settle.

## What moves, what is replaced

1. **agent-cli (submodule)** `executeCommand`:
   - Spawns through the journaled wrapper and follows the files instead of pipes. Replaces the
     `stdio: pipe` path for turns.
   - New `attachExecution(dir)` returns the same handle shape by following an existing journal from
     offset 0.
   - `ExecuteCommandHandle.child: ChildProcess` becomes `pid` plus `dir`. This is August §5a, "drop
     child from the seam".
   - Stop is a group kill by the recorded pgid, so it works from any backend.
   - `runCommand` (inherit-stdio CLI use) is untouched.
2. **TurnRunner** (`server/src/turns/runner.ts`): `start()` is split into spawn plus one `follow(handle)`.
   New `adopt(record, handle)` restores the attempt, start time and harness folds, then calls the same
   `follow`. `host.process: ChildProcess` becomes the handle. `escalateKill` waits on `completed`,
   not `'close'`.
3. **Conversation / policies**:
   - At spawn, the policy returns a serialisable adoption record.
   - `adopt(record)` restores it:
     - Chat: nothing.
     - Builder: the grant.
     - Buddy: the grant, the review ticket, and the run it executes under. For a foreground chat
       run that is the lease plus the absolute deadline, re-armed. For a runner-owned run it is
       the lease, with the drain promise handed back to the runner.
4. **Grants / MCP endpoint**:
   - `grants.adopt(record)` re-registers the same token and scope. No new authority, and the same
     expiry.
   - The endpoint binds a persisted loopback port (`buddy-mcp.json` next to the stores), so the URL in the
     CLI's config stays valid.
   - If the port is taken: an explicit error, then an OS port. Adopted turns then lose tools, and
     the server logs it loudly. It never silently looks fine.
5. **Boot** (`server.ts` startup):
   1. Scan journals before the attempt-journal sweep.
   2. `turnAttemptJournal.initialize(adopting)` skips attempts whose journal exists.
   3. After conversations load, each journal is adopted by its conversation.
   4. Journals with no owner, or an owner that cannot be adopted, have their group killed and
      their attempt terminalised. Owners that cannot be adopted are a deleted conversation or a
      memory-review execution. This keeps "no untracked execution".
   5. The Buddy runner's `start` calls `recoverRuns({keep})` so adopted runs stay `running`. It
      re-derives each runner-owned run's job from its input (`jobFor` is already pure over the
      run), awaits the adopted drain, then runs the same `after` and `settle`.
6. **Crate** `recover_runs(keep: &[String])`: an internal signature change, with no schema change.
7. **Shutdown** (`lifecycle/shutdown.ts`):
   - SIGINT, SIGTERM, IPC disconnect and reload no longer stop provider executions, and reload no
     longer waits on them.
   - Reload still waits for mutations, startup, chats waiting for a run slot, and non-head queued
     messages. Those live only in memory and are not survivable.
   - Explicit Stop is unchanged: group kill, grant revoked, run settled cancelled.

## Exactly-once

- Settlement is guarded by the crate lease: `settle_run` requires the live lease token and clears
  it, so a second settle is `lease_lost`.
- A request answer uses the idempotent key `run:<id>:answer`.
- The journal is deleted only after the drain settles.
- A crash between settle and delete re-adopts an exited journal. Its replay settles again, and
  that settle is rejected by the lease. The one visible duplicate would be the overlay rows until
  the native transcript replaces them.
- The duplicate writer is impossible because adoption happens BEFORE the Buddy runner wakes. A
  conversation with an adopted turn is busy (`execution` set, crate `ConversationBusy` on bind),
  so a returned run cannot start a second writer on the same thread.

## Acceptance (the Task's criteria)

A real-boundary test on temp stores:
- Spawn the actual backend process with a fake provider CLI on PATH. The fake emits ordered
  stream-json and calls a Buddy tool over MCP before and after the gap.
- SIGKILL the backend mid-turn and start a new backend on the same stores.
- Assert:
  - the same pid continues;
  - output before, during and after the replacement is ordered;
  - the post-replacement MCP write succeeds under the same scope;
  - no second spawn;
  - exactly one completion and one return;
  - Stop on an adopted turn kills the process and revokes the token (401);
  - an externally SIGKILLed execution settles as lost, not success.
- Cover a conversation turn and a Buddy worker run.

## Not in scope

- Surviving a reboot.
- Queued-but-unsent messages and waiting chat tickets. These are in-memory as today; boot still
  cancels waiting chat runs.
- Channel reply queues (todo_cc739f9c).
- The incident's cause of death (UI Engineer, supervisor exit journaling).
- Pushing. No live restart of the owner's backend for testing.

## Revisit if

- The wrapper cannot reach a harness that needs interactive stdin. No harness uses `stdin: 'pipe'`
  today.
- Adoption must survive a reboot.
- A second consumer needs the same stream concurrently. That would be the daemon's one real
  advantage.

---

## Successor, 2026-09-30: implemented on branch `continuity/execution-adoption` (not merged, not deployed)

Worktree: `/Users/nicholasbardy/git/unleashd-adopt`, based on 7859e70.
Submodule commit `43744e8` is on local branch `execution-journal` in `vendor/agent-cli-tool` and is **not pushed**.

The design held. The implementation differed from it in three ways:

- **Run deadlines.** A runner-owned run's deadline moved out of `server.ts` `runTurn` (a
  `setTimeout`) into `BuddyTurnPolicy.armExecution`. That function is the one place that arms
  the deadline for all three drain listeners: a chat run, a live runner run, and an adopted
  run. It also removed `Conversation.expireCoordinationRun`.
- **Finishing an adopted runner-owned run.** The run's `runJob` promise died with the old
  backend. `runner.finishAdoptedRun` re-derives the completion step from `jobFor(run)` and
  settles under the persisted lease. It shares `finishTurn` with the live path.
- **Shutdown waits.** `ShutdownConversation` shrank to `holdsUnadoptableWork()`: a pending
  queued send, or a chat waiting for a slot. Exits also wait for `buddyRunner.settling()`,
  which counts completion steps and settles in flight.

### Evidence (commands run in the worktree)

- **Vendor:** `pnpm test:cli` passed 289/289. `test/journal.test.ts` covers three cases:
  - The spawner is SIGKILLed, and the adopter follows the same pid with ordered output.
  - Stop gives `killed`, not lost.
  - An external group SIGKILL gives `lost`.
- **Crate:** `pnpm --dir crates/unleashd-buddies test` passed its Rust tests (4 + 34 + 1 + 0),
  including the new `startup_recovery_keeps_runs_the_new_host_adopted`. The napi test `a request, its
  run and its answer cross the napi boundary` fails, identically on untouched main (pre-existing).
- **`pnpm typecheck`:** exit 0.
- **Biome:** clean on all changed files.
- **`pnpm test:server`:** 231 pass, 1 skip, 1 fail. The failure, `a DM new chat opens the next
  generation`, also fails on untouched main (pre-existing).
- **`pnpm test:client`:** 218/218.
- **`pnpm test:dev-supervisor`:** 15/15.
- **`server/test/execution-adoption.test.ts`:** passed 5/5 in a row, plus two full-suite runs.
  It uses the real backend process on a temp HOME, with a fake `claude` CLI on a PATH that has
  no real agent CLI. Backend A starts a chat turn and three Buddy worker runs, and is SIGKILLed
  mid-turn. The test then kills one provider group externally and starts backend B on the same
  stores. Verified:
  - Each scenario spawned exactly one provider, and the adopted pid is that one.
  - The chat's assistant text is `one;two;during;four;`, once and in order, even though
    `during;` was written while no backend existed.
  - The attempt from backend A's boot ends `succeeded`/`provider_complete`, with no
    restart or interrupt system line.
  - The worker's `post` succeeded both before (A) and after (B) the restart under the same
    token, written as the worker.
  - The worker run is `complete`, and exactly one answer returned to the owner's request.
  - Cancel on the adopted hanging run ended it `cancelled`, killed its process, and its token
    got 401.
  - The externally killed run ended `failed` with "lost".
  - Every turn journal was removed after settling.
- **Mutation checks** (each restored afterwards):
  - `recoverRuns([])`, i.e. no keep: the worker run was interrupted and the test failed.
  - Skipping `adoptGrant`: the post-restart tool call failed and the test failed.

### Not done

- **Merge and deploy.** Deploying means fast-forwarding local `main` (the dev watcher then
  reloads the owner's live backend), pushing the submodule branch, and making the main
  checkout's submodule dist and buddies addon current. It changes the live system, so it needs
  the owner's go-ahead.
  - The first reload onto this code is still governed by the OLD shutdown: it waits for idle.
  - Turns the old code started have no journal, so they are not adopted.
- **Reboots and in-memory work.** Surviving a reboot is out of scope. Messages queued behind a
  running turn and chats waiting for a slot are still memory-only; exits now wait for them.
- **Timing windows.**
  - A crash in the milliseconds between a turn's journal removal and its run's settle leaves
    the run to be recovered as interrupted.
  - A crash in the milliseconds between settle and journal removal is safe: re-adoption, then
    a lease-rejected settle.
- **Channel reply queues** (todo_cc739f9c) are untouched.
- **Incident cause of death** is the UI Engineer's lane.
