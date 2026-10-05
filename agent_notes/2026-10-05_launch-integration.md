# Launch integration 2026-10-05 (Release Engineer)

Task: task_01a10beb-c8be-742f-8bf0-010f4ed8c22d. Owner direction: #general post_01a10b92 "all fix and merge and push to main".

## Result

- origin/main: 4f61146 -> **c877be5** (fast-forward push from worktree `~/git/_wt/launch-1005`, branch `integrate/launch-1005b`).
- vendor/agent-cli-tool pointer 0acc04f: already on the submodule remote (`execution-journal-p1`, fast-forward of its main 1b82d82). Nothing new to push.
- Local `main` NOT fast-forwarded: stays 14eb81c. `git merge --ff-only` refused because another session's uncommitted edits sit on 5 merged files
  (ChannelBrowser.css, channel-restored.test.tsx, task-page.test.tsx, check-client-invariants.sh, screenshots.mjs). No stash/reset allowed, so left as is.
  When those are committed: `git merge --ff-only origin/main` (or merge) in the main worktree. That step reloads the live dev backend.

## Per branch

| Branch | Result | Merge commit |
|---|---|---|
| fix/workspace-general b99a894 | merged clean | b80aa35 |
| fix/buddies-bootstrap-rename 4b0f71d | merged clean | 35b553c |
| feat/structured-search 74d1fd3 | merged; tests/core.rs conflict = two new tests at the same spot, kept both | db00724 |
| fix/desktop-agent-detection d053c8e | merged clean | b192272 |
| fix/builder-reviewer-installed-agent 674ae35 (+ fix/installed-provider-default 4495c62, fix/unified-thread-model 27027d6 as ancestors) | merged; conflicts resolved (below) | ad10750 |
| fix/missing-cli-visible-error b6054e6 | **DROPPED** | (kept on `integrate/launch-1005-with-missing-cli` a4ee3fb) |

builder-reviewer conflicts: package.json keeps desktop's `test:desktop` + the branch's screenshots test in `test:tools`;
DependenciesPrompt.tsx keeps main's lazy WorkspaceTeamForm + setup reveal and reads the branch's shared `DEPENDENCIES_STATUS`;
buddies-v2.test.ts imports from both. Semantic fix: the branch's new MCP test now passes `portFile` (main made it required; typecheck failed only on the merged tree).
G8 CSS ceiling +9 (569ca53) for the installed-provider no-agent DM error line.

### Why missing-cli was dropped

Main's P1 execution journal (vendor `journal.ts`) launches every provider through a detached `/bin/sh` wrapper. A missing CLI is
now `sh: codex: command not found` + exit 127 in the journal, never Node's `spawn codex ENOENT`. The branch keys on that ENOENT regex
(`missingCommand` in runner.ts), so in the merged tree it never fires, and its own regression test fails (with PATH emptied, the
wrapper cannot even write exit.json, so the turn reads as "execution was lost"). The conflict in `completionBroke` resolved cleanly
to main's drained->settle outcome, but the detection itself needs a redesign (classify exit 127 / "command not found" from the
journal's stderr, likely in agent-cli-tool `execute.ts` next to `silentExitError`) and a new test. Not something to do under launch pressure.

## Gates on 569ca53 (clean tree), plus c877be5

c877be5 = 569ca53 + merge of local main 14eb81c (two `product/releases/launch-2.0` files only); typecheck + invariants rerun on c877be5.

- pnpm typecheck: pass. tools/check-client-invariants.sh: 9/9 pass.
- cargo test (crates workspace, --no-default-features, both crates): all pass.
- test:desktop 3/3, test:tools 13/13.
- test:client 227/229. Both failures also fail on origin/main 4f61146 (checked in the clean `unleashd-wt-auth-local-trust` worktree):
  channel-dm "only a harness failure offers a retry on another harness", channel-restored "the Task filter shows one Task across channels".
