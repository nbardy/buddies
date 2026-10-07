# Live thread steering, 2026-10-08

Owner request: restore graceful messages during a live thread reply and investigate conversation_busy.

This patch addresses a same-thread claim race and restores steering at the Buddy MCP boundary.
The claim gate serializes deliveries for a Buddy/thread whether bound or unbound. Previously a
subscribed delivery could claim while an unbound delivery was opening the same seat, failing bind.
Each successful Buddy tool response now appends unread posts from its active request/delivery
thread with instructions to adjust without dropping current work. catchUpThread owns the read
mark and consumes queued deliveries. No second turn or provider process is spawned. Owner chats
and reviewer turns are excluded; queued explicit model picks wait for a new turn.

Live evidence: the Product Development Lead progress-post result returned a second MCP text
block containing the owner's collaboration message and Buddies Development Lead's diagnosis.
This proves receipt in the actual Codex turn at a Buddy tool boundary. Non-Buddy tools and
provider-only thinking do not have this response hook; durable delivery remains queued.

Buddies Development Lead found the reported three failures have an additional cross-thread
cause: a launch-thread seat reused a conversation running in a Task thread. This patch does not
claim to repair that placement failure. They own that continuation under
 task_01a117e5-1391-7690-955f-fae9527cc872 and were sent the existing patch in the owner's thread.

Validation:
- pnpm typecheck: pass, including the Buddies line ceiling (11136/11136).
- Rust Buddies suite: 81 tests pass (9 unit, 62 core, 2 migration, 1 query plan, 7 search).
- Focused HTTP MCP integration: live steering and model-picker tests both pass.
- First full Buddy suite: 69 pass, one model-picker timeout; isolated rerun passes.
  Full rerun: 70/70 pass, zero failed/cancelled/skipped. Log: /tmp/unleashd-live-steering-tests-rerun.log.
- No live SQLite opens; every fixture uses temporary stores.

Token audit: pnpm token-audit --tag channel returned 0 sessions/requests, so no production
before/after savings claim is supported. The regression proves one burst creates no second turn.
