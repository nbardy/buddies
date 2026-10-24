<!-- Copied 2026-10-01 from /Users/nicholasbardy/git/wave_sim/agent_notes/2026-10-01_unleashd_case_study_conversation_busy.md (untracked in wave_sim; sha256 468fdecfb2a4077b…) at owner request in #channels-feature. Verbatim below. -->

# Case study for the unleashd team: replies shown as "blocked" behind a long owner chat

Date: 2026-10-01. Workspace: wave_sim (`project_88cdc98e-13d1-426a-9544-7e7830a2b5c6`).
Written by Wave_sim CEO (Buddy `buddy_17d87208-…`) for the unleashd maintainers.

## TL;DR

- One owner chat turn with the Wave Simulation Lead ran for **2 h 53 min** (09:43:16Z to 12:36:03Z). It was doing real, useful work and was not hung.
- During that turn, **9 `reply` runs** for the same conversation sat in `queued` with `waiting: conversation_busy`. The longest waited **2 h 44 min**.
- When the turn ended, all 9 settled within **~70 ms of each other**, each lasting 0–6 ms, with outcome `delivered to the DM; the sender reads it in its inbox`. None of them needed a model turn.
- The answers were readable in the DM and inbox the whole time. Only the runs table said they were blocked.
- The runs view nonetheless reported them as blocked, and I (the CEO Buddy) told the owner "9 messages are blocked behind a stuck chat". That was **wrong on both counts**: the chat wasn't stuck, and the answers weren't blocked from being read.
- The real defect: **mailbox-only reply runs are serialized behind a busy foreground conversation**, even though they never use the conversation. That produces a false "blocked" signal, holds `queued` rows for hours, and invites wrong diagnoses and interventions, such as cancelling an owner's productive turn.

## The exact thread

| Item | Value |
|---|---|
| Buddy | Wave Simulation Lead, `buddy_ed6ba302-8d87-47e7-b993-0071f7a73823` |
| Conversation | `95a0c348-6411-50c3-bfcd-e3e7296dbbb6` (owner chat, *foreground*) |
| Long turn | `run_01a0f6d8-c4cf-7676-b720-df756cfe9eaa`, input `chat:4ab6c3a4-ab15-4e19-8ed4-a7587aa821e9`; started 09:43:16.432Z, ended 12:36:03.699Z, status `complete`; lease 24 h (expires 2026-10-02T09:43:16Z) |
| What the turn did | Coordinated a Warp/PTX vs WebGPU dam-break comparison on a shared GPU: waited for other owners to hand back the GPU, sealed sources, ran one Modal attempt, fixed packaging, ran a second attempt, audited results (Warp ran 450 steps but failed 35/90 baseline comparisons; PTX failed before compilation). Result: `agent_notes/2026-10-01_clean_full_execution/RESULT.md` |
| Related task | `task_01a0ee9e-f079-728c-b4da-b0ece9fe0db4` (Iceblade backend rewrites — PTX/CCCL and Warp) |

During the turn the Lead sent requests to Product Lead and CEO from inside this owner chat. Each answer created a `reply` run whose `conversationId` is the origin chat `95a0c348…`.

### The queued reply runs (all on conversation `95a0c348…`)

| Run | Requester (answerer) | Ready (queued) at | Settled at | Wait |
|---|---|---|---|---|
| `run_01a0f6e0-6f6f-76b7-bb04-223c6c504c5a` | Product Lead | 09:51:38Z | 12:36:03.722Z | 2 h 44 m |
| `run_01a0f705-9f0d-72f6-8770-e12eb799dc22` | Product Lead | ~10:32Z | 12:36:03Z | ~2 h 04 m |
| `run_01a0f712-cc48-74ab-8f56-6d2a4e887ce8` | Product Lead | ~10:47Z | 12:36:03Z | ~1 h 49 m |
| `run_01a0f71a-1619-73a4-9c99-a87e35cb9860` | Product Lead | ~10:55Z | 12:36:03Z | ~1 h 41 m |
| `run_01a0f71b-1ee1-74e5-9976-226ce99b812e` | CEO | ~10:56Z | 12:36:03Z | ~1 h 40 m |
| `run_01a0f746-c463-77dc-908a-764175424758` | Product Lead | ~11:43Z | 12:36:03.780Z | ~53 m |
| `run_01a0f74c-a591-7183-abcd-58d8a85f6b91` | CEO | 11:49:50Z | 12:36:03.780Z | 46 m |
| `run_01a0f750-01b4-7001-9919-450f24512035` | Product Lead | ~11:53Z | 12:36:03.781Z | ~43 m |
| `run_01a0f767-a30f-768f-9ed2-6f1ecbf83df9` | Product Lead | ~12:19Z | 12:36:03.781Z | ~17 m |

(`~` times are from run-id timestamps; exact `readyAt` was read for the first and seventh rows.)

Every one settled with:

```
status: complete
outcome: "delivered to the DM; the sender reads it in its inbox"
startedAt == endedAt (± 6 ms)
```

A tenth reply, `run_01a0f770-47f8-712c-952b-9ab70c333da2`, arrived while the turn was still running and settled in the same burst.

## Why it happened (code)

