import { mcpHeaderEnvName } from '@nbardy/agent-cli';
import type { Provider } from '@unleashd/shared';
import { CLAUDE_MEMORY_OFF, HARNESS_MEMORY_OFF } from './harness-memory';
import { MCP_SERVER_NAME } from './mcp';

/**
 * Where an owner post reaches a RUNNING Buddy turn (task_01a11a68, owner 2026-10-07/08).
 * - `any-tool`: the harness calls back after every native tool use (Bash, Edit, a sub-agent's
 *   tools), so the post lands mid-turn (mcp.ts `steerNativeTool`).
 * - `buddy-tool-only`: no verified per-turn native hook is wired, so the post lands at the next Buddy MCP
 *   tool call (mcp.ts `liveThreadPosts`, aa19d5a), or else waits visibly as a queued delivery
 *   ("X is replying… queued") and runs right after the turn.
 * Evidence per harness, with the probe commands: agent_notes/2026-10-08_steer-any-tool-boundary.md.
 */
export type Steering = 'any-tool' | 'buddy-tool-only';

/**
 * Where an owner post reaches a turn whose model is idle while its background jobs keep the
 * harness process alive (turns/background-work.ts, task_01a11aa8).
 * - `stop-hook-hold`: the harness runs a blocking Stop hook when its model ends a turn, with its
 *   in-flight background tasks in the input, and continues the same process on `decision: block`
 *   (mcp.ts `holdStoppedTurn`; proven on claude 2.1.294 with a real CLI run).
 * - `waits-visibly`: no such hook is wired (none probed yet, codex included), so the post waits
 *   as a queued delivery ("waiting for the current turn…") and runs when the process exits.
 * Evidence and probe commands: agent_notes/2026-10-08_idle-background-delivery.md.
 */
export type IdleDelivery = 'stop-hook-hold' | 'waits-visibly';

/** Where the loopback Buddy endpoint serves native hooks (mcp.ts `McpEndpoint`). */
export interface SteeringEndpoint {
  /** ONE url for every hook event: the server dispatches on the input's `hook_event_name`. */
  readonly hookUrl: string;
}

/**
 * The hooks a turn's process was spawned with, recorded on its grant (grants.ts) so an adopting
 * backend knows what can reach it (channels.ts `reachOf`).
 * - `stable`: the harness's STABLE hook set below. Every hook event the delivery logic uses (and
 *   the ones it may use, on the hold ceiling) calls one URL, and the server decides what each
 *   does, so a server upgrade reaches processes that are already running.
 * - `none`: the harness has no verified per-turn hook; posts land at a Buddy MCP tool call.
 * - `unrecorded`: spawned before hook sets were recorded (before task_01a11af2), so its argv
 *   holds whichever hooks its backend had: none of them may include Stop (83fd4e1).
 *
 * task_01a11af2 (owner, 2026-10-08): hooks live in the process argv, so a turn keeps the hook set it
 * was spawned with across every adoption. Execution 29c47118, spawned at 09:20:33 by a backend
 * built before 83fd4e1, carried only PostToolUse; its model went idle on a background Workflow,
 * nothing ever called back for the parent, and the owner's 09:30 post waited 25+ minutes. A server
 * fix could not reach it. One-time gap: processes spawned before this change keep their old argv
 * (`unrecorded`) until they end. Evidence: agent_notes/2026-10-08_waiting-paths.md.
 */
export type HookSet =
  | { readonly t: 'stable'; readonly version: 1 }
  | { readonly t: 'none'; readonly harness: Provider }
  | { readonly t: 'unrecorded' };

interface HarnessTurn {
  readonly steering: Steering;
  readonly idle: IdleDelivery;
  readonly hooks: HookSet;
  /** The extra argv of a Buddy worker turn on this harness. */
  args(endpoint: SteeringEndpoint): readonly string[];
}

