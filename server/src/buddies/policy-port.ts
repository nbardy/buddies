import { randomUUID } from 'node:crypto';
import type { McpServerSpec } from '@nbardy/agent-cli';
import type { Outcome } from '@unleashd/buddies-core';
import type { BuddyContext } from '@unleashd/shared';
import { TURN_MAX_RUNTIME_MS } from '../constants/timeouts';
import type { ExecutionOutcome } from '../turns/execution-state';
import type { TurnInput } from '../turns/input';
import type { Briefings, ResolvedBuddyConversation } from './briefing';
import { type GrantRecord, type Grants, type TurnGrant } from './grants';
import { MCP_SERVER_NAME } from './mcp';
import type { CompletedBuddyTurn, MemoryReviewer } from './memory-review';
import type { ChatAdmission, LeaseRenewal, Runner } from './runner';

/**
 * The narrow interface BuddyTurnPolicy (buddies/turn-policy.ts) calls for one Buddy turn.
 * Everything Buddy-specific a turn needs goes through here: the briefing, run admission, the one
 * MCP server (an HTTP spec carrying a fresh per-turn grant), settle, and the post-turn hook.
 */
export interface BuddyPolicyPort {
  /** The briefing composed for this context right before its turn (synchronous; see briefing.ts). */
  currentBriefing(context: BuddyContext): ResolvedBuddyConversation;
  /**
   * Line a chat turn up behind its Buddy's run limit; poll `admission` with the returned id. The
   * run is written with `input` as its body: a queued chat run without its input is refused.
   */
  enqueueChat(context: BuddyContext, conversationId: string, input: TurnInput): string;
  admission(turnId: string): ChatAdmission;
  abandon(turnId: string): void;
  /**
   * The MCP servers of one turn: one server, one fresh grant. `owner` is true only for an
   * owner-authored input (B1); it is the one thing that makes the principal the Owner. A grant
   * is issued whole, so there is no issue order to keep (T08 had to issue the Buddy grant before
   * the owner grant because issuing revoked the conversation's earlier grants).
   */
  mcpServers(turn: {
    context: BuddyContext;
    conversationId: string;
    owner: boolean;
  }): TurnTools;
  builderMcpServers(conversationId: string): TurnTools;
  /** The turn's holder is alive: push its run's lease forward (Pattern: lease-heartbeat). */
  renewLease(runId: string, leaseToken: string): Promise<LeaseRenewal>;
  /**
   * The turn of a chat run ended: settle it (which also revokes the run's grants). Resolves once
   * the settle landed or the run had already ended (lease_lost); rejects on a transient failure.
   */
  settle(runId: string, leaseToken: string, outcome: ExecutionOutcome): Promise<void>;
  /** A runner-owned run's turn ended: its completion step, then its settle, as `settle` resolves. */
  finishRun(runId: string, leaseToken: string, outcome: ExecutionOutcome): Promise<void>;
  revoke(conversationId: string): void;
  /**
   * The owner pressed Stop in this conversation: end its queued deliveries (decision C). The posts
   * stay unread, so they reach the Buddy with its next delivery or read; Stop means "quiet down
   * now", not "never tell me". Resolves once they are cancelled.
   */
  cancelQueuedDeliveries(conversationId: string): Promise<void>;
  /** After a successful turn: memory review. */
  afterTurn(turn: CompletedBuddyTurn): void;
}

/** One turn's MCP servers and the grant they carry (kept so the turn can be adopted). */
export interface TurnTools {
  servers: Record<string, McpServerSpec>;
  grant: GrantRecord;
}

export function createBuddyPolicyPort(deps: {
  runner: Runner;
  grants: Grants;
  briefings: Briefings;
  reviewer: MemoryReviewer;
  spec(grant: TurnGrant): McpServerSpec;
}): BuddyPolicyPort {
  const { runner, grants, briefings } = deps;
  // A chat's deadline is its run's `deadline`, set at claim from this budget. A chat deadline
  // shorter than the turn budget (a 600 s claim lease) killed healthy owner chats on 2026-09-10;
  // refuse to build that. The lease is a separate, short heartbeat since 2026-10-01 and is
  // deliberately NOT checked here. Guard: buddies-v2.test.ts.
  if (runner.chatDeadlineMs < TURN_MAX_RUNTIME_MS)
    throw new Error(`Buddy chat deadline ${runner.chatDeadlineMs} ms < TURN_MAX_RUNTIME_MS`);
  return {
    currentBriefing: (context) => briefings.current(context),
    enqueueChat(context, conversationId, input) {
      const turnId = randomUUID();
      runner.enqueueChat(context, conversationId, turnId, JSON.stringify(input));
      return turnId;
    },
    admission: (turnId) => runner.chatAdmission(turnId),
    abandon: (turnId) => runner.abandonChat(turnId),
    mcpServers({ context, conversationId, owner }) {
      // A new turn's grant replaces whatever this conversation still held.
      grants.revokeConversation(conversationId);
      const grant = grants.issueBuddy({
        role: 'worker',
        buddyId: context.buddyId,
        workspaceId: context.workspaceId,
        conversationId,
        runId: context.coordinationRunId ?? null,
      });
      if (owner) grants.promoteToOwner(conversationId);
      return {
        servers: { [MCP_SERVER_NAME]: deps.spec(grant) },
        grant: grants.record(grant.token),
      };
    },
    builderMcpServers(conversationId) {
      grants.revokeConversation(conversationId);
      const grant = grants.issueBuilder(conversationId);
      return {
        servers: { [MCP_SERVER_NAME]: deps.spec(grant) },
        grant: grants.record(grant.token),
      };
    },
    renewLease: (runId, leaseToken) => runner.renew(runId, leaseToken),
    settle: (runId, leaseToken, outcome) =>
      runner.finishChat(runId, leaseToken, crateOutcome(outcome)),
    finishRun: (runId, leaseToken, outcome) => runner.finishRun(runId, leaseToken, outcome),
    revoke: (conversationId) => grants.revokeConversation(conversationId),
    cancelQueuedDeliveries: (conversationId) => runner.cancelQueuedDeliveries(conversationId),
    afterTurn: (turn) => deps.reviewer.enqueue(turn),
  };
}

/** A turn's outcome as the crate records a run's. */
export function crateOutcome(outcome: ExecutionOutcome): Outcome {
  switch (outcome.t) {
    case 'complete':
      return { kind: 'complete', text: outcome.text };
    case 'failed':
      return { kind: 'failed', code: 'execution_failed', error: outcome.detail };
    case 'cancelled':
      return { kind: 'cancelled', reason: outcome.detail };
  }
}
