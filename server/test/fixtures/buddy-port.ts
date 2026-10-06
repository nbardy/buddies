import type { BuddyContext } from '@unleashd/shared';
import type { GrantRecord } from '../../src/buddies/grants';
import type { CompletedBuddyTurn } from '../../src/buddies/memory-review';
import type { BuddyPolicyPort } from '../../src/buddies/policy-port';
import type { ChatAdmission } from '../../src/buddies/runner';
import { TURN_MAX_RUNTIME_MS } from '../../src/constants/timeouts';

const FIXTURE_GRANT = { token: 'fixture-grant' } as GrantRecord;

// Fixture: the Buddy module as the conversation runtime's Buddy policy sees it. The real port
// (policy-port.ts over the crate, grants and runner) is exercised end to end by
// buddies-v2.test.ts; runtime tests only need its turn-shaped behavior. By default a chat run is
// admitted at once with a TURN_MAX_RUNTIME_MS deadline and a turn gets no MCP server.
export function fakeBuddyPort(
  options: {
    briefing?: (context: BuddyContext) => { briefing: string; memoryGeneration: string };
    admission?: (turnId: string) => ChatAdmission;
    enqueueChat?: (context: BuddyContext, conversationId: string) => string;
    abandon?: (turnId: string) => void;
    settle?: BuddyPolicyPort['settle'];
    finishRun?: BuddyPolicyPort['finishRun'];
    revoke?: (conversationId: string) => void;
    afterTurn?: (turn: CompletedBuddyTurn) => void;
  } = {}
): BuddyPolicyPort {
  let turns = 0;
  return {
    currentBriefing: (context) => ({
      context,
      workingDirectory: '/tmp',
      execution: { kind: 'run', provider: 'codex', model: undefined, reasoningEffort: undefined },
      ...(options.briefing?.(context) ?? { briefing: 'FIXTURE_BRIEFING', memoryGeneration: '1' }),
    }),
    enqueueChat: options.enqueueChat ?? (() => `turn-${++turns}`),
    admission:
      options.admission ??
      ((turnId) => ({
        kind: 'admitted',
        run: {
          id: `run-${turnId}`,
          claim_token: 'lease',
          deadline: new Date(Date.now() + TURN_MAX_RUNTIME_MS).toISOString(),
        },
      })),
    abandon: options.abandon ?? (() => undefined),
    // No endpoint in these fixtures: no servers, and a grant that only needs to be data.
    mcpServers: () => ({ servers: {}, grant: FIXTURE_GRANT }),
    builderMcpServers: () => ({ servers: {}, grant: FIXTURE_GRANT }),
    renewLease: async () => ({ kind: 'renewed' }),
    finishRun: options.finishRun ?? (async () => undefined),
    settle: options.settle ?? (async () => undefined),
    revoke: options.revoke ?? (() => undefined),
    cancelQueuedReturns: async () => undefined,
    afterTurn: options.afterTurn ?? (() => undefined),
  };
}