1. **The claim rule is per conversation.** `crates/unleashd-buddies/src/runs.rs`, `WAITING_REASON_SQL`:

   ```sql
   WHEN r.conversation_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM run c WHERE c.conversation_id = r.conversation_id
         AND c.status IN ('running','cancel_requested')
   ) THEN json_object('kind','conversation_busy')
   ```

   This is evaluated **before** the runner decides what kind of job the run is.

2. **A reply's job kind is chosen only after the run is claimed.** `server/src/buddies/runner.ts`, `returnJob`:

   ```ts
   /** A return (answer or failure) goes back to the conversation the request was sent from. */
   case 'foreground':
     return { kind: 'mailbox', note: 'delivered to the DM; the sender reads it in its inbox' };
   case 'background':
     return { kind: 'turn', conversationId: origin!, open: false, prompt, after: nothingAfter };
   ```

   For a **foreground** (human) origin, the job is a mailbox no-op. It never touches the conversation, but it was still queued as `conversation_busy` behind the human turn.

3. **The lease is 24 h.** The long turn could have held the conversation's queue until 2026-10-02T09:43Z if it had hung. In this case it finished. Nothing in `runs list` or `runs get` showed whether the turn was alive: there was no last-activity time, step count or heartbeat.

So the one-writer-per-conversation rule is right for `turn` jobs, but it is applied to `mailbox` jobs that don't write to the conversation at all.

## What got in our way

1. **A false "blocked" signal.** `runs list` showed 9 replies `queued / conversation_busy` for up to 2 h 44 m. Anyone reading it, human or Buddy, concludes that coordination is stalled.
2. **No liveness information on a running turn.** `runs get` on the long turn returned only `status: running`, `startedAt` and `leaseExpiresAt`. I could not tell "working" from "hung", so I told the owner it was "stuck" and offered to cancel it. Cancelling would have killed a productive owner turn mid-GPU-run, which costs paid GPU time and leaves a lease and cleanup to unwind.
3. **Reply runs carry no visible type.** Nothing in the row says "this run is a mailbox delivery that needs no turn", so the reader can't tell it's harmless.
4. **Answers aren't pushed into the running foreground turn.** The Lead's turn never saw those 9 answers unless it polled its inbox. The mailbox design means "the human reads them"; the Buddy driving that chat does not get them automatically.
5. **Owner confusion about the model.** The owner reasonably read "blocked" as Slack-thread semantics: "if someone is replying, can't the next reply?" They had seen two "replying" indicators at once, which is correct, since parallelism is per conversation. The UI and terms don't make the per-conversation unit visible.

## Suggested fixes

In order of value per effort:

1. **Don't apply `conversation_busy` to mailbox-only returns.** Either decide `foreground` vs `background` at enqueue time and settle foreground replies immediately, or exclude reply and failure-return runs from the busy check when the origin is foreground. Expected effect: zero queued rows for these, and no false "blocked" signal.
2. **Liveness on running turns.** Add `lastActivityAt`, and ideally a step or tool-call count, to `runs get` and `runs list`. Flag turns with no activity for N minutes (e.g. 30) as `quiet`, and say so in the waiting reason of anything queued behind them.
3. **Show the job kind.** Include `deliver: mailbox | turn` (or similar) on reply and failure-return rows, so a reader knows it needs no model time.
4. **Optional: let a running foreground turn see new answers.** Inject a "new answer in your inbox" notice into the running turn's next tool result, or surface a count in the chat header.
5. **Optional: reconsider the 24 h lease for chat turns.** Keep it if long owner turns are legitimate (this one was), but pair it with item 2 so a long turn is visibly alive.

## Other friction seen the same day (for context, lower priority)

- **Host restart window.** Runs started around 20:03Z on 09-30 were marked `interrupted: the host restarted during this run` at 05:38:51Z on 10-01. They sat about 9.5 h in `running` before being recovered as failed. Examples: `run_01a0f3ea-7cb6-…`, `run_01a0f3ea-0663-…`, `run_01a0f3e8-2bfe-…`.
- **Provider capacity failures surfaced as run failures.** `execution_failed: Selected model is at capacity. Please try a different model.` (e.g. `run_01a0f2e6-6d09-…`, `run_01a0f2b8-fd6e-…`). There's no automatic model fallback or retry hint.
- **Network drop mid-run.** `execution_failed: Reconnecting... waiting for network (Connection failed: error sending request)` (`run_01a0f34a-8784-…`).
- **A run kept showing `running` after its work had landed.** The M9 pool-A run (`run_01a0f33c-e487-…`) still showed `running` after its result commit `52ec899f` was on the branch. This is the same liveness gap as item 2: you can't tell "finishing up" from "stuck".
- **Large outputs from MCP list/get calls.** `inbox` (≈56 k chars) and `tasks get` on the beta tracker (≈146 k chars, mostly comments) overflowed the tool-result limit and had to be parsed from spill files. Paging comments, or a `slim` option on `tasks get`, would help.

## What I got wrong, so it isn't repeated

- I read `queued / conversation_busy` as "messages can't be delivered" and the long turn as "hung". Both were wrong. Correct reading: **for a foreground origin, a queued reply is already readable in the DM/inbox; the queued row is bookkeeping.** A long `running` owner turn should be checked for activity before anyone calls it stuck.
