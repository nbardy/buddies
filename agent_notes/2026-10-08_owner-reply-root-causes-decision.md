# 2026-10-08 — Owner replies stuck "queued at the run limit": three root causes, three fixes

Status: ACCEPTED by owner, 2026-10-08T07:31:22Z. The owner said "fix the root issues, refactor
systems/software as needed, fix and commit all and push" (post_01a11a6c-8660, #bugfixes thread
post_01a117e1-1b0e-72e6-bef4-52b764bac275). The lead (Buddies Development Lead) proposed the
breakdown below, and reads the owner's message as approving all three, including the push.

## Evidence
- Live symptoms: Game Designer (3×3×3 correction) and Art Lead replies queued for an hour or more. The owner
  reproduced it in the #bugfixes thread itself, when lead replies showed "queued at the run limit"
  (screenshot in post_01a11a68-ebcd).
- The label is generic: server/src/buddies/channels.ts:297 maps not-running → 'queued', and
  client channel-data.ts:657 renders every queued row as "at the run limit" (lead read, 07:27Z).
- Steering (aa19d5a) fires only when a Buddy MCP tool call completes (Product Development Lead's statement, post_01a11a67-c24f).
- Run cap is per Buddy (default 5), shared by owner replies and workers, oldest first
  (claim_run_at ORDER BY ready_at). dc299ec (2026-10-08 01:52) removed the 60-min background
  limit, at the owner's request.
- run_01a1185c (codex) hung 6.5 h, 2026-10-07 21:54Z → 2026-10-08 04:25Z.

## Decisions
1. Owner messages steer a running turn after ANY tool use, and the label names the real reason.
   Task task_01a11a68 (Opus).
2. Owner-first admission: a run triggered by an owner post bypasses the per-Buddy cap, and waits
   only for its conversation. Task task_01a11a6d (Sonnet).
   - Alternatives: reserve a slot for the owner, or bring back a worker-only time limit.
     The owner was offered both in post_01a11a67-d4f3 and did not pick either.
   - Cost: a Buddy can briefly exceed its cap while it answers the owner.
   - Product Development Lead's caveat (post_01a11a68-8eb2): this does not steer a busy
     conversation. That is decision 1's job; the two decisions complement each other.
3. Hung-turn liveness: no harness progress for N minutes ends the turn with its own error code.
   No wall-clock cap comes back (the dc299ec decision stands). Task task_01a119c4 (Opus).
   This replaces that Task's earlier "no behavior change without approval" clause.

## Revisit if
- Owner-first admission lets a Buddy flood the host. If so, cap it at cap+1.
- No reliable progress signal exists for some harness (e.g. a silent sub-agent wait). If so,
  that harness needs a typed exemption, decided by the owner.

---
## Successor, 2026-10-08 08:39Z: "Complete all the work"

Owner, post_01a11aa9-1bad, 08:37:32Z (thread post_01a117e1). The lead's reading of it:
- **Parent↔worker messaging (task_01a11a97): authorized to build.** The design is the reviewed
  one (live-delivery-review README, sha256 3cdd629b…). The owner proposed the capability
  ("message worker" / "message parent", 07:40Z) but has not reviewed the exact schema. Opus worker.
- **Restart orphan diagnosis (task_01a11aa9): authorized.** The lead offered it as item 4 of
  post_01a11aa8-6f3c, saying "unless you'd rather skip". Opus worker.
- **Idle-background delivery (task_01a11aa8), already running:** this confirms it.
- **Fan-out quota guard: NOT built.** It was asked as an explicit yes/no (item 3), and "complete
  all the work" does not answer it. A guard would restrict Buddies, which cuts against the
  owner's 06:55Z "many sonnet sub agents… more variety". It stays an open question.
- The trace review (task_01a11aa2) is closed, with its evidence in
  2026-10-08_game-designer-art-lead-trace-findings.md.
