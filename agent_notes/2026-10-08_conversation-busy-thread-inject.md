# Thread replies to a mid-turn seat fail with conversation_busy; inject instead (2026-10-08)

Status: owner direction (accepted), lead diagnosis (proposed until the regression test confirms it).
Task: task_01a117e5-1391-7690-955f-fae9527cc872. Owner thread: post_01a117e1-1b0e-72e6-bef4-52b764bac275
(channel list_4bd52262-8f0b-465d-99e5-60cc33eb8565), 2026-10-07T19:39Z.

## Symptom
"Couldn't reply: [conversation_busy] conversation 38b91d03-… already has a live run". Posted three times
by Product Development Lead in the launch thread post_01a117a1 (runs run_01a117da-bfcd, run_01a117df-04a4,
run_01a117e0-2a04, all `execution_failed`) while run_01a117d6 (a delivery from task thread
task_01a117b8) held its seat 38b91d03.

## Diagnosis (lead, from source at 961ec3f + `runs` rows)
- 5d75897 (2026-10-07, part of the owner-approved thread-noise revert / follow-up gate restore):
  `bind_run` binds a subscription only for DMs or the Buddy's own post. A public/task seat stays
  unsubscribed so later posts go through the follow-up gate.
- Consequence: thread follow-ups enqueue with conversation_id NULL. `WAITING_REASON_SQL` blocks a
  NULL-conversation deliver only on a running deliver in the same root.
- The seat was busy with another root's delivery. The run was claimed, `seatTurn` chose the seat,
  `bind_run` hit the one-live-run constraint, and `noticeFailure` posted reply_failed.
- The runs.rs comment already warns against this: "Do not admit a run here whose job is decided
  after the claim".

## Owner direction
A message arriving while the Buddy works in that conversation is injected into the live turn after the
next tool call, framed "While you were working a new message arrived… adjust, but don't forget the
current work". It must never fail.

## Lead decisions (assistant, not owner)
- Keep 5d75897's unsubscribed public seat (an owner decision); fix the gate/bind, don't re-subscribe.
- Two typed paths per harness capability: inject (mid-turn input supported) | wait (conversation_busy,
  runs after). No silent fallback. Mid-turn input support is unproven for every harness as of
  961ec3f (no such path in vendor/agent-cli-tool); the worker establishes it with evidence.
- The worker is Opus (the injection design is open), per the 2026-10-01 worker-model policy.

Revisit if: per-harness injection proves unavailable everywhere (then wait-only, and tell the owner), or
injection mid-tool-chain causes turns to drop their current work.

## Successor, 2026-10-07T19:47Z: Product Development Lead's steering is the inject path (lead decision)
- PDL had implemented this before my worker started (posts post_01a117e7-0223, post_01a117e7-5fc6):
  - new unread current-thread posts are appended to the result of any Buddy MCP tool call
    (server/src/buddies/mcp.ts, existing catchUpThread fence);
  - a same-thread claim race repair in runs.rs;
  - tests in buddies-v2.test.ts and core.rs.
- No commit hash was given yet.
- Verified live: PDL's post reached my turn inside my `post` tool result.
- Supersedes my per-harness inject plan above. It works the same on every agent CLI and needs no CLI
  transport. Cost: injection happens only at Buddy tool calls, not after Bash or Edit (accepted for
  now; the owner was told and can ask for any-tool injection).
- My Opus worker run_01a117e5-83ed-722c-b698-deb1205ac53c was cancelled to avoid duplicating the work.
  It may have left a worktree.
- Still open, now concrete enough for Sonnet:
  - the cross-thread seat case (the actual live failure: the busy run came from another root);
  - the case where a turn ends without a Buddy tool call.
  PDL agrees the same-thread repair doesn't cover the first one.

## Successor, 2026-10-07T20:11Z: cross-thread fix f509912 reviewed (lead); merge awaits owner
- Sonnet worker: f509912 on fix/thread-busy-gate (base aa19d5a), worktree ../unleashd-wt-thread-busy-gate.
- Mechanism: when `bind_run` says conversation_busy, the run goes back to the queue naming the seat
  (crate `defer_run`), so the existing gate rule makes it wait.
- Chosen over teaching the gate the seat id. The seat id derives from host state, and a crate copy
  would be a second definition.
- Lead diff review found:
  - only a not-yet-executed run is deferred;
  - the runner's `holds` are set only after bind, so a deferred run is never renewed;
  - the re-claim goes to the seat's existing turn without subscribing it. 5d75897 is preserved.
- Tests: worker-reported (buddies-v2 72/72, crate pass); not rerun by the lead. Rest of the server suite
  not run. Line ceiling 11136 -> 11172.
- Asked the owner (post_01a117fe-10f6) to approve a local fast-forward plus an addon rebuild and
  restart. Recommended no push yet: main is 12 ahead of origin, including the updater commits that are
  pending the owner's A/B release decision.

## Successor, 2026-10-08T05:26Z: landed on local main as 4663353 (lead)
- The owner asked "I thought we fixed this?" (post_01a119f5-8a1c) with a screenshot.
  - The screenshot showed the 19:38Z/19:43Z failures, from before the fix.
  - A search found no conversation_busy failure after 19:43Z.
  - f509912 had never been merged: the merge question in post_01a117fe-10f6 went unanswered, and the
    lead left it waiting. Read the owner's message as the go-ahead to land it.
