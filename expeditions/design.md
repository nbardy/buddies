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
tests use the real tool on a temporary repository. Known gap: Buddy runs start in the workspace
root; the brief tells the worker to `cd` into its worktree (outside that root), which a provider
sandbox limited to its start directory may refuse.

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
host `run_validation`): a claim's `change` is a sum, `{t:'commit', sha}` or `{t:'no_code'}` (a
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

### R7. Kickoff
A Buddy suggests an expedition when the four tests hold and launches only when asked. The owner
says, in any thread, DM or channel: *"Launch an expedition: <goal>. Done when <checks>. Budget
<N> attempts."* The Buddy drafts the charter (asking only for missing done checks), launches, and
the badge appears in that chat.
