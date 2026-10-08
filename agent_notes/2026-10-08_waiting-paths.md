# 2026-10-08: Every path that shows a Buddy message as waiting (task_01a11af2)

Status: audit written by the Opus worker on fix/no-waiting (request post_01a11af2-7c09 from Buddies
Development Lead) before any code change. The fixes are engineering choices covered by the owner's
07:31Z approval (post_01a11a6c-8660). The rule is the owner's (post_01a11aef-38d6, thread
post_01a117e1): "we should never see waiting unless it's at the 5 worker max."

## Live evidence (read-only, 10:0xZ)

- Journal `~/.agent-viewer/executions/29c47118-0d68-4a6d-aee9-9b3d1a476a11/`: spawned 09:20:33Z,
  `phase.json` `running`, pid 34784 still alive. Its argv (`ps -o args=`) carries ONE hook:
  `PostToolUse` → `curl … http://127.0.0.1:49777/hooks/post-tool-use` (timeout 30). No
  `PostToolUseFailure`, no `Stop`: it was spawned by a backend built before 83fd4e1, and two later
  backends adopted it with the argv it was born with.
- The model ended its turn at 09:23:51 with a background Workflow (wf_1ba962bc-581, 27 agents). With no
  Stop hook, nothing calls the backend for the parent; only the sub-agents' PostToolUse hooks fire,
  each with `agent_id`. `steerNativeTool` → `sub` branch peeks and shows each owner post once PER
  sub-agent id, from an in-memory WeakMap. Result (lead's trace): 35 notices into sub-agents,
  re-delivered after the 09:40 restart, and none to the parent. The queued delivery stayed
  `conversation_busy`, so the thread read "waiting for the current turn" for 25+ minutes.

## The table

Owner? = can an owner message in a thread end up in this state. Label is what the thread shows today.

| # | Path (where it is decided) | Owner? | Label today | Fix / why unavoidable |
|---|---|---|---|---|
| 1 | `conversation_busy`, clause 1 (crate `WAITING_REASON_SQL`): the delivery's own conversation has a running run. The live turn in that thread | yes, the common case | "waiting for the current turn…" | Not a wait if the turn can be steered: the post is taken at the next boundary and the delivery fenced `consumed`. Label from the live turn's reach (rows 2–7), never generic. |
| 2 | Live turn whose process was spawned before a hook existed (hooks frozen in argv at spawn; adoption keeps argv) | yes: execution 29c47118 | "waiting for the current turn…" for 25+ min | Fix: ONE stable hook set (every delivery event, one URL, behaviour decided by the server per `hook_event_name`), recorded on the turn's grant so adoption knows it. Unavoidable for processes spawned before this change (their argv cannot change): typed `spawned_before_live_delivery`, label "started before live delivery; answers after this turn". |
| 3 | Sub-agent fan-out (`steerNativeTool` `sub`): each sub-agent id is shown each owner post | yes: 35 notices | (no label; the parent never learns) | Fix: a sub-agent is shown an owner post at most ONCE per turn, recorded durably on the run (`noticed_ord`), never per sub-agent id. The parent takes it at its own tool boundary, at a foreground sub-agent's return (that tool's PostToolUse), or in the Stop hold when idle. |
| 4 | Restart re-delivery: the sub-agent shown-set is in memory (`shownToSubAgents`) | yes | — | Fix: row 3's notice cursor is a crate column; a restart reads it. The parent's take was already durable (thread read mark + fence). Request-addressed messages (`offered`) stay at-least-once: settled `consumed` only after the response is written, so a crash between write and settle can repeat one; unavoidable without losing one, and documented in mcp.ts. |
| 5 | Model idle on background work, harness with the Stop hold (claude, stable hooks) | yes | "running background work…" | Already delivered at once by `holdStoppedTurn`. No change beyond the stable hook set. |
| 6 | Harness with no per-turn hook (gemini, cursor, muse, opencode: `buddy-tool-only`) | yes | "waiting for the current turn…" | Unavoidable (no verified hook). Label "<harness> can't take messages mid-turn; reads it at its next Buddy tool call or after this turn". |
| 7 | Codex model idle on background work (`waits-visibly`, no Stop hold probed) | yes | "waiting for the current turn…" | Unavoidable until probed. Codex reaches `next_step` like claude while it calls tools; the label says "at its next step", which is true whenever it acts again. Recorded as a known limit, not a fix. |
| 8 | A queued explicit model pick (`pick_queued`, crate `take_steering`, d70d0a8) | yes | "waiting for the current turn…" | Unavoidable by decision 3 (task_01a11a68): the pick needs its own turn on the picked model. Label "answers on the model you picked after this turn". |
| 9 | One long native step: a single Bash/tool call, or a foreground sub-agent (claude fires no parent hook until it returns) | yes | "waiting for the current turn…" | Unavoidable: no boundary inside one tool call. Label "reads it after its current step" (the sub-agent case also gets row 3's one notice). |
| 10 | Model writing its final answer with no further tool call; Stop with no background work returns at once and the turn settles | yes | "waiting for the current turn…" (seconds) | Unavoidable as designed (83fd4e1): the post runs as the next turn. Same `next_step` label; it is seconds. |
| 11 | `conversation_busy`, clause 2: a second seat (bound vs unbound mention) of the same Buddy in the same thread | yes | "waiting for the current turn…" | The running seat's take advances the Buddy's per-thread read mark, which fences this delivery too: label from the RUNNING seat's reach (rows 2–9). |
| 12 | Run `running` in the crate but no live turn in this backend: between claim and spawn (gate, briefing, seat open) or a dead holder until its 5-min lease expires | yes (after a crash/reboot) | "waiting for the current turn…" | Unavoidable in the window; label "answers once its current turn ends" (no reach to promise). Lease semantics unchanged (docs/patterns.md#lease-heartbeat). |
| 13 | `pool_full` (crate): `admission = 'capped'` and active ≥ max | NO: owner posts are `admission = 'owner'` (7344d4c) | "queued at the run limit (n/max)…" | Already true when shown. Worker/Buddy deliveries only. No change. |
| 14 | `not_before` (scheduled `ready_at`) | no (schedules, retries with delay) | "waiting for its scheduled time…" | Honest; no change. |
| 15 | `task_paused` | yes, posting in a paused Task's channel | "waiting for the Task to resume…" | Honest and owner-controlled; no change. |
| 16 | `buddy_archived` | yes, posting to an archived Buddy | "waiting while archived…" | Honest; no change. |
| 17 | Follow-up gate (runner.ts `followUpGate`) | yes, non-mention thread posts | "replying…" while the gate asks | Not a wait (the run is claimed). No change. |
| 18 | Owner DM chat queue (runtime TurnQueue; "Queued (n)" with Send now) | yes, by the owner's choice | "Queued (n)" | Owner-controlled queue with Send now (promote). Not a delivery; out of this label. No change. |
| 19 | Request-addressed messages (`to_worker`/`to_parent`, 4fcc0be) | no (Buddy to Buddy) | not shown in thread | No change; row 4 covers their dedupe. |

Rows changed by this task: 1–4, 6, 8, 9, 11, 12 (labels and delivery). Rows 13–19 already honest.

## Decision: who receives an owner post in a turn with sub-agents (criterion 2)

Choice: the parent conversation's own agent receives it (take, durable). Sub-agents get at most ONE
notice per owner post per turn, in total, durable, so a foreground sub-agent doing the work still
hears a correction (task_01a11a68 requirement "incl. while it waits on its own sub-agents").
Rejected: one notice per sub-agent (35x fan-out, today); no notice at all (regresses the foreground
sub-agent case, where claude fires no parent hook until the sub-agent returns).
