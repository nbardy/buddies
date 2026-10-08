import type { BuddyContext } from '@unleashd/shared';
import type { GrantRecord } from '../../src/buddies/grants';
import type { CompletedBuddyTurn } from '../../src/buddies/memory-review';
import type { BuddyPolicyPort } from '../../src/buddies/policy-port';
import { TURN_MAX_RUNTIME_MS } from '../../src/constants/timeouts';
import { Conversation } from '../../src/conversations/runtime';

const FIXTURE_GRANT = { token: 'fixture-grant' } as GrantRecord;

// Fixture: the Buddy module as the conversation runtime's Buddy policy sees it. The real port
// (policy-port.ts over the crate, grants and runner) is exercised end to end by
// buddies-v2.test.ts; runtime tests only need its turn-shaped behavior. By default a chat run is
// claimed at once (as if the Buddy had a free slot) with a TURN_MAX_RUNTIME_MS deadline, and a turn
// gets no MCP server. The claim reaches the conversation through `fixtureConversations`: a test
// registers the conversation it builds, as the server's RunnerHost does by id.
// A conversation registers itself the first time it queues a message, so a test needs no wiring.
const proto = Conversation.prototype as unknown as { enqueuePrompt(...args: unknown[]): void };
const enqueuePrompt = proto.enqueuePrompt;
proto.enqueuePrompt = function (this: Conversation, ...args: unknown[]) {
  fixtureConversations.set(this.id, this);
  return enqueuePrompt.apply(this, args);
};

export const fixtureConversations = new Map<
  string,
  {
    admitChatClaim(
      turnId: string,
      body: string,
      run: { id: string; claim_token: string; deadline: string }
    ): void;
  }
>();

export function fakeBuddyPort(
  options: {
    briefing?: (context: BuddyContext) => { briefing: string; memoryGeneration: string };
    /** Replaces the instant claim: a test that wants the run to wait does not claim it. */
    queueChat?: (
      context: BuddyContext,
      conversationId: string,
      turnId: string,
      body: string
    ) => void;
    promoteChat?: (turnId: string) => void;
    cancelChat?: (turnId: string) => void;
    finishRun?: BuddyPolicyPort['finishRun'];
    revoke?: (conversationId: string) => void;
    afterTurn?: (turn: CompletedBuddyTurn) => void;
  } = {}
): BuddyPolicyPort {
  return {
    currentBriefing: (context) => ({
      context,
      workingDirectory: '/tmp',
      execution: { kind: 'run', provider: 'codex', model: undefined, reasoningEffort: undefined },
      ...(options.briefing?.(context) ?? { briefing: 'FIXTURE_BRIEFING', memoryGeneration: '1' }),
    }),
    queueChat:
      options.queueChat ??
      ((_context, conversationId, turnId, body) =>
        fixtureConversations.get(conversationId)?.admitChatClaim(turnId, body, {
          id: `run-${turnId}`,
          claim_token: 'lease',
          deadline: new Date(Date.now() + TURN_MAX_RUNTIME_MS).toISOString(),
        })),
    promoteChat: options.promoteChat ?? (() => undefined),
    cancelChat: options.cancelChat ?? (() => undefined),
    // No endpoint in these fixtures: no servers, and a grant that only needs to be data.
    mcpServers: () => ({
      servers: {},
      grant: FIXTURE_GRANT,
      steering: {
        postToolHookUrl: 'http://127.0.0.1:9/hooks/post-tool-use',
        stopHookUrl: 'http://127.0.0.1:9/hooks/stop',
      },
    }),
    builderMcpServers: () => ({ servers: {}, grant: FIXTURE_GRANT }),
    renewLease: async () => ({ kind: 'renewed' }),
    hold: () => () => undefined,
    finishRun: options.finishRun ?? (async () => undefined),
    revoke: options.revoke ?? (() => undefined),
    afterTurn: options.afterTurn ?? (() => undefined),
  };
}
