# Product Lead worker fan-out — Unleashd handoff

Owner: Unleashd runtime/team. Reporter: wave_sim Product Lead. Date: 2026-10-01 UTC.

Owner request: trace the Product Lead badge of six, five, then four workers through conversations and code; explain unnecessary concurrent question handling. This is a diagnostic handoff, not authorization to change dispatch contracts, profiles, schedules or production. No workers were started by this audit.

## Finding

There was real redundant execution: three parallel Simulation conversations asked Product Lead essentially the same GPU-custody question within 36.694 seconds. Each distinct DM request became a fresh Product conversation, and all three ran concurrently. A separate recovery packet used a supervisor plus a native subagent. Those are multiple model sessions for substantially fewer independent deliverables.

The current badge discrepancy is not established as a stale-state bug. At **07:11:21 UTC**, the read-only server snapshot contained 348 Product-scoped historical conversation/descendant rows, only two non-idle: this foreground audit and one background recovery executor, both with no native subagents. A subsequent MCP run listing also showed only those two live runs. Thus that snapshot establishes **one background Product executor**, not four. The exact earlier screenshot-time client state was not retained; do not claim an exact decomposition of that badge.

## Incident trace

Product Buddy: `buddy_2c54cc18-b51e-4976-bf02-cebd113e17f3`; workspace: `project_88cdc98e-13d1-426a-9544-7e7830a2b5c6`.

| Request / originating conversation | Product recipient run, UTC | Work |
| --- | --- | --- |
| `post_01a0f637-7395-7211-ab0d-5cff2a30e48c`; origin `buddy-run-run_01a0f636-66f1-73f5-aff9-91c63ab3468a` | `run_01a0f637-7397-70c5-bb42-3b8d42b0c9ba`; 06:47:04.346–06:48:36.894 | M5 asks current GPU owner, M2 executor and order |
| `post_01a0f637-f321-7367-be7c-6d6370dad08e`; origin `95a0c348-6411-50c3-bfcd-e3e7296dbbb6` | `run_01a0f637-f322-7014-8f87-54fd5cda09aa`; 06:47:36.998–06:48:56.176 | Warp/PTX asks equivalent current owner and handback order |
| `post_01a0f638-02eb-727e-8875-58d0ef333d85`; origin `buddy-run-run_01a0f636-6715-7650-ad81-540b7a9e1954` | `run_01a0f638-02eb-727f-91c6-f3da37a6539c`; 06:47:41.040–06:49:10.530 | M1 asks reservation/order after M2/M5 |

These are three origin contexts of the same Simulation Buddy, not a replay of one post. All produced equivalent Product-retains → M2 → M5 → M1 custody decisions. None implemented a feature. Their answers are respectively `post_01a0f638-baf2-752d-aa6e-dda8e910d52f`, `post_01a0f639-13fc-73ed-9722-1598643a21ee`, and `post_01a0f639-0602-7234-9e2f-04bd01fdda41`.

The recovery parent `run_01a0f629-c13e-7636-887c-087b69cfea59` ran 06:32:06.720–07:04:53.088. Its disk session `01a0f629-c255-76a3-89a0-d6d177a21e15` invoked `spawn_agent` at 06:33:05.647, creating recovery child session `01a0f62a-a77a-7951-8d22-a102032fae4d`. Recorded models were gpt-6.1-sol and gpt-6-sol respectively. This was one implementation packet represented by two sessions. The child did not recursively delegate.

One already-consumed answer also left a queued continuation: `run_01a0f62f-c579-77b8-a1c3-4f8518f19d73`. The answer `post_01a0f62f-c576-70d2-b4e8-af6efed38ea2` had already been acknowledged in the active parent's 06:39:42.347 task-comment tool call. The earlier audit cancelled that queued continuation at 06:56:48.450; it did not cancel the repair. This is a concrete example of a queued return becoming unnecessary while the originating turn remains active.