// The hook authenticates with the turn's own MCP bearer, which the claude process already holds
// in its env (agent-cli `headersViaEnv`), so the token never appears in argv. `--fail`: a backend
// error is a visible hook error and leaves the post unread, so it is delivered after the turn.
function hookCommand(url: string, maxSeconds: number): string {
  const bearer = mcpHeaderEnvName(MCP_SERVER_NAME, 'Authorization');
  return `curl -sS --fail --max-time ${maxSeconds} -X POST -H "Authorization: $${bearer}" -H 'Content-Type: application/json' --data-binary @- '${url}'`;
}

// Ceilings, not behaviour: the server decides when each hook returns. A tool hook answers at once
// and must never stall a turn on a hung backend. An agent-end hook (Stop, SubagentStop) may hold
// as long as background jobs, and need not outlast claude's own wait on them (12 h, agent-cli
// harnesses/claude.ts CLAUDE_PRINT_BG_WAIT_CEILING_MS, which the package does not export): past
// that claude stops the jobs anyway. A hold the hook timeout cuts fails open: claude ends the turn
// as before, and the post runs as the next turn.
const TOOL_HOOK_S = 20;
const HOLD_HOOK_S = 12 * 60 * 60;
const hook = (url: string, seconds: number) => ({
  type: 'command',
  command: hookCommand(url, seconds),
  timeout: seconds + 10,
});

const buddyToolOnly = (provider: Provider): HarnessTurn => ({
  steering: 'buddy-tool-only',
  idle: 'waits-visibly',
  hooks: { t: 'none', harness: provider },
  args: () => HARNESS_MEMORY_OFF[provider],
});

// Pattern: table-driven (docs/patterns.md#table-driven)
export const HARNESS_TURN: Record<Provider, HarnessTurn> = {
  // ONE `--settings` document: it also carries harness-memory.ts's auto-memory switch, and a
  // second `--settings` flag is not documented to merge with the first.
  // PostToolUse `additionalContext` reaches the model as a system reminder after that tool result
  // (claude 2.1.294). It fires for a native sub-agent's tools too, with `agent_id` set; no hook
  // fires for the parent while a foreground sub-agent runs.
  // The STABLE set: every event any delivery path uses, or may (SubagentStop: a sub-agent ending,
  // which the server answers at once today). An event the server does not use answers empty.
  // Never drop an event from this set: running processes keep the set they were spawned with.
  claude: {
    steering: 'any-tool',
    idle: 'stop-hook-hold',
    hooks: { t: 'stable', version: 1 },
    args: ({ hookUrl }) => [
      '--settings',
      JSON.stringify({
        ...CLAUDE_MEMORY_OFF,
        hooks: {
          PostToolUse: [{ matcher: '.*', hooks: [hook(hookUrl, TOOL_HOOK_S)] }],
          PostToolUseFailure: [{ matcher: '.*', hooks: [hook(hookUrl, TOOL_HOOK_S)] }],
          Stop: [{ hooks: [hook(hookUrl, HOLD_HOOK_S)] }],
          SubagentStop: [{ hooks: [hook(hookUrl, HOLD_HOOK_S)] }],
        },
      }),
    ],
  },
  // Inline config is process-local. Hook trust is bypassed only for this already-authorized
  // Buddy invocation; the owner's ~/.codex config and hook files are never changed.
  codex: {
    steering: 'any-tool',
    idle: 'waits-visibly',
    hooks: { t: 'stable', version: 1 },
    args: ({ hookUrl }) => [
      '-c',
      'features.hooks=true',
      '--dangerously-bypass-hook-trust',
      '-c',
      `hooks.PostToolUse=[{matcher=".*",hooks=[{type="command",command=${JSON.stringify(hookCommand(hookUrl, TOOL_HOOK_S))},timeout=30,additionalContextLimit=0}]}]`,
    ],
  },
  opencode: buddyToolOnly('opencode'),
  gemini: buddyToolOnly('gemini'),
  cursor: buddyToolOnly('cursor'),
  muse: buddyToolOnly('muse'),
};
