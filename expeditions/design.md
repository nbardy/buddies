# Expedition design

Status: design, not built (2026-11-01). Motivation: [README.md](./README.md).

## Primitives

```
Goal       what + done checks + scope fence + explore budget + limits     (owner owns it)
Question   an open unknown or subgoal under the Goal                      (the work frontier)
Attempt    one isolated, budgeted, short-lived agent run on a Question
Result   = Claim(statement, evidence, check)
         | Finding(negative result, evidence)
         | Blocked(need)
         | Waiting(externalJobId)
Check      fresh-context verification of a Claim → Verified | Refuted | Unclear
Ledger     append-only log of everything; all state is derived from it
Tick       stateless f(Goal, Ledger) → next actions; runs on every event + a backstop timer
```

Two more are required and not yet designed in detail (see [Open gaps](#open-gaps)):

```
ExternalJob  a long-running job (GPU run, CI) an Attempt submitted; finishing is an event
Integrate    a merge Attempt for a Verified Claim that carries code, against current main
```

### Goal

```
Goal
  what:          outcome in plain language
  done:          DoneCheck[]            command(s) that pass or fail
                 | OwnerJudgment         explicit: no mechanical check exists
  in scope:      ...
  out of scope:  ...
  explore share: fraction of budget for work outside the in-scope list (e.g. 0.2)
  limits:        budget $, max live attempts, allowed models/harnesses, repo rules
  stop:          Done | BudgetSpent | Deadline | OwnerStop
```

The Goal carries **no strategy**. Children choose their own approach; the
expedition watches the approaches and allocates effort (see
[Strategy cards](#strategy-cards)).

A Goal without a done check is rejected at launch unless it explicitly says
`OwnerJudgment`. No silent "we'll know it when we see it".

### Attempt

Every Attempt:
- runs in its own worktree on its own branch;
- gets a brief built from the Goal, its Question, verified Claims, relevant
  Findings and owner Lessons from the Ledger;
- has a budget (time and $);
- **must end with exactly one Result**. There is no "partial, will continue".

Persistence belongs to the Goal and the Ledger, never to an agent. Every
Attempt ending is an event that triggers a Tick, so a stopped agent cannot
strand the work.

### Attempt kinds

One runner, one Result shape, different briefs:

| Kind | Input | Result |
|---|---|---|
| **Plan** | Goal + Ledger | new Questions (decomposes a half-scoped goal), parking-lot entries |
| **Work** | a Question | Claim / Finding / Blocked / Waiting |
| **Check** | a Claim, *without* the author's conclusion | Verified / Refuted / Unclear |
| **Reflect** | Ledger metrics + strategy cards | allocation changes, brief changes, new Questions |
| **Zoom-out** | Goal + Ledger + north star | proposals: parking-lot Questions or a Goal amendment for the owner |
| **Answer** | an owner `@` question + Ledger | an answer citing runs and results (read-only) |
| **Integrate** | a Verified Claim with code | merged commit, or Blocked(conflict) |

A fixed-shape step inside an Attempt (a 3-verifier Check panel, the failure
re-run trio) can be carried out by a Claude Code workflow. See
[workflows-vs-expeditions.md](./workflows-vs-expeditions.md).

### Strategy cards

Each Work attempt declares its approach in every report:

```
StrategyCard
  approach:   "cut-cell wall in pressure solve"
  hypothesis: "voxel wall underestimates lift via a missing pressure term"
  predicts:   "lift error falls from 15.7% toward <10% as N doubles"
  evidence:   numbers so far
  abandon if: what would make me stop
```

The expedition does not pick the method; it reads the cards across children.

## Scope: enforced by spend

- Questions are **in scope** (under the fence) or **explore**.
- Explore attempts draw on the explore share of the budget only.
- Ideas beyond that land in the **parking lot** as unfunded Questions, shown in
  the digest. Only the owner funds them, or the explore share once it frees up.

It cannot sprawl, because unbudgeted ideas wait. It cannot tunnel, because the
explore share is reserved and Zoom-out keeps filling it.

## Parallelism

The Tick runs every open, funded Question that has no live Attempt, up to the
live-attempt cap. Competing attempts on one Question both continue until a
Check settles it. Parallelism therefore scales with how many Questions the
Plan produces, which is the right thing for it to depend on.

## The loops

| Loop | Who | When | Changes |
|---|---|---|---|
| **Tick** | Code (one model call only when there is a decision) | Every event + backstop timer | Starts/ends attempts. Nothing changed and work is live → sleep, no LLM call |
| **Reflect** | The expedition, fresh context | Metric thresholds, stalls, every few hours | Its own allocation, briefs, routing |
| **Steer** | Owner, via `@` or inspector | Any time | This expedition: redirects and Lessons |
| **Retro** | Owner + expedition | On finish or stop | The tool: playbook rules, brief templates, tool issues |

### Checkpoints that reach the owner

It runs without approvals. The "needs you" count only covers:

| Checkpoint | Why |
|---|---|
| After the first Plan | Steering the breakdown has the most leverage (optional review, not a gate) |
| Goal-level surprise: shared failure, goal looks wrong | Only the owner changes the WHAT |
| Before Integrate into main | The owner decides what lands (configurable) |
| Daily digest | 30-second skim: claims, spend, parking lot, Blocked |

## Self-reflection without a human

The rule: **judge children by measurements, experiments and independent
auditors, never by their opinion of themselves.**

### 1. Measure (code, no LLM)

| Signal | Exposes |
|---|---|
| Check refutation rate per child / brief / model | Over-claiming |
| Prediction vs. outcome on strategy cards | A wrong model of the problem |
| Cost per verified claim | What actually buys progress |
| Attempts per Question with no claim | A stuck Question |
| Files touched outside the Question's scope | Scope drift |
| Time since last Ledger entry | Stalls |
| Near-duplicate briefs or diffs | Duplicated work |
| Strategy cards clustering on one approach | Missing diversity |
| Different approaches failing by the same amount | An upstream problem (measurement, setup, goal) |

Thresholds on these trigger Reflect.

### 2. Diagnose failures by controlled re-run

| Re-run | If it now succeeds | Conclusion |
|---|---|---|
| Same brief, different model | yes | The child slipped |
| Brief enriched with failure context and relevant Ledger results | yes | **Our instructions were the problem** → fix the brief template |
| A different approach to the same Question | also fails the same way | **The strategy or Question is wrong** → split, reframe or park |

### 3. Audit transcripts, sampled

A fresh-context auditor on a different model than the worker reads a sample of
transcripts for: ignored instructions, invented commands or flags, unread
context, loops, changing the test instead of the code.

### 4. Adjust within limits

May change: brief templates (kept as variables, variant kept if it yields more
verified claims per $), model routing per Question type, allocation (split,
park, kill duplicates, fund the leader), and a red-team pre-mortem before any
spend above a threshold.

### 5. The guardrail that matters most

**Reflection may never change the Goal, the done checks, the Check procedure or
the budget.** A self-optimizing system eventually finds that the easiest way to
pass is to soften the test. Those are owner-only. Its own briefs, routing and
allocation are fair game.

## Owner feedback

```
Feedback =
  | Approve(plan | result)
  | Redirect(question, instruction)
  | Fund(parkedQuestion) | Kill(question)
  | Lesson(text, scope: ThisExpedition | Playbook)
  | Pause | Resume | Stop
  | AmendGoal(change)          owner-only
  | RaiseBudget(amount)        owner-only
```

`Lesson` entries enter every later brief. `Playbook`-scoped lessons enter every
future expedition's briefs.

## Inspector (behind the badge)

All tabs are views over the Ledger.

| Tab | Shows |
|---|---|
| Overview | Goal, scope, spend and time vs. budget, latest reflection |
| Questions | Status per Question and its attempts |
| Runs | Every Attempt: kind, model, duration, cost, Result, transcript, branch |
| Results | Verified / refuted claims and findings with evidence |
| Timeline | The Ledger as a feed: decisions and why |
| Parking lot | Noticed, unfunded ideas |
| Self-reflection | Brief changes, routing shifts, audit findings, re-run verdicts |

## Open gaps

1. **Integrate.** Attempts produce branches. Merge order, conflicts, and
   re-verification on current main are not designed. This was the bottleneck
   in every earlier swarm.
2. **External jobs.** Long GPU or CI runs: an Attempt submits and ends with
   `Waiting(jobId)`; job completion is an event. Needs a job adapter per backend
   (Modal, CI).
3. **Plan quality.** Decomposition of vague goals decides everything and is
   only "a brief" today.
4. **Ledger summarization for the Tick.** With hundreds of entries the compact
   view is itself state; it must be derived deterministically, not written by a
   model.
5. **Check cost.** Verifying everything roughly doubles spend on what matters.
   Policy for which Claims require a Check (those that gate decisions or merge)
   is not settled.

## Proof plan

Before building the engine:

1. Pick one real, half-scoped engineering goal.
2. Run it two ways: (A) the current setup; (B) a by-hand expedition: a Claude
   Code session acts as the Tick (`/loop` / `ScheduleWakeup`), the Ledger is a
   JSONL file, workflows run fan-outs and Checks.
3. Compare: owner interventions, verified results per $, whether it finished
   without stalling, whether scope held (parking lot vs. what was built).
4. Build the engine only if B clearly wins, with Integrate and External jobs
   included from the start.

## Revision 2 — after the geometry swarm retrospective (2026-11-01)

Source: the October 31 retrospective of Oompa swarm `cf9ea773` (G1/G2). Its parallel
implementation and independent review worked; its path from reviewed candidate to accepted,
merged work failed (a dirty *shared* checkout blocked validation of isolated candidates,
refusals left no journal, no supported resume, stages were misreported, cost was unmeasured).
Expeditions as first built had no integration step at all and relied on prompts for isolation,
so they would have failed the same way. These changes make that path mechanical and host-owned.
Positioning: an expedition owns the fuzzy front (decompose, write contracts/validators); a fully
specified packet can be executed mechanically and judged by an executable check.

### R1. Isolation is structural, not a prompt
- Before a work attempt is briefed, the host creates its worktree:
  `git cambium add -b exp/<id>/<attemptId> -name exp-<id>-<attemptId> -ephemeral <worktree path>`
  from the expedition's integration branch head, in the workspace's repository. Intent is in the
  ledger (`worktree_ready {attemptId, path, branch, baseSha}`) before the brief is posted; the brief
  names the path and says to work and commit only there. The shared checkout is never edited.
- Questions declare file custody (`paths: string[]`, repo-relative prefixes). The host never runs
  two work attempts with overlapping custody at once; overlapping ones wait (queued, not refused).
- All git/process calls are async (`execFile`/`spawn`), never sync on the server loop.

Built (2026-11-01, `server/src/expeditions/git.ts`, `effects.ts`): launch preflight records
`repo {root, baseSha, branch}` in the `launched` entry (R3 replaced `branch_ready`: the branch is
created by the integration tree's `cambium add`).
Every worker attempt (work and check) runs in a host-made tree: a work attempt's starts at the
expedition branch head, a check's at the candidate commit its claim names (a check never makes
its own worktree in the owner's repository). An attempt is admitted (phase `admitted`) by writing
`worktree_creating {name, path, branch, baseSha}` BEFORE `git cambium add`, so it holds its slot
and custody at once. Replay is idempotent in both crash windows: a registered workspace is
adopted by name only if it is `ready` at the intended branch and base; an add interrupted partway
(SIGKILL or timeout: the branch and directory exist but `cambium list` has no entry — reproduced
on a 20k-file repository) is rolled back with `cambium recover` and added again. Anything Cambium
cannot make or roll back (a commit that does not exist, a mismatched registry entry) is a typed
`worktree_failed {reason}`: the attempt is `dropped`, the next manager is shown it, and a panel
counts a dropped check as settled without a vote — never a tick that throws on every retry. Then
`worktree_ready`, then the brief.
Release waits until no worker can be in the tree: its attempt settled (ended or dropped), or the
expedition finished before the attempt was briefed. A live worker's tree is never removed, even at
finish; the host keeps observing a finished expedition while attempts are live and releases each
tree when its attempt ends (nothing cancels running Buddy requests yet). An ended attempt's tree is
removed with its branch when it has no commits beyond its base, kept (`worktree_released {kept}`)
when it has; at finish every idle tree is removed and only empty branches are deleted, with an
atomic `git update-ref -d <branch> <base>` (not `cambium remove --delete-branch`, whose
`git branch -d` refuses a branch at an unmerged candidate commit). A release with no Cambium
workspace and nothing on disk is `absent`; a partial create's leftovers that recovery cannot
remove are `left {reason}`. Removal never forces: uncommitted changes become
`worktree_released {left, reason}`. Cambium runs as `git-cambium` directly (a timeout kills the
process doing the add, not a `git` wrapper), with a 15-minute limit for `add`. Custody paths are
normalized once (`./a/` → `a`, whole repo = `.`). Cambium keeps its registry in `.git/cambium`, so
tests use the real tool on a temporary repository. Gap, CLOSED by R9 (a host-provided turn
directory, no crate change): Buddy runs started in the workspace root, which IS the owner's shared checkout
(`briefing.ts` `workingDirectory: workspace.rootPath`); the brief tells the worker to `cd` into
its worktree under `APP_DATA_DIR/expeditions/<id>/worktrees`, outside that root. So "never edit
the shared checkout" is still a prompt for the agent's edits, and a provider sandbox limited to
its start directory (Codex `workspace-write`) can write the shared checkout but not the worktree,
which pushes a sandboxed worker toward the wrong tree. The structural fix is a run-level working
directory: an optional `cwd` on the crate's `RunConfig` (persisted on the run row), threaded by
the Buddy runner into the run conversation's turn directory, and set by `postAttempt` to the
attempt's worktree. It is not in this branch because it changes the Buddies crate and runner,
which are at their line ceiling (tools/buddies-line-ceiling) and outside `server/src/expeditions`.
What IS structural now: claims are checked against their own branch and custody (git.ts
`claimHeld`), and only host-validated commits merge, so a stray edit in the shared checkout can
never reach the expedition branch. Also repository-wide: `cambium recover` (used only when an
attempt's own add left a branch or directory behind) rolls back every dead incomplete Cambium
create in the owner's repository, other agents' included; Cambium has no per-workspace recover.

### R2. Checks are typed: executable or judged
```
DoneCheck = { kind: 'command', argv: string[], timeoutSeconds: number }   // host-run
          | { kind: 'judged', text: string }                               // blind LLM panel
Done      = { checks: DoneCheck[] } | { ownerJudgment: true }
```
- A code claim must name its candidate commit (`commit: sha`). The host validates that immutable
  commit in a fresh clean worktree (never the worker's tree, never the shared checkout): it runs
  every `command` check with a timeout and records `validation {targetSha, check, outcome}` where
  outcome = `passed | failed {exitCode, tail} | timed_out | error {message}`.
- Done requires: every `command` check passed on the integration head AND the latest goal panel
  verified the `judged` items by strict majority (when there are any).
- Reflection never edits checks; the host is the only runner of command checks.

Built (2026-11-01, `charter.ts` `DoneCheck`/`ClaimChange`, `ledger.ts` validations, `command.ts`,
host `run_validation`; candidate validation SUPERSEDED by R11: a candidate runs its question's
acceptance, never the done commands): a claim's `change` is a sum, `{t:'commit', sha}` or `{t:'no_code'}` (a
check of a no-code claim starts at the branch head). Decide plans `validation_planned {target}` for
every ended code claim (target `candidate`, its sha) when the charter has command checks, and for
the head when the manager asks done (with `done_requested`). The host resolves the sha and records
`validation_started` (the tree's name, path, branch and base = the sha) BEFORE `cambium add`; a tree
that cannot be made records `validation_tree_failed` and an `error` outcome per check, never a
throwing tick. Checks run one validation at a time per expedition, outside the tick chain (a check
may run for hours; a steer must not wait on it), each appended through the chain as
`validation {validationId, targetSha, checkIndex, outcome}`; a restart resumes at the first
unrecorded check (a check interrupted by the crash runs again). `runCommand` spawns argv (no shell)
as its own process group, kills the group at the timeout, kills stragglers once the command
exits (a background child holding the pipes never stalls the result), and keeps a 4000-character
output tail (`timed_out` keeps its tail too). Each check re-reads the ledger: a paused or finished
expedition stops between checks. The tree is discarded with `cambium remove -force` once every
check is recorded (or at finish, never under a running check), its branch dropped only while empty.
Done: refused while a done is validating, refused unless the latest goal panel verified (only when
judged items exist), finished at once when there are no command checks, otherwise finished when
every command check passed on the head, else `done_refused {reason}` shown to the next manager.
Host validations count as live work for "never idle" and `attempts_spent`. (R3 closes the moving-head
gap: no merge is accepted while a done validates, and a head validation waits for planned merges.)

R2 review fixes (2026-11-01): the host checks a claim against its own attempt branch when it ends
(`git.ts` `claimHeld`): a `commit` must be new on that branch (an ancestor of its tip, not of its
base), and `no_code` requires a branch with no commits. A claim the branch does not hold is
recorded `malformed` with the reason, so it is never validated or checked on its word (it could
otherwise name the head, or hide a commit from validation). A check gets a curated environment
(PATH, HOME, USER, LOGNAME, SHELL, LANG, LC_ALL, TMPDIR, TZ), never the server's provider keys.
Known limits: pause and finish stop a validation only between checks (a running check runs to its
end or timeout, and its tree is released after); a check outlives a server crash in its own process
group and the replay re-runs it beside that orphan (no pid is recorded); a tree whose
`cambium add` failed has no release (recover already ran; leftovers are named in the reason).
Tested end to end: timed_out and error head checks refuse done, finish never removes a tree under
a running check, and a crash before the tree or between checks resumes at the first unrecorded one.

### R3. Integration onto the expedition's own branch, serialized
- Each expedition owns `expedition/<id>` (created at launch from the base commit) and one clean
  integration worktree. A manager action `{do:'integrate', claimAttempt}` is accepted only for a
  claim with a commit whose candidate validation passed (and whose panel verified, if one ran).
- The host merges one candidate at a time (`git merge --no-ff <sha>`). A conflict aborts the merge
  and records `integration_refused {phase:'merge', paths}`; success records
  `integrated {sha, mergeSha}`. Every refusal records its phase and identities — never a pointer
  to a log that does not exist.
- The owner's main is never written. At done, the owner is told the branch to merge.

Built (2026-11-01, `git.ts` `mergeCandidate`, decide `integrate`, effects `integrate`): `launched`
names the integration tree (`exp-<id>-integration`, `<expeditions root>/<id>/integration`), so the
launch entry is its intent; `create_integration_tree` runs `cambium add -b expedition/<id>` at the
base (not `-ephemeral`: it holds the branch for the whole run), adopting the workspace by name on
replay, and records `integration_tree_ready` (or `integration_tree_failed`, which finishes the
expedition `setup_failed` with the reason; decide waits for the tree, managers included). The
crew is created first so the badge and launch status never wait on a large-repository add.
`{do:'integrate', claimAttempt}` is refused (typed `rejected`) unless the claim names a commit,
its candidate validation passed (when there are command checks), and its latest check panel
verified it (when one ran; required when there are no command checks, so nothing merges on a
worker's word); also while a done is validating (the head stays fixed) and for a claim already
integrated or queued. Accepted, it writes `integration_planned {integrationId, claimAttemptId,
sha}`; the host merges planned integrations one at a time, before any validation effect, so a done
asked in the same decision validates the merged head (a done without command checks is refused
while a merge is pending). `mergeCandidate` first aborts a merge a crash interrupted
(`MERGE_HEAD`), then looks for its own earlier merge commit on the branch's first-parent history
since the base (second parent = the sha) and records that instead of merging twice; it refuses
`{phase:'tree'}` when the tree is not clean on its branch, `{phase:'git'}` for a sha already
contained or any non-conflict git failure (aborted), and `{phase:'merge', paths}` (the
`--diff-filter=U` files) on a conflict, after `git merge --abort`, so the tree stays clean at the
head. Results (`integrated {sha, mergeSha}` / `integration_refused`) go to the next manager and
the chat. New work starts at the merged head. At finish the tree is removed (`cambium remove`,
never forced, the branch kept), and the done post says which branch and head to merge. Known
limits: merges need a git identity in the workspace repository (a missing one is a `git`
refusal); a manager briefed between two merges sees the later ones as queued (the next manager
sees their results).

### R4. Preflight at launch (κ at the boundary)
Launch is refused with typed reasons unless: the workspace root is a git repository, the base
commit resolves, `git cambium` is available, and every `command` check's `argv[0]` resolves on
PATH. Preflight does not run the checks (they may be paid GPU runs).

Built (2026-11-01, `git.ts` `preflight`, `command.ts` `resolvesOnPath`, host `launch`): the refusal
(`LaunchRefused`, nothing written) lists every failing condition at once. `argv[0]` resolves the
way `spawn` will look for it under the check's curated environment: a bare name on the server's
PATH, a path with a slash against the repository root (a validation tree is a checkout of it) or
absolute; it must be an executable regular file. A script the expedition itself will create
cannot be named as `argv[0]`; run it through its interpreter (`["sh", "scripts/x.sh"]`). Known
limit: an executable present at launch can vanish later; that check is then a typed `error`.

### R5. Dependencies and honest stages
- `add_question` takes `after: string[]` (question ids). Work on a question whose dependencies
  are not verified waits (stage `waiting`), it is not refused or silently run.
- Every question shows one derived stage:
  `planned | waiting | implementing | claimed | checked | validated | integrated | dead`.
  Reports count stages separately; held/waiting is never reported as failed.

Built (2026-11-01, `queries.ts` `waitsOn`/`questionStage`, decide `add_question`, effects
admission): `after` defaults to `[]`; an id that names no existing question is a typed `rejected`
(the host assigns ids, so a dependency is always an earlier question and cycles cannot form). A
dependency is met when its question is closed `verified` (which already requires a verified
panel). Unmet, the work attempt stays `planned` and admission skips it without taking a slot or
custody; the chat says `⏸ <attempt> waiting: needs <q> verified first`, and it starts at the
then-current expedition head (so it builds on an integrated dependency). Waiting work does not
count as running for "never idle": an expedition holding only waiting work (say its dependency
closed `dead`) asks the owner, naming what waits on what. The stage is the furthest that holds,
in the table's order: dead, integrated (a claim on it merged), validated (a claim's candidate
validation passed), checked (a panel verified it), claimed, implementing (a work attempt admitted
or running), waiting, else planned. It is in `ExpeditionView.questions[].stage`, the Tasks pane,
the manager brief and `status` (with a per-stage count). The page header carries one
`Integration:` line (branch, head, integrated and queued counts, last refusal); the Workers pane
shows each worker's branch and its claim's validations (each check passed, or failed with its
exit code). Chat news marks validations ✓/✗, merges ⤵ and refusals ⛔.

### R6. Measured cost
Each ended attempt records its measured usage when the run exposes it
(`cost: {t:'measured', inputTokens, outputTokens, usd?} | {t:'unmeasured', reason}`); totals show on
the page. Nothing is estimated or fabricated.

Built (2026-11-01, `meter.ts`, effect `meter_attempt`, entry `attempt_metered`): the crate's `Run`
carries no usage, but each request run executes in a conversation of its own
(`buddy-run-<runId>`; a retry continues there), and the ingest store keeps provider-counted
totals per session (`SessionRow.usage`). So once an attempt has ended AND every run that executed
its request has settled (and 15 s have passed for the transcript watcher, `INDEX_GRACE_MS`: read
earlier, the last turn would be missing and the count wrong rather than absent), the host sums
the sessions those conversations bound: `measured {inputTokens, outputTokens, cacheReadTokens,
cacheWriteTokens}`. Until then the effect writes nothing and is retried (a finished expedition
stays active until every ended attempt is metered). `unmeasured {reason}`: no run executed the
request, a provider that records no usage (Claude, Codex and OpenCode do), a session not in the
store, a conversation without a record. No `usd`: the crate keeps tokens, and pricing them would
be the usage panel's estimate. Totals (`news.ts costTotals`) show on the page header, the badge and
`status`, with the not-measured count and reasons. Known limit: a run that starts after metering
(its request was already answered) is not counted. R11: the wait is bounded (`SETTLE_WINDOW_MS`,
one hour after the attempt ended, then `unmeasured`), and a repaired attempt meters both requests.

### R7. Kickoff
A Buddy suggests an expedition when the four tests hold and launches only when asked. The owner
says, in any thread, DM or channel: *"Launch an expedition: <goal>. Done when <checks>. Budget
<N> attempts."* The Buddy drafts the charter (asking only for missing done checks), launches, and
the badge appears in that chat.

Built (2026-11-01, `charter.ts` `CharterRequest`/`charterOf`/`charterIssues`/`charterAdvice`,
`tool.ts`): the launch input requires only name, goal, done and maxAttempts; scope, maxLive,
hours, exploreShare and crew take NAMED defaults (`CHARTER_DEFAULTS`, `DEFAULT_CREW`) and the
result's `defaulted` lists each applied, beside `launched` (a one-line summary) and the page path
(R9: data, not a link to post). A `draft` action returns `{ready, issues, advice, defaulted,
resolved, charter}` without writing: the R4
preflight, each crew seat against the provider catalog, and a work seat with no check seat on
another model (it could never be checked, so launch refuses it too). The briefing line names the
owner's phrasing; the tool description stayed within the worker budget. The owner's phrasing and
variants are in README.md "How to start one".

### R8. Whole-branch review fixes (2026-11-01)
A review of the whole branch found these; each has an integration test (mutation-checked: the
guard broken, a test fails) in `server/test/expeditions.test.ts`.
- **Budget**: `attempts_spent` finishes only when nothing can still run (every attempt settled or
  waiting on unverified dependencies, no host validation or merge in flight). It used to fire in
  the same decision that planned the last attempt, which then never ran.
- **Never idle after planning**: `question_added` is shown to the next manager (the host assigns
  question ids, so a turn that only decomposes is followed by one that starts work on them). It
  used to ask the owner after the first planning turn.
- **Done carries the verified work**: with judged items, done needs the latest goal panel's claim
  merged into `expedition/<id>` (a `no_code` claim needs no merge). A done with command checks may
  be asked while that merge is queued (the head validation runs after it) and settles only once
  it landed; without command checks it needs the merge landed.
- **Verification is the latest word**: a question is verified while its newest settled panel
  verified it; a later refuting panel withdraws it (close and R5 dependencies follow).
- **Custody is enforced**: a claimed commit that changes files outside its question's paths is
  recorded `malformed` (never validated, checked or merged).
- **Owner chat steers**: owner messages in the expedition chat become `feedback {via: chat,
  postId, ord}` (the ledger's chat cursor keeps them once); `pause`/`resume`/`stop`, `lesson: …`,
  else a note.
- **Recovery**: one ledger line per append batch; a torn last line is cut off whole at boot (a
  batch lands whole or not at all, so a decide batch never lands without its `manager_applied`);
  a ledger that does not read or fold is quarantined (route 409) and every other expedition keeps
  ticking. Steers and launches go through the serial chains (a launch's `launched` and its status
  are one batch), so live and replayed state agree.
- **Tool boundaries**: a crew Buddy cannot launch or steer; another workspace cannot see or steer;
  a disabled execution gate refuses launch and steer (with its reason, also in `draft`); a relaunch
  of an open name returns `alreadyRunning`, of a finished one launches anew. Seat checks moved into
  the host's one refusal list, so `draft` and `launch` agree.
- **Checks never stall**: after a check exits or times out, a straggler that left the process
  group may hold the pipes for at most `PIPE_GRACE_MS` before they are closed. A relative
  `argv[0]` must be an executable committed at HEAD (an untracked script in a dirty checkout is
  refused at launch).
- **No branch pile-up**: at finish an attempt branch whose tip the expedition branch holds is
  deleted (compare-and-delete); unmerged attempt branches stay for the owner; validation branches
  are scratch and go with their tree.
- **Page**: the chat area says the crew is starting until it exists; attempt phases carry their
  outcome in the wire type (no optional-field defaulting).

### R9. Live smoke findings and fixes (2026-11-01)
One live smoke at d954222: a real Buddy launched an expedition on a toy repository with temp
stores. Each fix carries a comment naming the incident at its site and a test that fails when the
guard is broken (mutation-checked). Tests: `server/test/expeditions.test.ts`, crate
`tests/core.rs`.
- **P1 (severe) — a hosted attempt's answer woke the crew.** The crew answering its own
  host-posted request went through `posts.rs answer` → `deliveries::deliver_to_spawner`, which
  enqueued a delivery even with no conversation subscribed to the request thread (the host posts
  attempts with none). That woke an extra crew turn in the workspace root (the owner's checkout)
  that read the answer (a manager brief) as instructions and committed on the owner's main; the
  run failure notice (`runs.rs`) took the same path. Fix at the root: `deliver_to_spawner`
  delivers only to a subscribed spawning conversation; with none, nobody spawned the request and
  nobody is told. The same holds for a spawner that unfollowed its worker's thread (the crate
  records no origin to tell the two apart; unfollowing is the choice to stop hearing it). Guards:
  `a_hosted_self_request_answer_wakes_no_spawner` and
  `a_self_worker_failure_notice_wakes_its_spawning_conversation` (crate) and the turn-directory
  test (no `deliver` run, exactly one crew run per attempt).
- **P2 — doubled unmetered runs**: the extra turns of P1; gone with it (asserted by run count).
- **P5/R1 (major) — runs started in the owner's checkout.** Isolation was only the brief saying
  "cd there", and a Codex `workspace-write` sandbox rooted at the owner's checkout could not write
  the attempt worktree at all. Now structural, with no crate schema change: the Buddy briefing
  (`briefing.ts`) takes a turn-directory resolver, `TurnDirectory = {t:'workspace'} |
  {t:'crew', path} | {t:'attempt', runId, path}`, which the server wires to
  `ExpeditionHost.turnDirectory(context)`. The host matches a crew run's request to a live
  (posting/posted) attempt by the exact brief bytes (recorded before the post, so a run claimed
  before `attempt_posted` still matches): a work or check attempt starts in its worktree, a manager
  in the integration tree (read only, its brief says so; the repository root before that tree
  exists; SUPERSEDED by R11: its own detached tree). Every other crew turn (a mention, the owner's chat with the crew, a worker the crew
  spawned, a boot or creation warm with no run) starts in the crew's own fixed directory,
  `<expeditions root>/<id>/crew`, which is no git checkout: not the owner's checkout (the manager
  directory before setup and after finish) and not the integration tree the host merges into, and
  it never moves, so a resumed seat finds its session. Every other Buddy turn starts in its
  workspace root. An attempt briefing is cached by run id, never under the Buddy's key (two
  concurrent attempts of one crew would otherwise get whichever worktree warmed last), and the
  runner forgets it at settle; a crew's Buddy-key entry always holds the crew directory, which is
  what a chat turn reads before its run is armed. The crew lookup reads `crew_ready` entries, not
  a fold of every ledger per turn. Known leak: an attempt run whose lease expires is ended by the
  claim gate, not the runner, so its small entry stays until restart. Guards: two concurrent work
  runs of one crew each get their own worktree; a crew mention, a crew turn with no run and an
  ended attempt's run all get the crew directory; a non-expedition Buddy gets the workspace root.
- **P3 (major) — the budget counted manager decisions.** "Budget 6 attempts" allowed one work
  attempt. `maxAttempts` now counts work and check attempts (`workerAttempts`); manager decisions
  have their own cap, `managerCap = 2 × maxAttempts + 2` (one to start each attempt, one to act on
  its result, plus the first plan and the done), finishing `decisions_spent` when it runs out. The
  last result is still shown to a manager before `attempts_spent`. A manager is woken only when
  something is actionable: owner feedback always; otherwise not while a done validation or a merge
  is in flight, and never for a code claim whose candidate validation is still running (the smoke
  manager spent turns saying "awaiting host validation"). Once the budget is spent, the manager's
  own echoes (a refused action, a question it added) are not news, so one manager sees the last
  result and no refusal chain runs to the decision cap. Badge, page and `status` count work and
  checks; the page also shows decisions.
- **P4 (major) — done on host checks alone was incoherent.** The question stayed open, panels were
  empty, the badge said "0 verified" on a done expedition, and the manager's `close_question
  verified` was refused. Now a claim whose candidate validation passed every command check and
  that was integrated is verified for its question: `Verification = panel{panelId} |
  host{validationId, mergeSha}` (queries.ts, on the page as `verifications`). The host closes the
  question verified (its `why` names the validation and merge), dependants unlock, the manager's
  close is accepted, and the badge counts distinct verified claims. A later refuting panel on that
  claim withdraws it everywhere (`hostVerifications`, the badge's `verifications`, the close rule),
  as it withdraws an earlier verifying panel. A question already closed verified stays closed (as
  with panels); the manager can close it again with a reason. Judged done items still need a goal panel; the manager brief says both.
- **P6 — owner model words failed.** "claude haiku" was refused (the catalog takes full ids). The
  charter canonicalizer (`charter.ts charterOf`, given the installed catalog's models) resolves a
  seat model that is not a catalog id when its words pick exactly one model of that provider (by
  id or display name), once, at ingestion, and lists each in `resolved`; otherwise the seat check
  refuses it listing the valid ids. A provider that accepts ad-hoc ids (`supportsDynamicModels`:
  pi, opencode) is never resolved: `opencode/gpt-5` would otherwise become `opencode/gpt-5-nano`.
  Aliases resolve too (`sonnet` → `claude-sonnet-5-5`): kept as
  written, they would defeat the check-independence rule, which compares model strings.
- **P7 — the launch link was refused when posted.** The result carried
  `[⛺ name](/expeditions/<id>)`; the Buddy posted it and the post tool treated the relative path
  as a media attachment. The result now carries `page` (the path as data) and `next` says the badge
  is already in the chat; `BUDDY_TOOL_GUIDE` says to post no link.
- The badge lands as a threaded reply to the owner's launch post in a DM (kept; README says so).
- Out of scope: P8, an orphan MCP relay process after the server is killed (pre-existing Buddies
  behavior).

### R10. Draft card, expedition modal, clean chat lines (2026-11-01)
Owner requests with screenshots: a draft should be a widget with Info and Launch; the full-page
expedition view was ugly, hid the goal's markdown and replaced the conversation pane; the launch
post was cut mid-word ("…Engin"); the crew Buddy was listed as a team member.
- **Drafts persist and post a card** (`drafts.ts`, one store owned by the host). A draft is
  `{t:'open'} | {t:'launched', expeditionId} | {t:'superseded', by}`, stored whole and atomically
  at `<root>/drafts/<draftId>.json` (the directory is made on first save, so a copied store with
  its gate disabled writes nothing, and the host refuses `draft` there). The card goes where the
  badge goes (`placementOf`, shared with `post_badge`). The card's Launch (HTTP, `routes.ts`) and
  the tool's `launch` share `host.launch`, its serialization and its refusal list; a refusal is
  data for the card, not a thrown error. Writes are serialized: a double click is one expedition,
  a second click answers the same id. A draft is read and launched only under its own workspace;
  that is a consistency check, not an access boundary (the client names the workspace and every
  `/api` caller is the owner). Crash safety: the store reads each file through a zod schema at boot
  (a malformed draft is logged and reads 404), and an open draft whose key launched at or after
  its `createdAt` is launched (recomputed from the ledgers on every boot, and at click time when
  the launch answers `already_running`), so a crash between the ledger append and the draft save
  never lets one draft launch twice. Superseded drafts are written before the new one. Wire shapes:
  `ExpeditionDraftView`, and `ExpeditionCharterView`, which a live view and a draft share
  (`view.ts charterView`) so the modal has one Charter tab.
- **One modal** (`client/.../ExpeditionModal.tsx`), live or draft, on the shared `ModalDialog`
  (native `<dialog>`: Esc, backdrop, focus trap, focus back to the opener) also used by the Task
  overlay and the file viewer, styled as a widened `.channel-task-overlay` with markdown in the
  file preview's `.file-preview-markdown` surface, rendered through the chat's own
  `ChannelMarkdown` (line breaks, Buddy/Task links, code) so there is one markdown flavor. `/expeditions/:id` opens it over the view it was
  opened from (react-router background location, `expedition-overlay.ts`), over home on a direct
  load; a full-height sheet at phone width (it follows the viewport while open). The old page is
  deleted.
- **Polish pass (2026-11-01 click-through)**: one type scale (the top-layer dialog had inherited
  the page's 16px); section rhythm; bars with a distinct track; filled active tab; totals on tabs;
  `:focus-visible` rings only; non-sticky day band in the modal chat; a finished run shows `took
  …` and one **Result** callout (`ExpeditionRun.finished.at`). The view names work by question
  title (`attemptTitle`), carries the manager's brief apart from the full prompt (`ask`), splits an
  outcome into `verdict` + `summary`, and gives `after` with titles. A draft's `defaulted` is the
  list of charter fields (`ExpeditionDefault`), shown as a `default` marker on the values; the tool
  result still lists them as lines (`defaultedLines`). Chat news uses titles, never ids (`▶ Started:
  Work on “…” (seat)`, `➕ New question: …`, `**Result** (done):`), and the host's expedition
  posts carry no purpose tag (`postPurposeLabel`).
- **Chat lines never cut a word** (`news.ts clip`): one flattened line, cut at a word boundary
  with `…`. The launch post is `⛺ Launched **<name>**: <goal's first sentence>` with `Planning…`
  as its own paragraph (`goalSummary` drops headings and list markers). Status posts were plain
  markdown all along; they broke because a raw slice of the goal carried cut list and emphasis
  markers, and a `+ question` line opened a list that swallowed the lines after it. The owner
  question and the finish summary keep their markdown (`clipBlock`: own paragraph, word-boundary
  cut), and the charter name is escaped (`literal`).
- **Crew Buddies off the roster**: `GET /api/buddies/expeditions/crews` lists every crew Buddy
  (from `crew_ready` entries, never a name pattern); the sidebar, the channel rail and both Buddies
  directories hide them through one `rosterHiddenBuddyIdsAtom`. Until the list loads (or while it
  fails) no crew is hidden: a crew briefly listed is harmless, a teammate hidden on a guess is not.
- Guards: `expeditions.test.ts` (draft card placement and evidence, HTTP view and launch,
  idempotent second click, superseded 409, other workspace 404, crew cannot draft, tool launch
  closes the card, restart keeps launched, crash-window reconcile, malformed file at boot, thread
  placement, open-draft issue re-check, 422 at click, crews endpoint, clip never splits a word),
  `expedition.test.tsx` (card buttons and disabled reasons, modal markdown through ChannelMarkdown,
  status post markdown, roster incl. the phone directory), `expedition-overlay.test.ts` (routing).
  Not covered by tests: Esc/backdrop closing (the client tests render static markup with no DOM);
  the browser pass checks it.

### R11. Robustness and per-question acceptance (2026-11-01)
Sources: the live incident on expedition `own-engine-geometry-opti-1b837b` (2026-11-01, ledger
replayed from `server/test/fixtures/expeditions-live/`, with the three other expeditions stuck
that day) and the
oompa audit's expedition robustness list (sections 4 and 5). Each fix names its incident at the
code site and has an integration test in `server/test/expeditions.test.ts` that fails with the
guard broken (each mutation-checked once).

**L1 — per-question acceptance (the design deadlock).** The charter's done command
(`verify.py`, fail-closed until G1–G9 all pass) ran on every claimed candidate before integration,
so no preparation commit could ever integrate, and the manager ended asking for a "host
maintainer". Now the goal's done checks run on the expedition branch head at done ONLY. Every
question carries `acceptance: {rule, provenance}` with
`rule = {t:'command', argv, timeoutSeconds} | {t:'panel'}`, required on `add_question` and
changeable on an open question with `set_acceptance`. A `command` acceptance is host-run on the
claim's immutable candidate in a fresh tree, exactly as before (a validation now freezes its
`checks` when planned: the acceptance for a candidate, the charter's commands for the head). A
`panel` acceptance needs a verified independent check panel before `integrate`; a `command`
acceptance needs the candidate validation of the CURRENT acceptance passed, and a refuting panel
on it blocks the merge. Each declaration is a revision (`rev`, `trustedSha` = the expedition head
when it was declared; ledger.ts `DeclaredAcceptance`). A validation records the revision it was
planned for (`basis`), only the current revision's validation decides a claim, and a
`set_acceptance` plans a new validation for every unmerged claim on that question (2026-11-01
review: one validation per claim, kept whatever the acceptance became, meant a claim first
validated by a command that could not pass, or a pre-R11 validation of `verify.py`, never
integrated: the same deadlock at the level of one claim). `acceptance_set` is shown to the next
manager like `question_added`, so a turn that only fixes an acceptance is followed by one that
acts on it instead of a quiescent "needs you". Host
verification (R9 P4) follows: a claim is host-verified when its candidate validation passed and it
was integrated. Ledgers written before R11 fold through one κ (`ledger.ts canonical`): a
`question_added` without acceptance becomes `{rule:{t:'panel'}, provenance:'legacy'}` (explicit
data; the goal command never becomes a candidate gate by default), and a `validation_planned`
without `checks` gets the charter's commands, which is what it ran. Trust note: the manager (an
agent) now names commands the host runs. They run with the same curated environment as done
commands (and, since #3, a throwaway HOME and TMPDIR), on agent-written code that a done
command would run anyway.

**L2 — answers lost on format.** The manager answered a bare JSON object, the worker that
committed the verifier (`w64130b`) a prose summary; both became `malformed` and the commit was
ignored. Now `parseOutcome` takes a bare top-level JSON object that ends the answer after the
last fenced json block (or with no fence), else that last fenced block (strict schema unchanged).
The bare final object wins so an answer that quotes a fenced snippet and ends with its own result
is not read as the snippet. A first answer that does not parse is not final: the host
records `attempt_repair_posting {error, body}` and posts ONE repair request on the same seat
(keyed `exp:<id>:attempt:<a>:repair`; it quotes the answer and the schema; a worker's repair run
starts in the same worktree, matched by its bytes). Phases carry the round
(`posting|posted {round: brief|repair}`); a malformed repair answer ends the attempt. No repair
is posted once the expedition is finished: the answer ends the attempt as it is (2026-11-01
review: a repair after stop started a paid run the one-shot cancel never stopped). A work attempt
that ends with anything but a code claim (a finding, blocked, malformed, failed, cancelled,
abandoned; a claim its branch does not hold is malformed) while its branch holds commits beyond
its base ends `unreported_commits {shas, ended}` (`ended` is how it ended by itself). The
live run had two such commits: `w64130b` (malformed) and `w475a3b` (a `finding` whose tree was
kept with ACCEPTANCE_ROUTE.md). The manager may `claim` a commit of such an attempt (or of a
legacy `malformed`, `finding`, `blocked` or failed one): `claim_planned`, then
the host checks the claim against that attempt's branch and custody (`claimHeld`, as for any
claim) and records `claim_adopted` (the attempt's outcome becomes the claim, validated or checked
per its question's acceptance) or `claim_refused {reason}`. A pending adoption counts as host
work (else the deciding turn looked quiescent and asked the owner). Metering counts every request
of an attempt.
A check that ended `malformed` before R11 never had its repair (live `actual-game-daily-local`:
three reviewers wrote "VERIFIED." in prose, all three panels read not_verified, and the manager
asked the owner for a "host repair"). While the run is `running` (after the owner's resume; never
from "needs you" by itself) decide reopens each such check with the same `attempt_repair_posting`
(`repairLegacyChecks`): its panel is pending again, the verdict is read under the strict schema,
the attempt is metered again over both requests, and its run starts in the crew directory when
its tree was already released. A host parse failure therefore never asks the owner by itself:
one repair, then a typed `malformed` end the next manager is shown.

**L3 — recovery after an upgrade.** Nothing resumes by itself at boot: a ledger in `needs_owner`
stays there. The owner resumes by writing in the expedition chat (or a Buddy steers): `resume` now
re-plans (it is shown to the next manager; before, a resume from "needs you" left nothing unseen
and the run asked again at once), as does any note. The next manager runs under the new rules and
can claim the dropped commit. `extend <hours>` (chat) / `{t:'extend', hours}` (tool) moves the
deadline, since a run left waiting may be past it. The incident-replay test folds the scrubbed
live ledger, resumes it from the chat, claims `w64130b`'s commit, validates it with the question's
own command (never `verify.py`) and integrates it.

**Audit #1 — the wedge.** Observation is typed data: each posted attempt and the chat are read on
their own, and a failure is a reason, never a throw before decide. Decide checks the owner's stop
and the deadline before setup and everything else. A tick whose observation failed or that threw
extends the expedition's failure streak; after 3 in a row the host appends `tick_failed {failures,
reason}` (news, page `status`) and waits a doubling backoff (1 min up to 30 min); an owner steer,
or an owner post in the expedition chat (the L3 resume path), retries at once. Effects run each
on its own: one that throws is a reason of that tick, never a stop for the effects after it, and
a finished expedition's `cancel_attempt` effects come first (2026-11-01 review: a failing tree
release kept the stop's cancels from running).

**Audit #4 — ledger tear.** `store.ts appendBatch` writes, then fsyncs, then the host applies; a
write that fails is cut back (`ftruncate`) to the size before it, so a failed append never leaves
half a line for the next one to be glued onto (which boot would quarantine).

**Audit #5 — hot retry.** A check job that throws (spawn refused) records one terminal
`validation_failed {reason}`; the validation is complete and failed, done is refused with the
reason, and it is never re-run. Charter and acceptance argv refuse a NUL byte and an `argv[0]`
with surrounding whitespace at ingestion.

**Audit #6 — the manager's tree, and the head before a merge.** A manager decision runs in its own
detached worktree (`git worktree add --detach`, `<root>/<id>/manager`), made once the integration
tree exists (a pre-R11 ledger gets one on its first tick), reset to the branch head before every
manager brief, released at finish once no manager runs in it. It is never the owner's checkout and
never the integration tree; decide waits for it like the integration tree, and its failure
finishes `setup_failed`. Before each merge `mergeCandidate` requires the integration tree's HEAD to
be the ledger's head (`headOf`): a branch moved outside the host is refused
`{phase:'tree', reason}`, never merged onto.

**Audit #8 — incremental fold.** The host keeps each expedition's folded state and applies every
appended batch to it (boot folds once); decide works on a clone (it applies its own intents). The
test compares the host's view with a fresh replay of the file. The modal and badge stop polling a
finished expedition with nothing live (`expeditionPollMs`); `buddies_changed` still refreshes them.

**Also fixed.** Display-only metering no longer keeps a never-settling run's expedition active
(bounded window). Creation is exclusive (`mkdir` without `recursive`, ledger opened `wx`).
`list` reads only expeditions that fold. `run()` is a thin dispatcher over one handler per effect
kind. A missing attempt branch is typed (`BranchState.missing`): `no_code` on it is not held, and
release removes the tree without pretending to drop a branch (it used to count as zero commits).

**Audit #2 — stop and deadline cancel live attempts.** Once an expedition is finished (any
reason), each posted attempt gets one `cancel_attempt` effect: the host lists the crew's runs for
that attempt's requests and cancels every unsettled one exactly as the owner's Stop does (the
crate's `cancelRun`, then the `cancelled` event the runner kills the turn on), recording
`attempt_cancel_requested {runIds}`. A run that ends answers or fails as usual; one still not ended
`CANCEL_GRACE_MS` (5 min) after the request is ended by the host as `abandoned {reason}`, so its
tree and slot are released instead of held by a run that ignored its stop. A recorded brief is
still posted after finish (it may already exist) and is then cancelled the same way.

**Audit #3 — a throwaway HOME for checks.** `runCommand` takes a scratch directory beside the
validation tree (`<tree>.scratch`, never inside it, so a "clean checkout" check is not disturbed),
makes `home/` and `tmp/` there empty for the run, passes them as `HOME` and `TMPDIR`, and removes
them after. The curated environment no longer carries the owner's HOME, so `$HOME/.ssh`,
`~/.aws` and a CLI's saved token by HOME are not where a check looks. This hides `$HOME`, not
the owner's files: there is no sandbox and USER/LOGNAME pass through, so a check that names the
owner's home by absolute path (or `~user`) still reads it. Network and separate-user isolation
are not attempted (audit open question 6).

**Audit #7 — host git without hooks or secrets.** Every host git and Cambium process runs with
`gitEnv()`: an allowlist (PATH, HOME for the owner's git identity, USER, LOGNAME, LANG, LC_ALL,
TZ, TMPDIR, `GIT_AUTHOR_*`/`GIT_COMMITTER_*`) plus `GIT_CONFIG_COUNT=2`,
`core.hooksPath=/dev/null` and `core.fsmonitor=false` as command-line config, which outranks a
repository's own settings and reaches Cambium's child git processes. A repository hook
(post-checkout on a tree add, pre-merge-commit/post-merge on an integration) never runs for the
host. Known limit: other config-named commands still run in host git, e.g. a
`filter.<x>.smudge`/`clean` selected by a committed .gitattributes, or `diff.external`, and a
worker in a linked worktree can write the shared .git/config (reproduced in review). Git has no
switch that turns every filter off. Such a command sees only this environment (no provider keys),
but the owner's real HOME.

**Audit #9 — release is forced once its guards pass.** Release moved to `release.ts`. A worker's
tree goes through oompa's guard ladder in order: git cannot read it, it has uncommitted or
untracked changes, it is off its own branch (when that branch exists), or a merge, rebase,
cherry-pick or revert is half-done. Any rung refuses: the tree is `left {reason}`, never forced.
Past the ladder, unintegrated commits are salvaged and ignored output harvested (below), and only
then is the tree removed with `cambium remove -force`; a plain remove refuses a tree whose
submodule was initialized ("working trees containing submodules cannot be moved or removed",
reproduced), so such trees leaked. Validation trees are scratch: no dirty rung, but they are
salvaged and harvested too.

**Audit #10 — checks across a restart: typed interruption, re-run on the same sha.** The host
appends `validation_running` before it starts a check job. A process that finds a validation
`running` that it never started itself (it keeps the keys of jobs it started) knows the job died
with an earlier process: it discards that tree (salvage and harvest first) and appends
`validation_interrupted {release}`; the validation goes back to `planned` with `interruptions + 1`,
and its next tree has a fresh name (`<validation>-r<n>`), so it never adopts the tree an orphaned
check may still be writing into. Checks already recorded are kept; the unrecorded ones run again
on the same immutable sha. Chosen over adoption because adoption needs a detached wrapper with
pid and exit files that outlives the server, and a pid from another boot cannot be trusted; a
re-run on an immutable commit is correct by contract and costs only its time. Known limit: the
orphan is not killed (its tree is pulled away, so it fails fast).

**Oompa ports.** Each has an incident-replay test (see the table below):
- *Strict verdict parsing.* A check panel answer counts only with exactly one verdict object that
  ends the answer: a quoted example verdict followed by the real one, or prose after the verdict
  ("Actually NOT verified…"), is `malformed` (one repair turn, then not counted). The verdict enum
  already refuses "not verified" and plain prose such as "NOT APPROVED".
- *Validator source pins.* A candidate validation trusts the validator files its acceptance's
  argv names as they were committed at the acceptance's `trustedSha` (the expedition head when
  the manager declared it): a candidate whose bytes for such a file differ is refused before it
  runs (`error`, "the candidate changed the validator …; re-declare the acceptance"), so a worker
  cannot commit `exit 0` to the validator that accepts its own work (2026-11-01 review: pins taken
  at the candidate sha only recorded the cheat's own hash). A file the trusted commit does not
  have (a validator the candidate adds) is trusted at the candidate. At done the head is the
  trust root. The host then hashes (SHA-256) the pinned files, refuses to run when the tree's
  bytes differ, and re-reads them after the run: a check that changed its own validator is
  recorded `error` whatever it exited. A git failure while pinning ends the job
  `validation_failed {reason}`; it never runs unpinned. Every `validation` entry carries its report
  `{t:'expedition.validation/v1', targetSha, pins, pinCheck: held|changed|unpinned}`; entries
  written before this fold as `unpinned` with reason `legacy`.
- *Salvage ref.* Before a tree whose branch holds commits the expedition branch does not is
  removed, the tip is pinned at `refs/salvage/expeditions/<id>/<attempt-or-validation>` and
  recorded `preserved {salvaged}`. Unmerged attempt branches also stay, as before.
- *Harvest of ignored output.* Before removal, ignored files under `output/` (`HARVEST_DIRS`) are
  copied (copy-on-write where possible) into `<root>/<id>/harvest/<tree>/` at the same relative
  paths and recorded `preserved {harvested, files, bytes}`. Over 512 MiB or 10 000 files the
  harvest is refused whole and the tree is `left`, never half-copied.

### R11 live delivery on a real repository (2026-11-01)
The first end-to-end delivery (audit plan step 3), at `bfbb0c4`, on a local `--shared` clone of
wave_sim `main` (23k files, ~870 MB checkout, one 863 MB submodule initialized) whose checkout was
made deliberately dirty (two modified tracked docs, one of them the target `agent_notes/README.md`,
and an untracked file). Throwaway server and stores; one Buddy, Sonnet 5.5, low effort. The owner
asked for two tasks (a check script and a README section) with done = the script passes.
- Finished `done` in 8 min: 4 worker attempts of a budget of 6 (2 work, 2 check), 7 manager
  decisions, one answer-repair round. The manager declared `panel` acceptance on both questions;
  each claim was verified by an independent check and merged `--no-ff` onto
  `expedition/<id>` (two merge commits). The done command ran exactly once, as one head
  validation of the merged branch in a fresh tree (pins held); no intermediate claim ran it.
- Owner checkout: `git status --porcelain=v2`, HEAD and the SHA-256 of every dirty file were
  identical before and after; the submodule was untouched. Refs: only `expedition/<id>` was
  added. Every attempt, validation, integration and manager tree was removed and its scratch branch
  deleted (`git worktree list` back to the owner's checkout alone); no salvage or harvest was
  needed, because both claims merged.
- Runs: 12 crew runs, one per posted request (11 attempts + 1 repair), plus the launching
  Buddy's one turn; no stray deliveries. Cost: 34k input + 10k output tokens (604k cache read,
  284k written), measured from the providers.
- Wall time is dominated by tree I/O on a repository this size: each worktree add took 40–70 s and
  each removal 6–16 s, about 4 of the 8 minutes.
- Found and fixed: a finished expedition's badge clock kept running ("finished · 10m" two minutes
  after the finish). `Run.finished` now carries `at` and the badge's elapsed time stops there.
- Not exercised live: populated submodules inside attempt trees (`git worktree add` leaves them
  empty, so the forced removal of a tree holding one is covered by the test only), check HOME
  isolation (the done script never reads HOME; covered by "a check cannot read the owner's home"),
  salvage and harvest.

### Lessons from oompa
The oompa audit (2026-11-01) read oompa's history for the failures it paid for. Its durable value
is that catalogue, not its loop, so expeditions take mechanisms one at a time with an incident
replay each, and keep their own loop, ledger and integration.
"Ported" means the mechanism is reimplemented here with an incident-replay test; "Idea" means
only the lesson shaped an existing design; "Kept" means expeditions already had their own answer.

| Oompa incident | Refinement | Expeditions |
|---|---|---|
| A dirty root index made every later `checkout main` fail | Abort the merge, clear MERGE_HEAD before releasing | Idea: `mergeCandidate` aborts an interrupted merge first (R3), in its own tree |
| Run 9f004a39 deleted ~2.5 h of approved work | Clean up only after a successful merge; pin a `salvage/` ref | Ported: `refs/salvage/expeditions/<id>/<tree>` before removing a tree with unintegrated commits |
| Merge-no-claim killed 32 of 36 worker lifetimes | Non-fatal, bounced back as a CLAIM prompt | Idea, done here: `unreported_commits` + the manager's `claim` (L2) |
| Overlapping swarms: 18 of 22 stale-base rejections | One swarm per project | Idea: custody admission (R1) and one integration chain per expedition |
| Dead runs showed "completed" for ~20 h | A truthful `stopped.json` | Idea: the ledger is the only state; finish reasons are typed |
| A corrupt worktree entry burned 20/20 iterations; 124 checkouts left 9.7 GiB | Stale-worktree handling, then Cambium | Kept: Cambium trees, typed `worktree_failed` (R1). Ported: the removal guard ladder, then a forced remove (#9), and the harvest of ignored output (swarm 455987ea lost a paid run's raw gauges to a "clean" removal) |
| A retry started a model on the wrong base | Bounded create plus a verified HEAD | Kept: adoption checks branch and base (R1); idea: merge checks the head (R11 #6) |
| Swarm 455987ea left claims stuck `in_progress` | CAS release of abandoned claims | Does not apply: expeditions have no shared claim queue; the ledger is single-writer per expedition (serial chain) |
| Swarm e992a8d9 resumed 9 times against a missing target | Typed blocked returns | Kept: `blocked {need}` and typed outcomes |
| The "stale task loop" | A no-diff merge completes the task | Kept: `no_code` claims, checked against the branch (R2) |
| Reviews judged on `--stat`, biased verdicts | Real diff, latest round, neutral wording | Idea: blind checks reproduce at the candidate commit (R2) |
| `\bAPPROVED\b` counted "NOT APPROVED" | Strict explicit-approval parsing | Ported: one verdict that ends the answer. Also fixed at the source: the Buddies oompa host now requires `task_execution`, so oompa never falls back to that queue path |
| A `$&` in a diff crashed every review | `Matcher/quoteReplacement` | Idea: briefs are built by concatenation, never regex replacement |
| One hung cycle burned 434 minutes | Three counters collapsed to one knob | Idea: one attempt budget plus a derived decision cap (R9 P3), timeouts on every check |
| The first startup died on a closed stdin | Probe the workers' real execution path | Idea: the smoke runs real crew turns (R9) |
| Validator replaced by the candidate | SHA-256 pins before and after, typed report | Ported: the files a check's argv names are trusted at the head when the acceptance was declared (a candidate that changed them is refused), hashed before and re-read after the run, `expedition.validation/v1` in every `validation` entry |
| Only the oompa host survived a restart (detached wrapper with pid and exit files) | Process adoption | Idea only: a typed `validation_interrupted` and a re-run on the same sha in a fresh tree (#10); adoption needs a wrapper that outlives the server |
| Its harness adapters are a thin pipe to `agent-cli` | A catalogue of provider quirks | Idea only: crew turns run through the Buddy runner, which owns the harness |
| Its worker loop is one ~420-line loop/recur | Bounded resumes, wrap-up nudge, salvage on death | Idea only: attempts stay single-shot (one request, one immutable commit); retries are typed outcomes, never a second loop |