The current background executor is `run_01a0f649-2686-7278-9a3b-329662fb0218`, started 07:06:24.270 from CEO request `post_01a0f649-2684-7347-aba4-0383944a03ad`, on release task `todo_2682c0e9-98c2-47a9-82e0-759574cb9dff`. It owns the bounded HTTP recovery-test timeout repair and server-suite check; the request explicitly says execute directly as one worker, $0, 30 minutes, one retry, no push/deploy. Its inspected disk session had no `spawn_agent`. This audit did not dispatch a second executor.

## Code path and why concurrency happens

Inspected checkout began at `7e9d75b5f59268b39d902c5e737ede7637a881c3`; it advanced externally to `829014877f9d27f5bc0e666ff747e4f2ad75b1eb` during the audit. The seven load-bearing dispatch/projection files below matched committed HEAD bytes when checked. This is checkout evidence, not an attestation of the running server build.

1. A new request enqueues one recipient run with `conversation_id: None` in [posts.rs](/Users/nicholasbardy/git/unleashd/crates/unleashd-buddies/src/posts.rs:694). Input identity is `post:<postId>` or `reply:<postId>` in [types.rs](/Users/nicholasbardy/git/unleashd/crates/unleashd-buddies/src/types.rs:163). [runs.rs](/Users/nicholasbardy/git/unleashd/crates/unleashd-buddies/src/runs.rs:104) deduplicates by that identity, not question, resource or task. Distinct requests correctly pass this idempotency check.
2. The claim guard checks an explicit conversation slot and the Buddy's active-run cap in [runs.rs](/Users/nicholasbardy/git/unleashd/crates/unleashd-buddies/src/runs.rs:38). A request with no conversation has no shared seat to serialize it. Task gating checks pause state, not one executor per task. Product's inspected profile allows five active runs; [schema.rs](/Users/nicholasbardy/git/unleashd/crates/unleashd-buddies/src/schema.rs:43) also defaults to five.
3. [runner.ts](/Users/nicholasbardy/git/unleashd/server/src/buddies/runner.ts:112) drains and executes each claim concurrently. Wake notifications are coalesced, but their queued requests are not. [requestJob](/Users/nicholasbardy/git/unleashd/server/src/buddies/runner.ts:191) always uses a fresh `buddy-run-<runId>` conversation and a full model turn. This explains the observed three parallel question-answer sessions without a scheduler or retry bug.
4. An answer enqueues a return run in [posts.rs](/Users/nicholasbardy/git/unleashd/crates/unleashd-buddies/src/posts.rs:741). [returnJob/replyJob](/Users/nicholasbardy/git/unleashd/server/src/buddies/runner.ts:211) makes foreground origins mailbox-only, resumes background origins, or creates a fresh turn when the origin is absent. It checks answered state but has no explicit already-consumed-answer check. Therefore a request can involve a recipient turn and a later sender turn. This audit does not claim all three observed answers actually launched an additional sender turn.

The former per-Buddy background hold was deliberately removed because it silently parked delivered requests; see [runs.rs](/Users/nicholasbardy/git/unleashd/crates/unleashd-buddies/src/runs.rs:168). Restoring a blanket hold or globally serializing every task would reintroduce that failure. Keep owner foreground chats available and independent deliverables runnable.

## Other amplification paths; not the cause of those three DM requests

The MCP description says “A DM request starts its recipient; inform wakes nobody.” [mcp.ts](/Users/nicholasbardy/git/unleashd/server/src/buddies/mcp.ts:257). That second clause is too broad:

- Buddy-authored DM informs are inert. Plain **owner** posts in DMs wake members through thread seats; requests/answers are skipped there because core dispatch already owns them. [channels.ts](/Users/nicholasbardy/git/unleashd/server/src/buddies/channels.ts:684).
- Public and task posts can wake mentions and evaluate other thread participants for follow-up regardless of inform kind. [channels.ts](/Users/nicholasbardy/git/unleashd/server/src/buddies/channels.ts:704). A thread seat and hop/read-through bounds exist; this is not unrestricted recursive spawning.
- Follow-up eligibility can itself run an ephemeral provider session using the participant's selected model/effort, even when its answer is “no”; a “yes” then permits a full reply turn. [channels.ts](/Users/nicholasbardy/git/unleashd/server/src/buddies/channels.ts:525), [channel-reply-gate.ts](/Users/nicholasbardy/git/unleashd/server/src/buddies/channel-reply-gate.ts:117). That gate is not queued through the same Buddy run claim path. Its visibility/accounting needs investigation; no gate cost was measured here.

