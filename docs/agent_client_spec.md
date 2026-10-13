# Agent Client Spec

How CLI agents (Claude, Codex, OpenCode, future) are wrapped and consumed by the server.

## Two Usage Modes

Every agent supports two distinct invocation patterns:

### 1. Conversation Mode (stateful, streaming)

Multi-turn sessions. The server calls `executeCommand({ mode: 'conversation', ... })` from `@nbardy/agent-cli`, consumes normalized streaming events, and broadcasts them to WebSocket clients.

**Lifecycle:**
```
executeCommand(request) → async event stream → handleOutput(event) → process closes
```

**Key properties:**
- Session continuity via `resumeSessionId` input and emitted canonical session IDs.
- Provider-specific CLI flags/output parsing live in `agent-cli-tool`, not in server providers.
- Process exits after each turn; server starts a new execution for the next turn.

**Implemented in:** `Conversation.spawnForMessage()` in `server/src/server.ts`

### 2. Single-Shot Mode (stateless, collect-all)

One prompt in, one response out. No session continuity required. The server calls `executeCommand({ mode: 'single-shot', ... })` and aggregates normalized text/error/complete events.

**Lifecycle:**
```
executeCommand(request) → consume events until complete → parse/return final output
```

**Key properties:**
- No resume required
- Same unified event contract as conversation mode
- Used for utility tasks (palette generation, summarization, etc.)

**Implemented in:** `POST /api/generate-palette` in `server/src/server.ts`

## The Model Catalog

One data file, `vendor/agent-cli-tool/catalog.jsonc`, lists every provider's
models, default model, reasoning levels/default effort and retired-id aliases.
`pnpm --filter @unleashd/shared gen:catalog` parses it with the shared schemas
(`shared/src/provider-catalog.ts`) into `shared/src/generated/catalog.ts`;
`shared/src/model-catalog.ts` derives lookup, alias normalization and
validation from it. The server serves it unchanged at `GET /api/provider-catalog`
(`server/src/providers/catalog-service.ts`, which only adds `supportsRequiredMcp`
from the harness). App choices such as default model or effort are catalog
data, never server-side overrides. The default effort is `medium` for every
reasoning model: product policy, not the CLI's. Do not copy
`default_reasoning_level` from codex's `models_cache.json` when adding a model
(gpt-6.1-sol shipped `low` that way on 2026-09-30);
`server/test/conversation-config-domain.test.ts` asserts it over the whole
catalog. Runtime command construction, process execution and output
normalization live in `agent-cli-tool`.

### Runtime event contract

Turn events are typed ONCE, by agent-cli: `UnifiedAgentEvent`
(`vendor/agent-cli-tool/src/runtime-types.ts`). The server folds them directly in
`server/src/turns/runner.ts` (`EventFold`, one handler per event type). The old
server-side `ProviderEvent` re-typing layer was deleted in T08 (2026-09-25).

### Contract

1. `executeCommand` MUST emit only `UnifiedAgentEvent`s.
2. Provider-specific schema drift is handled inside `agent-cli-tool` parsers.
3. `turn.complete` closes the UI stream; execution ownership ends only when the
   child exits AND the event stream drains (one joined terminal path).
4. Harness differences the server still sees (Codex collab sub-agents) live in the
   capability table `server/src/turns/subagents.ts`, never in the fold.

## Model Selection

Model IDs are passed verbatim to the CLI; `agent-cli-tool` harness logic turns
them into flags. Reasoning effort is a separate field, validated against the
union of the provider's model levels.

OpenCode (`supportsDynamicModels`) also accepts ad-hoc path-style IDs
(`provider/model`, optionally with more segments such as
`openrouter/openai/gpt-5`), which keeps them from overlapping Claude/Codex IDs.

## How the Server Consumes Providers

### Conversation Flow

```
1. Conversation created (conversations/runtime.ts) with its config and kind;
   the kind picks its TurnPolicy once (chat / Buddy / Buddy Builder).
2. User sends message → queue_message (WS) → enqueueMessage() → TurnQueue →
   processQueue() → sendMessageInternal() → policy.gate() → sendAdmittedMessage().
3. sendAdmittedMessage(): policy.prepare(), Chat Fork resolution, preflight,
   policy.providerPrompt(), then TurnRunner.start() (turns/runner.ts):
   a. executeCommand({ harness, mode: 'conversation', prompt, cwd, model,
      reasoningEffort, resumeSessionId, ...policy.startTurn() })
   b. fold each UnifiedAgentEvent (text, tools, sub-agents, session, usage)
   c. TurnWatchdog (bridge / provider-idle / max runtime) and the folder's
      SwarmObserver run while the turn runs
4. Drain: child exit + event EOF join, then the attempt record, the policy's
   end-of-turn hooks, the queue head, and processQueue() for the next turn.
```

## Session Management

### Claude
- First message: `--session-id <uuid>` creates a new session
- Subsequent messages: `--resume <uuid>` continues the session
- Tracked by `_hasStartedSession` boolean on Conversation
- `resetProcess()` generates a new session ID for fresh context (used in loop mode)

