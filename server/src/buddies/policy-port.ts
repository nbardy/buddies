import type { McpServerSpec } from '@nbardy/agent-cli';
import type { BuddyContext } from '@unleashd/shared';
import { TURN_MAX_RUNTIME_MS } from '../constants/timeouts';
import type { ExecutionOutcome } from '../turns/execution-state';
import type { Briefings, ResolvedBuddyConversation } from './briefing';
import type { GrantRecord, Grants, Subscribes, TurnGrant } from './grants';
import type { SteeringEndpoint } from './harness-steering';
import { MCP_SERVER_NAME } from './mcp';
import type { CompletedBuddyTurn, MemoryReviewer } from './memory-review';
import type { LeaseRenewal, Runner } from './runner';

/**
 * The narrow interface BuddyTurnPolicy (buddies/turn-policy.ts) calls for one Buddy turn.
 * Everything Buddy-specific a turn needs goes through here: the briefing, run admission, the one
 * MCP server (an HTTP spec carrying a fresh per-turn grant), settle, and the post-turn hook.
 */
export interface BuddyPolicyPort {
  /** The briefing composed for this context right before its turn (synchronous; see briefing.ts). */
  currentBriefing(context: BuddyContext): ResolvedBuddyConversation;
  /**
   * A queued owner message becomes a `chat` run carrying `body` (its text and provenance), named
   * by the message id. The runner claims it when the Buddy has a slot and hands it to the
   * conversation; nothing polls. Idempotent per message id.
   */
  queueChat(context: BuddyContext, conversationId: string, turnId: string, body: string): void;
  promoteChat(turnId: string): void;
  cancelChat(turnId: string): void;
  /**
   * The MCP servers of one turn: one server, one fresh grant. `owner` is true only for an
   * owner-authored input (B1); it is the one thing that makes the principal the Owner. A grant
   * is issued whole, so there is no issue order to keep (T08 had to issue the Buddy grant before
   * the owner grant because issuing revoked the conversation's earlier grants). `subscribes`:
   * where the turn's posts subscribe (grants.ts `Subscribes`).
   */
  mcpServers(turn: {
    context: BuddyContext;
    conversationId: string;
    owner: boolean;
    subscribes: Subscribes;
  }): BuddyTurnTools;
  builderMcpServers(conversationId: string): TurnTools;
  /** The turn's holder is alive: push its run's lease forward (Pattern: lease-heartbeat). */
  renewLease(runId: string, leaseToken: string): Promise<LeaseRenewal>;
  /** This turn executes `runId`: every claim passes it to the gate, which renews it first, until the release. */
  hold(runId: string, leaseToken: string): () => void;
  /**
   * A run's turn ended, an owner chat's or a runner-owned one: its completion step (none for a
   * chat), then its settle, which also revokes the run's grants. Resolves once the settle landed
   * or the run had already ended (lease_lost); rejects on a transient failure.
   */
  finishRun(runId: string, leaseToken: string, outcome: ExecutionOutcome): Promise<void>;
  revoke(conversationId: string): void;
  /** After a successful turn: memory review. */
  afterTurn(turn: CompletedBuddyTurn): void;
}

/** One turn's MCP servers and the grant they carry (kept so the turn can be adopted). */
export interface TurnTools {
  servers: Record<string, McpServerSpec>;
  grant: GrantRecord;
}

/** A Buddy worker turn's tools, plus where its harness hook reports native tool uses. */
export interface BuddyTurnTools extends TurnTools {
  steering: SteeringEndpoint;
}

export function createBuddyPolicyPort(deps: {
  runner: Runner;
  grants: Grants;
  briefings: Briefings;
  reviewer: MemoryReviewer;
  spec(grant: TurnGrant): McpServerSpec;
  steering(): SteeringEndpoint;
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
    queueChat: (context, conversationId, turnId, body) =>
      runner.queueChat(context, conversationId, turnId, body),
    promoteChat: (turnId) => runner.promoteChat(turnId),
    cancelChat: (turnId) => runner.cancelChat(turnId),
    mcpServers({ context, conversationId, owner, subscribes }) {
      // A new turn's grant replaces whatever this conversation still held.
      grants.revokeConversation(conversationId);
      const grant = grants.issueBuddy({
        role: 'worker',
        buddyId: context.buddyId,
        workspaceId: context.workspaceId,
        conversationId,
        runId: context.coordinationRunId ?? null,
        subscribes,
      });
      if (owner) grants.promoteToOwner(conversationId);
      return {
        servers: { [MCP_SERVER_NAME]: deps.spec(grant) },
        grant: grants.record(grant.token),
        steering: deps.steering(),
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
    hold: (runId, leaseToken) => runner.hold(runId, leaseToken),
    finishRun: (runId, leaseToken, outcome) => runner.finishRun(runId, leaseToken, outcome),
    revoke: (conversationId) => grants.revokeConversation(conversationId),
    afterTurn: (turn) => deps.reviewer.enqueue(turn),
  };
}
