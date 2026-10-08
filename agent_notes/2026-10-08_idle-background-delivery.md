# 2026-10-08: Owner posts reach a Buddy whose model is idle on background work (task_01a11aa8)

Status: implemented by the worker on fix/idle-background-delivery (Opus worker, started by request
post_01a11aa8-34af from Buddies Development Lead). The fix line is covered by the owner's 07:31Z
approval (post_01a11a6c-8660) to fix the root issues, commit, and push. The mechanism and schema below
are engineering choices made in this run, not owner decisions.

## Question

Game Designer's model ended its turn at 07:09:56 after launching a background Workflow. `claude -p`
then lived 29.5 min with zero tool calls, and the owner's 07:14 and 07:20 posts queued behind
"replying…" (agent_notes/2026-10-08_game-designer-art-lead-trace-findings.md). Any-tool steering
(task_01a11a68) cannot fire without a tool call. The questions: how can a live process take a new
user message in that state, and what is the runtime state called?

## Probes (claude 2.1.294, Haiku, tmp dir, `-p --verbose --output-format stream-json`)

Stream excerpts are in `2026-10-08_idle-background-delivery/probe-stream-excerpts.jsonl`. The
sources were /tmp/idlebg-probe/out.jsonl (sha256 d88f8ac0…f794418) and out3.jsonl (sha256
dfdb2c0d…ff534c35); the init lines were dropped.

1. Background `sleep 45`, then the model ends its turn. A Stop hook fired at once (16:39:38) and
   held 15 s, then exited 2 with "While you were working, the owner posted…". The model answered
   PINEAPPLE in the same process while the job ran. The job's `task_notification` arrived later,
   and the model handled it as a new turn ("bg finished"), still in the same process.
2. Background `sleep 10`, with the Stop hook holding 40 s. `task_notification` streamed at
   16:41:02, DURING the hold. The turn's `result` line appeared only when the hook returned
   (16:41:33). So the stream cannot show "model idle", and the Stop hook call is the signal.
3. The Stop hook input carries `background_tasks: [{id, type, status, …}]`, and `id` equals the
   stream's `task_id` (`b000hi5uq`).
4. Binary strings: `asyncRewake` hooks are backgrounded only when interactive or when there is
   streaming input. Under `-p` they run as ordinary blocking hooks. `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`
   defaults to 8 consecutive blocks.

## Choice

A blocking claude Stop hook (`curl` to the Buddy endpoint's `/hooks/stop`, using the turn's MCP
bearer, the same as the post-tool hook) plus an in-memory `TurnActivity = working | background`
(`server/src/turns/background-work.ts`).
- No background tasks: return at once, and nothing changes.
- Background tasks running: hold. On the first owner post in the thread, take the unread page
  (marked read, delivery fenced `consumed`) and answer
  `{decision: "block", reason: "While you were working…"}`. When the stream's `task.finished`
  events cover every reported task, release with no decision.
- The status line maps `background` to "running background work…".

## Alternatives rejected

- `--input-format stream-json` with a live stdin: agent-cli journals executions with stdin from a
  FILE and rejects stdin pipes ("a journaled execution cannot"). Turns survive backend exits only
  because of that.
- `asyncRewake` hooks: per probe 4, they never background under `-p`.
- Kill the process, then `--resume` with the post: this is a second process, and it would kill
  the background job. The owner requires workers to keep running.
- Releasing the hold on a timer: claude would then wait for its jobs without a hook again, and the
  post would be stuck once more.

## Per-harness capability

| harness | idle delivery | basis |
|---|---|---|
| claude | stop-hook-hold | real CLI proof below; probes 1–3 |
| codex | waits-visibly | not probed here: no Stop hold is wired, so a post waits as a queued delivery |
| gemini, opencode, cursor, muse | waits-visibly | no verified hook; a post waits as a queued delivery |

## Evidence

- Regression, failing first: `server/test/idle-background-delivery.test.ts` "an owner post
  reaches a Buddy whose model is idle while its background job runs" (real backend, temp stores,
  fake `claude -p`). On the steer tip 8834dbe without this change it failed twice. The status was
  `"state":"replying"`, and with that check removed it "timed out: the post to reach the model".
- One real CLI run: `buddies-v2` "real CLI claude: an owner post reaches a model idle on its
  background job" (`UNLEASHD_REAL_IDLE_BACKGROUND=1`, Sonnet, temp stores) passed in 37 s. The
  thread posts were launched, then 3x3x3 while the job ran, then job finished. There was one
  process (`turns.length === 1`), and the delivery was `consumed`. Transcript:
  `2026-10-08_idle-background-delivery/claude-idle-background.txt`.

## Known limits (revisit if they bite)

- A backend exit during a hold: the relay resends only within 55 s of the request, so the hook
  fails open. Claude ends its turn and waits on its jobs as before, and the post runs after the
  process exits. Revisit if restarts mid-hold become common (the hook could retry against the
  stable relay port).
- More than 8 consecutive owner deliveries in one background wait hit claude's block cap, and claude
  then ends the turn. Revisit by setting `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` in the spawn env.
- Codex is typed `waits-visibly` without a real-CLI probe of its background behaviour.
- The 60-minute provider-idle watchdog (fee9b12) still ends a silent background turn. A
  background Bash with no stream output for 60 min is killed, just as before this change.
