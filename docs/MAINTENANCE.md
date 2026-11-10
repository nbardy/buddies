# Maintenance

[AGENTS.md](../AGENTS.md) owns the project rules and code map. The
[documentation index](README.md) links the guides to read before changing each
area. Keep implementation guidance in those guides so it has one place to update.

## Verification

Run checks appropriate to the change; [test strategy](test-strategy.md) explains
which boundaries need coverage and how client component tests run.

| Change | Check |
|---|---|
| TypeScript | `pnpm typecheck` |
| Client state, components, or CSS | `pnpm check:client-invariants` and `pnpm test:client` |
| Server behavior | `pnpm test:server` |
| Dev supervisor or watcher | `pnpm test:dev-supervisor` |
| Provider harness | `pnpm test:cli` |
| Published package or public API | `pnpm test:package` (builds, checks both napi `.node` addons resolve from `server/`, boots `server/dist` on a fresh data dir and exercises a Buddies write), then `pnpm test:api` |

`pnpm test` runs the full suite defined in [package.json](../package.json); its one
build is the one `test:package` runs.
`pnpm typecheck` and `pnpm build` take no dev-runtime lock and are safe while
`pnpm dev` runs; only dev tasks claim the one-runtime lock. `pnpm typecheck` is
single-flight machine-wide: a second run waits for the first and reuses its
result when the tree is unchanged (`tools/typecheck.mjs`). The client solution config
requires `tsc -b`; `tsc --noEmit` at the client root checks no source files.

Use Biome for formatting and linting, scoped to the files you changed. The root
configuration excludes `vendor/`; keep provider submodule changes within its
own workflow. See [AGENTS.md](../AGENTS.md) for the full formatting rules.

## Troubleshooting references

- State subscriptions, streaming updates, hook ordering, and stable fallbacks:
  [client state](client-state.md).
- Reload, drain, process ownership, and persistence reconciliation:
  [architecture](architecture.md).
- WebSocket command shapes and event payloads:
  [shared schemas](../shared/src/index.ts) and [WS contract notes](ws-contract-surprises.md).
- Session cache invalidation, permissions, and progressive startup:
  [cache implementation](../server/src/adapters/session-cache.ts) and
  [benchmark/design note](../agent_notes/2026-07-30-session-cache-progressive-loading-and-math-rendering.md).
- Authentication and development-server upgrade gates: [auth](auth.md).

Older feature documents remain available through the documentation index for
historical context. Check the owning code before relying on their file paths,
state-management examples, or performance measurements.