### Codex
- First message: `codex exec --json -C <workingDir> -` (reads prompt from stdin)
- Codex CLI emits `{"type":"thread.started","thread_id":"<uuid>"}` — the server captures this UUID
- Subsequent messages: `codex exec resume <thread_id> --json -` (reads prompt from stdin)
- The `-` positional argument tells Codex to read the prompt from stdin
- Codex self-persists sessions to `~/.codex/sessions/YYYY/MM/DD/*.jsonl`

### OpenCode
- First message: `opencode run --format json` (reads prompt from stdin)
- OpenCode emits `sessionID` on JSON events (top-level or `part`) — the server captures this for resume
- Subsequent messages: `opencode run --format json --session <sessionID> --continue`
- If no valid `sessionID` has been captured yet, server omits `--session` and starts a new one

## Stdout Parsing

Provider stdout parsing is centralized in `agent-cli-tool`.

`server/src/server.ts` consumes normalized events from `executeCommand` and does not parse raw provider JSON lines directly. This keeps per-provider protocol differences out of server runtime and avoids duplicating parsing logic across call sites.

## Persistence

### Claude Code
- Self-persists to `~/.claude/projects/{encoded-path}/{session-id}.jsonl`
- Our server reads these on startup and polls for changes (5s interval)
- We never write to Claude's files

### Codex
- Self-persists to `~/.codex/sessions/YYYY/MM/DD/*.jsonl`
- Server does not mirror-write Codex files; native Codex sessions are the source of truth
- During active turns, in-memory streaming state is authoritative; the ingest watcher skips active session IDs
- For Codex spawned sub-agent sessions, `session_meta.payload.source.subagent.thread_spawn.parent_thread_id` is mapped to `Conversation.parentConversationId` and projected into the same header sub-agent panel used by provider Task-tool sub-agents

### OpenCode
- Self-persists message metadata to `~/.local/share/opencode/storage/message/{session-id}/*.json`
- Message content is reconstructed from associated part files in `~/.local/share/opencode/storage/part/{message-id}/*.json`
- Session metadata (cwd/title/time) is read from `~/.local/share/opencode/storage/session/{project-id}/{session-id}.json` when present
- During active turns, in-memory streaming state is authoritative; the ingest watcher skips active session IDs

### Loading
- The `unleashd-ingest` addon (`crates/unleashd-ingest`) loads Claude from `~/.claude/projects/*`, Codex from `~/.codex/sessions/YYYY/MM/DD/*`, and OpenCode from `~/.local/share/opencode/storage/message/*`
- `inferProviderFromModel(model)` is used only for Claude-format entries; native Codex/OpenCode sources are loaded as `provider=codex` / `provider=opencode`
- The ingest file watcher detects external changes for all three providers (user ran `claude` / `codex` / `opencode` in terminal)

## Permissions

Each provider has a "max permissions" mode enabled by default:

| Provider | Env Var | Flags |
|----------|---------|-------|
| Claude | `CLAUDE_MAX_PERMISSIONS` (default: true) | `--dangerously-skip-permissions --permission-mode bypassPermissions --tools default --add-dir <workingDir>` |
| Codex | `CODEX_MAX_PERMISSIONS` (default: true) | `--dangerously-bypass-approvals-and-sandbox` |

Set `CLAUDE_MAX_PERMISSIONS=false` or `CODEX_MAX_PERMISSIONS=false` to disable.

## Adding a New Provider

### Pi / SoL-Pi

The `pi` harness uses the pinned `sol-pi` launcher (Pi 1.1.0 plus SoL-Pi
PR #105). Launch, native MCP/codemode configuration, JSON event normalization
and native session create/resume/fork live in `agent-cli-tool`. The Rust ingest
crate reads Pi's session tree under `~/.pi/agent/sessions`; ordinary appends
fold only new bytes, while a branch change rebuilds its visible path. Usage
includes abandoned branches. Completion follows `agent_settled`, preserving
SoL-Pi's compaction continuations. Required Buddy MCP waits for actual native
tool registration before the agent starts, rather than relying on a concurrent
reachability probe. Setup/model access: `vendor/agent-cli-tool/docs/sol-pi.md`.

1. **Implement harness + parser in `agent-cli-tool`**
   - Add harness config in `agent-cli-tool/src/harnesses/{name}.ts`
   - Add parser/normalizer in `agent-cli-tool/src/run.ts`
   - Ensure `executeCommand` emits normalized events consumed by `server`

2. **Add it to the catalog**
   - Extend `ProviderSchema` in `shared/src/provider-catalog.ts`
   - Add its entry to `vendor/agent-cli-tool/catalog.jsonc`, then `pnpm check:catalog`

3. **Persistence** (if the agent doesn't self-persist):
   - Add a transcript parser to `crates/unleashd-ingest` (see its README)

4. **Session ID capture**:
   - Emit canonical session-start events from `agent-cli-tool` so `server` can update `conversation.sessionId`