Product's schedule listing was empty. No evidence identifies cron as the incident source. Exact-key post replay does not emit another created-post event in [mcp.ts](/Users/nicholasbardy/git/unleashd/server/src/buddies/mcp.ts:316); the observed different-ID requests are not proof of duplicate transport delivery.

## What the badge actually counts

[buddy-background.ts](/Users/nicholasbardy/git/unleashd/client/src/atoms/buddy-background.ts:84) combines background Buddy conversation rows and native child agents, with child-row deduplication. [buddyWorkerCountsFamily](/Users/nicholasbardy/git/unleashd/client/src/atoms/buddy-background.ts:228) counts **running or queued entries**, not independent tasks or deliverables. Native children can add entries beyond the core Buddy-run cap. Foreground root chats are excluded from this background count.

The projection also merges cached details, per-conversation state and server rows. Before alleging a stale-badge defect, capture the same-time scoped rows, details/subagent statuses, projected entries and visible badge. Existing tests already cover child deduplication and some completed-parent inference in [buddy-background-tasks.test.tsx](/Users/nicholasbardy/git/unleashd/client/test/buddy-background-tasks.test.tsx:75).

## Proposed smallest follow-up, for team review

First correct the MCP wording and worker presentation so users can distinguish queued requests, coordination turns, execution parents, native children and ephemeral follow-up checks. Each entry should expose why it started and its request/task/origin. A count should not imply four independent product features.

Then reproduce the three-request incident in the existing core/runner tests. Consider batching or serializing pending requests **on an explicit correspondence/thread seat**, delivering all request IDs to one turn with an individual answer for each. These incident requests originated in different conversations, so same-thread reuse alone would not merge them; use the existing shared custody thread/record operationally, or propose an explicit shared key if the owner wants cross-thread batching. Do not infer semantic duplicates globally or discard a legitimate unanswered request.

Add a narrowly defined consumed-answer/read-through fence for queued return delivery. A reply already acknowledged by its originating execution should settle as mailbox/consumed, while an unread answer must still resume that execution. Use the channel-seat read-through behavior and tests as a reference; avoid a new scheduler abstraction. Contract/API/schema expansion needs owner review under [CORE_DESIGN.md](/Users/nicholasbardy/git/unleashd/product/buddies/CORE_DESIGN.md:151).

Acceptance checks for any eventual fix:

1. A reproduction of these three requests has a documented execution count and answers every distinct request exactly once; an unrelated packet still runs independently.
2. Exact-key retries remain idempotent; owner foreground chats never receive automated continuation input; unanswered background returns still progress.
3. An already-consumed queued return starts zero additional model turns, including when the original turn is still running.
4. The badge matches same-time projected entries after parent/child completion and reconnect; queue state and gate work are explicit rather than hidden as independent executors.
5. Channel tests retain owner-DM reply wakes, Buddy-DM inform inertness, mention handling and bounded follow-ups. Verify model-gate accounting separately from full-turn counts.

Suggested starting tests: [server/test/buddies-v2.test.ts](/Users/nicholasbardy/git/unleashd/server/test/buddies-v2.test.ts:392) (request/answer/return), its channel follow-up/read-through cases, and the client projection tests above. No tests were launched in this diagnostic audit. No billing or token totals are claimed.

## Evidence and boundaries

The earlier operational audit is [wave_sim worker audit](/Users/nicholasbardy/git/wave_sim/agent_notes/2026-10-01_product_worker_audit/README.md). Its ignored evidence directory contains:

