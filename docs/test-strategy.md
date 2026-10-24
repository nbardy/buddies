# Test Strategy: Useful vs Overkill

(Moved out of AGENTS.md to keep startup context small.)

For Buddy memory reviewer prompt/tool changes, use the
[memory curation benchmark runbook](../server/test/fixtures/memory-curation/README.md).
It separates live semantic evaluation from deterministic boundary tests and links
the fixed cases, historical scores, prompt snapshots and preserved traces.

## Test Strategy: Useful vs Overkill

### Keep features lean

- Prefer one integration test through the real boundary over many tests of
  helpers, mocks, source text, CSS strings, or component structure.
- Never read TSX/CSS source in a test to assert labels, ordering, class names,
  or implementation details. Exercise the rendered/API behavior or omit the
  test.
- Do not extract trivial projection helpers merely to unit-test them.
- Wire payloads get one shared Zod schema; do not redefine matching client and
  server interfaces.
- Durable application state is authoritative. Do not ask a model to copy a
  magic marker into prose when the UI can read the canonical API/store result.
- A small feature should use the existing creation, persistence, and navigation
  paths. If it needs a parallel transport or lifecycle, simplify the design
  before adding safety wrappers and tests.

### Preserve lifecycle and hydration authority

- `server/src/lifecycle/shutdown.ts` is the only process-lifecycle and mutation
  admission authority. The dev watcher requests reloads; it never owns, adopts,
  or transfers provider processes.
- A source reload remains pending and fully available while seeking an idle
  boundary. It pauses the scheduler only at a candidate boundary, rechecks all
  active work synchronously, and resumes it if the boundary was not actually
  idle. The server that spawned each admitted turn keeps ownership until it
  drains; only explicit shutdown interrupts owned turns.
- Conversation summaries are bounded transport projections, never durable
  state or a cache. Full transcripts hydrate through the conversation-detail
  route, while the runtime/store remains authoritative.
- Do not add detached-process adoption, fallback snapshots, a second readiness
  gate, or task-specific model routing as incidental “safety.” Those are
  separate architecture decisions and require an explicit scoped design.

### Rendering a client component in a test (no DOM harness required)

The repo has no jsdom/testing-library and does not need one. `react-dom/server`
+ `MemoryRouter` render a real component to a string, which is enough to assert
on the markup contract (hrefs, presence/absence of a target) through the real
router — no mocks, and no assertions on TSX source text.

Two gotchas, both already handled by `pnpm test:client`:

- The test file must be `.tsx`, and `tsx` needs `--tsconfig client/tsconfig.test.json`
  (includes `src` and `test`) or it transpiles JSX with the classic runtime and
  every component under test throws `ReferenceError: React is not defined`.
  `client/tsconfig.app.json` is not enough: it includes only `src`, and tsx
  applies a tsconfig only to the files it includes. The same config is what
  `pnpm typecheck` uses to typecheck the tests, so no `import React` is needed.
- Only markup that renders on first paint is visible. Anything behind local
  state (anything behind a toggle or a menu) will not appear — assert against a section that renders immediately.

`client/test/buddy-conversation-links.test.tsx` is the worked example.

### High-value, low-cost
- Contract tests for builder + provider command specs (`agent-cli-tool`).
- Adapter loader/poller integration fixture test.
- WS init + create/reconcile behavior test around path normalization and visibility.

### Likely overkill now
- Per-provider exhaustive UI suites that duplicate loader + WS + provider contract coverage.
- Mock-heavy provider unit tests where real process/fs integration is the real risk.

If you want exactly three tests:
1. `agent-cli-tool` command contract regression (Gemini + Codex resume + stream flags)
2. `loadAllConversations/pollForChanges` fixture test
3. `test/api.test.js` create/reconcile path normalization test

### Server feedback budgets (2026-10-08)

- `pnpm test:server:fast`: seven explicit protocol/configuration/creation/startup/crash-checker
  files (29 tests). Development feedback only; real backend crash/lease/socket proofs are in full.
- `pnpm test:server`: all server test files, four concurrent files by default.
  `UNLEASHD_TEST_CONCURRENCY=N` selects 1–32; increasing it can slow feedback on a busy machine.
- `pnpm test:server:stress`: the same full coverage with the relay's actual 55 s default and a
  10 s outage. Normal mode uses a 1.5 s hold only in the no-backend timeout case; successful
  outage/restart cases retain their 55 s hold. Lease tests use injected lease/heartbeat/idle
  budgets, real backend SIGSTOP/SIGCONT, and multiple complete lease periods.
- `TSX_DISABLE_CACHE=1 pnpm test:server[:fast]` measures cold TypeScript transforms. This does
  not evict OS caches, reinstall dependencies, or force an addon rebuild. `pnpm run bootstrap`
  prepares a worktree first; addons rebuild only when their own input key misses.

Measurements and failure controls: [2026-10-08 speed evidence](../agent_notes/2026-10-08_test-feedback-speed/README.md).
The 40× message race experiment remains separate evidence when changing that race path; a
normal full run still includes its regression. Fast feedback never replaces full release checks.