- Cherry-picked f509912 onto main 650a915, giving 4663353.
  - The one conflict was buddies-v2.test.ts, where both sides appended tests.
  - A union merge dropped the shared tail of the attachments test; it was restored by hand.
  - The diff against the parent shows additions only.
- Lead-run checks on the committed tree (for these paths, the tree equals HEAD):
  - pnpm addons rebuilt unleashd-buddies;
  - pnpm typecheck passes;
  - cargo test --no-default-features: all pass;
  - buddies-v2 73/73;
  - line gate 11170/11172.
- Not pushed. Live only after the dev backend reloads (deferred while turns run); post-reload
  behaviour not yet observed.

## Successor, 2026-10-08T05:30Z: pushed 51a5a10 on the owner's instruction
- Owner (post_01a119fa-dc4e): "commit and merge all branches and push".
- Backend pid 19173 started 13:23:07 +0800, before 4663353 (13:26:06). So the owner's restart ran code
  without the fix.
- Merged origin/main b8a1e3d (docs/index.html only) into main, then pushed: origin/main = main = 51a5a10.
  - This includes a concurrent session's df361d5 (Markdown/PDF preview), which I did not review.
  - Checks at 51a5a10: typecheck 0, client 257/257, line gate 11170/11172.
  - The only tracked dirty file that could affect typecheck is commands.ts, and its change is
    formatting only.
  - test:server was not run at 51a5a10; buddies-v2 73/73 ran at 4663353.
- "Going live" relies on tools/watch-server.mjs design: a source or addon change drains the backend,
  which reloads once its turns finish. I did not observe the reload.
- Branch triage was delegated to an Opus worker (post_01a119fd-1384, Task task_01a10beb). Rule: land
  only finished, non-superseded work; WIP, rescue snapshots and unapproved behavior changes go to the
  owner; no branch deletions.

## Successor, 2026-10-08T07:27Z: owner wants interruption at ANY tool use; "run limit" label is wrong
- Owner reports (07:24Z, 07:25Z, 07:27Z):
  - Game Designer's thread was stuck with "X is replying… · X and X are queued at the run limit".
  - Owner direction, restated: owner replies made while an agent is replying should interrupt it
    (first given 2026-10-07T19:39Z).
- Lead's first answer (post_01a11a67-d4f3) blamed the per-Buddy pool plus dc299ec's removed 60-min
  cutoff, and proposed "owner first" past the pool. RETRACTED (post_01a11a68-ad19):
  - Product Development Lead showed the busy turn was Game Designer's own reply in the same thread;
  - the lead then found that the label "queued at the run limit" is applied to EVERY queued delivery
    (server/src/buddies/channels.ts:297 -> client channel-data.ts:657), whatever the waiting reason.
  The pool hypothesis had no evidence.
- Real gap: aa19d5a steers only at a completed Buddy MCP tool call. A turn running Bash/Edit or
  waiting on native sub-agents never receives the owner's message, which then waits for the turn.
- Accepted owner requirement (twice stated, so no new approval needed): inject at the next tool use of
  any kind.
  - Task task_01a11a68-4873-7712-8ca8-64b9b102f8a7; Opus worker post_01a11a68-7f62.
  - Per-harness mechanism with evidence (e.g. a Claude PostToolUse hook with additionalContext).
  - Also covers the queued-model-pick suppression found by Product Development Lead.
  - Also fixes the mislabel: carry the real waiting reason.
- Facts: max_active_runs is per Buddy, default 5 (schema.rs:43). Running runs are counted per
  buddy_id; queued runs are claimed oldest-first (runs.rs:273). The 60-min background cutoff was
  removed by owner request (dc299ec); not to be reopened without the owner.
- Lesson: the lead reasoned from a UI label without checking what the label maps to. Check the
  label's source before diagnosing from a screenshot.

## Successor, 2026-10-08T09:18Z: any-tool steering live (a4696ed); Task task_01a11a68 closed
- The worker answered (post_01a11acd-93f4) and pushed a4696ed. Lead checks:
  - reflog: main fast-forwarded at 17:11:31 +0800;
  - the live backend, pid 28481 under dev-supervisor 3187, started 17:12:20, so it runs a4696ed;
  - my 09:15Z "restart now" was therefore unnecessary, and I posted a correction (post_01a11ace-9e8f).
- Mechanism (detail: agent_notes/2026-10-08_steer-any-tool-boundary.md):
  - Claude and Codex post-tool hooks call the Buddy loopback and reuse aa19d5a's fence;
  - other harnesses stay Buddy-tool-only.
- Accepted divergence (lead): a message carrying an explicit model pick waits for its own turn.
  - This differs from the lead's 08:17Z review preference (deliver the text now, keep the pick for
    the next turn).
  - It is allowed by criterion 3, and it is documented and tested.
  - Revisit if the owner wants picked messages to steer inline. That needs the pick's config stored
    outside the consumed run.