- [Server snapshot](/Users/nicholasbardy/git/wave_sim/agent_notes/2026-10-01_product_worker_audit/output/live-product-conversation-snapshot.json): timestamped read-only WebSocket hello and GET conversation details, no application commands.
- [Disk trace](/Users/nicholasbardy/git/wave_sim/agent_notes/2026-10-01_product_worker_audit/output/disk-transcript-trace.json): six mapped Codex JSONL paths, point-in-time hashes, session models and spawn metadata. The then-running executor's transcript continues to change.

The audit used MCP, the owning read-only HTTP/WebSocket API, repository source and related Codex transcript files. It did not open live SQLite stores, decrypt protected transcript bodies, bypass a denied DM, modify another worker's files, or change runtime settings. Existing unrelated dirty files were preserved. Only this handoff was added in Unleashd; no source fix or production action was performed.

## Follow-up: visible status discrepancy confirmed, 07:25–07:27 UTC

The owner still saw four entries after the first report. Inspection of the **existing user browser tab**, without refreshing it, now showed Product Lead **3 running / 0 queued**. Its three running links were:

| Visible entry | Fresh server/core evidence |
| --- | --- |
| `buddy-run-run_01a0f649-2686-7278-9a3b-329662fb0218` | Current HTTP recovery repair; MCP running; latest host attempt running; fresh row streaming |
| `01a0f60a-8c98-7ed3-9f2e-bcfcdfff4f0d` | Native child of `buddy-run-run_01a0f609-e4a4-775e-9b5f-22258eb1ca3b`; parent MCP complete and host attempt succeeded at 06:01:02.835; child fresh row idle |
| `01a0f604-b24d-7982-a231-708402e9c74d` | Native child of `buddy-run-run_01a0f604-1cd7-7179-81a7-022e0889aff8`; parent MCP complete and host attempt succeeded at 05:56:27.817; child fresh row idle |

The workers view simultaneously listed completed parent entries for the same two old requests. Child GET details had no latest host attempt and no subagents. At 07:26:57.481, a new read-only protocol4 hello contained both child rows with **run omitted**, which decodes to idle under [the wire schema](/Users/nicholasbardy/git/unleashd/shared/src/conversation.ts:272). Thus the visible client reports two old sessions running while a fresh server snapshot reports neither running. This establishes a live client/server status discrepancy; it does not establish its exact invalidation cause, a billing count, or OS process ownership.

Evidence: [selected fresh rows](/Users/nicholasbardy/git/wave_sim/agent_notes/2026-10-01_product_worker_audit/output/ui-count-server-hello.json) and [five GET details](/Users/nicholasbardy/git/wave_sim/agent_notes/2026-10-01_product_worker_audit/output/ui-count-discrepancy-details.json). The browser AX tree and link inspection identified the displayed IDs. No reload was used to conceal or clear the discrepancy. No sessions were cancelled in this follow-up.

**Priority correction:** investigate terminal parent/native-child row publication and already-connected client reconciliation before changing the active-run cap. Existing client projection lets a running child row override completed-parent inference; compare [buddy-background.ts:110](/Users/nicholasbardy/git/unleashd/client/src/atoms/buddy-background.ts:110), [handleRows](/Users/nicholasbardy/git/unleashd/client/src/atoms/actions.ts:405), and the server row publication path. Reproduce with a connected client: start parent/child, finish both, keep the page open, and compare its entries against a fresh hello. It should settle from three to one here without a page reload. Preserve legitimate detached children that actually continue after a parent ends; do not blanket-hide them.

The recommendation now separates **two software concerns** (this status discrepancy; unnecessary fresh/return coordination turns) from **one working-instruction concern** (routine delegation being interpreted as a supervisor plus child for a tiny packet). Refine the latter to one direct executor per small packet and one shared custody record, reserving requests for genuinely unanswered decisions or a new action. A broad identity/soul rewrite cannot repair stale runtime state. These are proposed changes, not changes applied by this audit.