- test:server 277/280, 1 fail: ctrl-c-adoption (a different subtest each loaded run; one hit 300 s). Passes 4/4 alone.
  It is not on origin/main (it arrived with local main's P1 commits, 7766937), so it was judged as load-sensitive, not caused by a branch. run-lease
  failed in the first full run and passed in the second and alone.

## Environment

Disk hit ENOSPC twice during the run (other sessions' install tests/builds; free swung 0.3–2.9 GB). Cleared 2.6 GB of rebuild-on-demand
caches via `~/git/cleanup_tools/disk.py clean caches --yes` and cargo-cleaned this worktree's target. The machine is still near full.

## Reconciliation 2026-10-05T17:21Z (Development Lead, run_01a10d13-40d4)

Asked by Product Lead (post_01a10d13-40d1) for per-branch dispositions. Method: `git fetch`; for every local branch
not an ancestor of origin/main, `git cherry origin/main <b>` (unique patches) and `git merge-tree --write-tree origin/main <b>`
(clean? tree == main?). Read-only; nothing merged in this turn.

Refs: origin/main = afd4f65. Local main = afd4f65 + 852a1bf (Designer, launch-song audio; product/releases only), NOT pushed.
Public DMG = 14de9f4 (older than afd4f65). Disk: 2.3 GB free (below the 5 GB floor for full suites).

`fix/missing-cli-127` points AT 6990beb (in main) with no commits: the 127 redo is NOT merged. Its work is uncommitted
in `~/git/_wt/missing-cli-127` (5 files, last edit 17:06Z) under worker run_01a10cf8-bd89 (still running). An earlier
version of the same fix is commit e6dcbad on `tmp/rc-trial-1005`, also unmerged.

| Branch | Disposition | Evidence / reason |
|---|---|---|
| fix/missing-cli-visible-error, fix/missing-cli-127, tmp/rc-trial-1005 (e6dcbad) | **IN FLIGHT — launch blocker** | worker run_01a10cf8-bd89; nothing in main yet |
| fix/stale-worker-badge (1 commit) | **TO MERGE** | merges clean (+158 lines); was in the finished list but missing from the RE's table |
| fix/buddy-channel-create (1 commit) | **TO MERGE** | merges clean (+55); worker run_01a10cf6-dd25 complete |
| feat/channel-search-fuzzy / integrate/search-fuzzy / integrate/launch-wave2b | **TO MERGE if green, else HOLD** | conflicts vs main now (posts.rs, search.rs, mcp.ts, check-client-invariants.sh); last server run SIGTERM'd, no result |
| fix/outage-tool-delivery | **HELD (post-launch)** | ctrl-c-adoption 1 fail/3 runs, full suites not run (disk) |
| feat/durable-pending | **HELD (post-launch)** | design branch W0b/W1, branch-only by request |
| fix/run-active-buddy-index-20260930 | **HELD** | 337da24 adds the on-open IF NOT EXISTS for run_active_buddy; main still has it in base DDL only (schema.rs:135). Fresh installs fine; matters only for a pre-index DB. Needs an engineer's 5-minute check, not a launch blocker |
| rescue/2026-10-05/unleashd-thread-follow | **HELD** | uncommitted-work rescue for the thread-follow Task (open) |
| connect-mobile | SUPERSEDED | `git cherry` 0 unique patches |
| continuity/p1-state | SUPERSEDED | 0 unique patches |
| continuity/{execution-adoption,ctrl-c-proof,adopt-wip-2026-09-30,p1-adopt,p1-wip-2026-10-02}, tmp/p1-guard-811f758, rescue/2026-10-04/unleashd-ctrlc, rescue/2026-10-05/unleashd-p1guard811, fix/lease-heartbeat | SUPERSEDED (by P1, 7766937 and successors) | remaining "unique" patches are pre-P1 versions of journaled adoption / lease heartbeat; main carries BUDDY_RUN_LEASE_MS and execution adoption. Archive-tag before delete |
| desktop-spike | SUPERSEDED | main has desktop/electrobun.config.ts and `desktop:build` (2f7fca7, 758d7da); unique patches are the spike's own originals |
| integrate/launch-1005, integrate/launch-1005-with-missing-cli, integrate/launch-wave2 | SUPERSEDED / abandoned | old integration branches; `~/git/_wt/launch-wave2` holds an abandoned half-merge (UU schema.rs, tests/core.rs from 12:55Z) — do not resume it |

Tests on the latest merged commit: typecheck + invariants 9/9 pass on afd4f65 (run_01a10cf8-505a). Client 230/231: the one
failure is channel-dm "only a harness failure offers a retry on another harness", pre-existing on 4f61146. The second earlier
failure (channel-restored Task filter) no longer reproduces. Server suite and cargo NOT rerun on afd4f65; last full server
run 272/280 under load, failures (ctrl-c-adoption, run-lease) pass alone and on origin/main.

Fresh-install trial: NOT re-run on any commit after 4b0f71d. The RE's installed-app PONG on the 14de9f4 DMG used existing
agent logins, so the Claude-only-PATH first DM (the missing-CLI case) has no evidence on a build that contains a fix.

## Final merge 2026-10-05T18:10Z (Sonnet worker, run_01a10d1d-a4a1)

**Pushed: `e09802b1bf4db4144505c9e59afe9d7266189374` on origin/main** (ff of b2cce9f). Contents added by this pass:
852a1bf (Designer audio only), fix/stale-worker-badge, fix/buddy-channel-create. The missing-CLI fix (42f6a5a/4c3ad21) and
fuzzy search (integrate/search-fuzzy, 33274ae) were pushed by other lanes while this pass ran; both were merged in, not redone.
Local main (3 launch-video commits 852a1bf/0ed0f2b/336b82e and others) is diverged (5 ahead, 14 behind): not fast-forwarded,
no dirty files touched. 0ed0f2b/336b82e (site autoplay, video v15) are NOT on origin/main.

Gates at e09802b (clean tree, integration worktree): typecheck 0; client invariants 9/9; client 235/236 (1 fail: channel-dm
"only a harness failure offers a retry on another harness", pre-existing, same as afd4f65); cargo --no-default-features
111 pass 0 fail (both crates); server 277/283 pass, 2 skipped, 4 fail = execution-adoption x4 (SIGKILLed mid-turn, Stop/timeout
inside kill grace, finished during the gap). Cause: port 7531 held by a concurrent worker (thread-follow-v2) running the same
file (EADDRINUSE seen in the log). Alone, after that worker idled: execution-adoption + execution-crash-checker 7/7, twice.
Earlier run on the pre-merge commit: ctrl-c-adoption 1 timeout in full suite, 4/4 alone (plus 1 skipped).
LESSON: fixed ports (7531, 7541, CDP 9333) collide across concurrent workers; the Release Engineer's rel-verify.sh also used 9333.

Fresh-install trial on e09802b (fresh clone, temp stores, `env -i`, PATH = node + claude only; screenshots WebP q95 in
`agent_notes/2026-10-05_fresh-install-trial-e09802b/shots/`): new workspace has #general + #upstream + Home composer
("What should the team build next?") (h1-home). First DM to Product Dev gets a VISIBLE result, "Not logged in · Please run
/login" (h2-dm), because the temp HOME has no Claude login; not a real answer. With no agent on PATH (0/6) the Buddy row shows
"No agent is installed. Install Claude Code or Codex from Setup, then try again." (m1-missing-cli). NOT shown: a real model
answer on a logged-in agent, and the 127 DM failure row (covered by the new conversation-runtime test, not re-driven here).
Note: with BUDDIES_HOME on a temp path and no UNLEASHD_BUDDY_EXECUTION=1, a DM sat "replying…" forever (execution gate) — a
trial must set it.

Archive tags created locally (not pushed, branches not deleted): archive/{connect-mobile, continuity/p1-state,
continuity/execution-adoption, continuity/ctrl-c-proof, continuity/adopt-wip-2026-09-30, continuity/p1-adopt,
continuity/p1-wip-2026-10-02, tmp/p1-guard-811f758, rescue/2026-10-04/unleashd-ctrlc, rescue/2026-10-05/unleashd-p1guard811,
fix/lease-heartbeat, desktop-spike, integrate/launch-1005, integrate/launch-1005-with-missing-cli, integrate/launch-wave2}.

| Branch | Final disposition |
|---|---|
| fix/missing-cli-127 / 42f6a5a | MERGED (4c3ad21, other lane) |
| fix/stale-worker-badge | MERGED (e09802b) |
| fix/buddy-channel-create | MERGED (e09802b) |
| feat/channel-search-fuzzy / integrate/search-fuzzy | MERGED via 33274ae (other lane). My direct merge of feat/channel-search-fuzzy conflicted in 7 files incl. add/add search.rs (design call), aborted before it landed |
| fix/outage-tool-delivery, feat/durable-pending, fix/run-active-buddy-index-20260930, rescue/2026-10-05/unleashd-thread-follow | HELD (unchanged) |
| the 15 SUPERSEDED branches above | archive-tagged |

## Lead verification 2026-10-05 (after the final merge)

Checked after `git fetch`: origin/main = e09802b; ancestors include 4c3ad21 (missing-CLI 127), 33274ae (search-fuzzy),
852a1bf, fix/stale-worker-badge, fix/buddy-channel-create; submodule pointer 7a41287 is on agent-cli-tool origin/main.
feat/channel-search-fuzzy's one cherry-unique commit b61c1a9 landed as 8187a7f (same change, re-applied) -> SUPERSEDED.

NOT on origin/main (local main only, concurrent sessions, unverified by any gate): 0ed0f2b site autoplay, 336b82e video v15,
23aab00 fix(buddies) keyed model retry, 098c83b onboarding lands on /, 4917ae9/6693795 video v16, 6338447 v16 rollback.
These need one more merge + gates + push before the final DMG, after their authors say they are done.

Known follow-ups: fixed test ports (7531 execution-adoption, 7541 ctrl-c-adoption, CDP 9333) collide between concurrent
workers and produced the "load-sensitive" failures; /tmp/fit.yBEB2x (2.9 GB trial clone) left for daily.sh (rm -rf hook
blocked the worker); 15 archive/* tags are local only; fresh-install trial showed visible errors, not a logged-in answer.

## Final unification, 2026-10-06 (lane integrate/final-1006, pushed caaffa2)

Pushed `origin/main` = caaffa284e91 (fast-forward from d34b156). Contents: e09802b + local main 31e759b + feat/thread-follow-v2 + run_active_buddy/run_follow_queued open fixes + G8 bump + Builder fix 2e9ca32 (cherry-picked as caaffa2).
Gates on the commit (clean tree): typecheck pass; 9 client gates pass; test:client 236/236; cargo --no-default-features both crates all pass; test:server 290 pass / 0 fail / 2 skipped (no port collision this run).

| Branch | Final disposition |
|---|---|
| integrate/final-1006 | MERGED (caaffa2) |
| feat/thread-follow-v2, fix/run-active-buddy-index-20260930 | MERGED (via final-1006) |
| integrate/launch-final-2 (2a0d882) | SUPERSEDED by final-1006; only unique commit 2e9ca32 cherry-picked; tagged `archive/integrate-launch-final-2` |
| fix/outage-tool-delivery, feat/durable-pending | HELD (other workers) |
| rescue/2026-10-05/unleashd-thread-follow | superseded by thread-follow-v2 (merged); not deleted |

Builder Task reload screenshot: not produced here.
