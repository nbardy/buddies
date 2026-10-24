# Worker continuity across backend restarts

Owner report: #case-studies, post_01a0f2bc-03b8-772d-b42b-ea7b6c73daaf.
Inspected baseline: 7859e70. Tracked tree was clean before and after focused tests.
This is source/history evidence, not confirmation of the 22:09:34 incident's initiating signal.

## Findings

- `server/src/turns/runner.ts` still passes `detached: true` for conversation turns.
- `vendor/agent-cli-tool/src/process-runner.ts` still connects provider stdout/stderr to parent-owned pipes. `execute.ts` deliberately signals the detached process group when stopped.
- `server/src/lifecycle/shutdown.ts` waits for an idle boundary on source reload, but SIGINT/SIGTERM and loss of the supervisor IPC channel stop active turns with `server_restart`.
- `server/src/buddies/runner.ts` calls `core.recoverRuns()` on startup. `crates/unleashd-buddies/src/runs.rs::recover_runs` unconditionally terminalises all running/cancel_requested runs. It does not establish whether a detached provider remains alive.
- `server/src/buddies/mcp.ts::startMcpEndpoint` binds an OS-assigned loopback port inside the backend. `grants.ts::createGrants` keeps turn credentials in a process-local Map. A surviving CLI alone would therefore lose Buddy tool access when this backend exits.

The detached flag supplies process isolation; it does not implement independent execution ownership, output transport, tool access or continuation after backend replacement. Merely removing shutdown's stop call or the recovery sweep would risk surviving untracked execution, stalled pipes, lost tools and duplicate writers.

## What happened to the design

`agent_notes/2026-08-21_turn-lifecycle-design.md` explicitly says the daemon proposal was reversed after review. Its implemented alternative deferred source reloads until idle. Commit d3ea123 records design documents, not an implementation of independent execution.

`agent_notes/2026-08-24_automation-execution-ownership-design.md` records an accepted single-backend owner and explicit interruption on replacement. Its alternative B defers detached execution with durable events and a stable owner; it calls that the correct architecture if crash-transparent execution becomes required.

The owner's current requirement supersedes treating interruption as acceptable for web-server replacement. The existing Task buddy_project_33bb3d10-9da0-4db3-84fe-7f9143ff5592 already calls for real active-run continuation. Its display-history work did not meet that criterion.

## Verification and remaining incident questions

`pnpm exec tsx --test server/test/shutdown.test.ts`: 9 passed. This confirms the current deferral/shutdown policy, including a real detached child finishing BEFORE backend exit. It does not prove active execution survives replacement. No source fix made; no live restart performed.

UI Engineer is already investigating the incident. Need the actual old/new backend boot identities, supervisor/replacement/crash logs and affected run/session ids. The reported "already has an active writer" cause remains unverified; no claim that every process died or every unfinished tool result persisted.

## Runtime handoff and acceptance boundary

Reuse the existing Task and canonical conversation/run authorities. Move ownership of active execution, output consumption, deadlines/cancellation and the scoped Buddy MCP endpoint/grants out of the replaceable web backend together. Keep one writer and one settlement path; do not create a competing recovery executor. Reuse existing ingest for readable history, but do not treat history hydration as proof of live ownership.

The acceptance test must start an active fake provider on isolated temporary stores, replace the web backend while it is executing, and verify: the same execution continues; output before/during/after replacement remains ordered; a Buddy tool write succeeds after reconnection with unchanged scoped authority; no second writer or replacement attempt starts; exactly one completion and correlated return occur; explicit Stop still cancels and revokes tools; a real execution-owner death remains distinguishable. Cover conversation and Buddy-worker paths. Use no live agents or owner stores for destructive restart testing.

Deliver a scoped implementation design naming what existing code moves/replaces and internal protocol/schema impact before adding public MCP/API/data-model concepts. The owner has explicitly requested restart-independent execution; do not ask again whether that outcome is wanted.
