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

/** Where the loopback Buddy endpoint serves native hooks (mcp.ts `McpEndpoint`). */
export interface SteeringEndpoint {
  readonly postToolHookUrl: string;
}

interface HarnessTurn {
  readonly steering: Steering;
  /** The extra argv of a Buddy worker turn on this harness. */
  args(endpoint: SteeringEndpoint): readonly string[];
}

// The hook authenticates with the turn's own MCP bearer, which the claude process already holds
// in its env (agent-cli `headersViaEnv`), so the token never appears in argv. `--fail`: a backend
// error is a visible hook error and leaves the post unread, so it is delivered after the turn.
function hookCommand(url: string): string {
  const bearer = mcpHeaderEnvName(MCP_SERVER_NAME, 'Authorization');
  return `curl -sS --fail --max-time 20 -X POST -H "Authorization: $${bearer}" -H 'Content-Type: application/json' --data-binary @- '${url}'`;
}

const buddyToolOnly = (provider: Provider): HarnessTurn => ({
  steering: 'buddy-tool-only',
  args: () => HARNESS_MEMORY_OFF[provider],
});

// Pattern: table-driven (docs/patterns.md#table-driven)
export const HARNESS_TURN: Record<Provider, HarnessTurn> = {
  // ONE `--settings` document: it also carries harness-memory.ts's auto-memory switch, and a
  // second `--settings` flag is not documented to merge with the first.
  // PostToolUse `additionalContext` reaches the model as a system reminder after that tool result
  // (claude 2.1.294). It fires for a native sub-agent's tools too, with `agent_id` set; no hook
  // fires for the parent while a foreground sub-agent runs.
  claude: {
    steering: 'any-tool',
    args: (endpoint) => [
      '--settings',
      JSON.stringify({
        ...CLAUDE_MEMORY_OFF,
        hooks: Object.fromEntries(
          ['PostToolUse', 'PostToolUseFailure'].map((event) => [
            event,
            [
              {
                matcher: '.*',
                hooks: [
                  {
                    type: 'command',
                    command: hookCommand(endpoint.postToolHookUrl),
                    timeout: 30,
                  },
                ],
              },
            ],
          ])
        ),
      }),
    ],
  },
  // Inline config is process-local. Hook trust is bypassed only for this already-authorized
  // Buddy invocation; the owner's ~/.codex config and hook files are never changed.
  codex: {
    steering: 'any-tool',
    args: (endpoint) => [
      '-c',
      'features.hooks=true',
      '--dangerously-bypass-hook-trust',
      '-c',
      `hooks.PostToolUse=[{matcher=".*",hooks=[{type="command",command=${JSON.stringify(hookCommand(endpoint.postToolHookUrl))},timeout=30,additionalContextLimit=0}]}]`,
    ],
  },
  opencode: buddyToolOnly('opencode'),
  gemini: buddyToolOnly('gemini'),
  cursor: buddyToolOnly('cursor'),
  muse: buddyToolOnly('muse'),
};
