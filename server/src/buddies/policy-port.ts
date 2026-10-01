import { randomUUID } from 'node:crypto';
import type { McpServerSpec } from '@nbardy/agent-cli';
import type { Returns } from '@unleashd/buddies-core';
import type { BuddyContext, BuddyVisibility } from '@unleashd/shared';
import { TURN_MAX_RUNTIME_MS } from '../constants/timeouts';
import type { Briefings, ResolvedBuddyConversation } from './briefing';
import { type GrantRecord, type Grants, INBOX, type TurnGrant } from './grants';
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
  /** Line a chat turn up behind its Buddy's run limit; poll `admission` with the returned id. */
  enqueueChat(context: BuddyContext, conversationId: string): string;
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
    /** The conversation's placement; it fixes where answers to this turn's requests go. */
    visibility: BuddyVisibility;
  }): TurnTools;
  builderMcpServers(conversationId: string): TurnTools;
  /** The turn's holder is alive: push its run's lease forward (Pattern: lease-heartbeat). */
  renewLease(runId: string, leaseToken: string): Promise<LeaseRenewal>;
  /** A replacement backend adopted a running turn: its grant works again, unchanged. */
  adoptGrant(grant: GrantRecord): void;
  /** The turn ended: settle its run (which also revokes the run's grants). */
  settle(
    runId: string,
    leaseToken: string,
    status: 'complete' | 'failed' | 'cancelled',
    detail: string
  ): void;
  /**
   * An adopted runner-owned run drained (its `runTurn` promise died with the old backend): the
   * runner finishes it exactly as `runJob` would have, then settles it.
   */
  finishAdoptedRun(
    runId: string,
    leaseToken: string,
    status: 'complete' | 'failed',
    detail: string
  ): void;
  revoke(conversationId: string): void;
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
    enqueueChat(context, conversationId) {
      const turnId = randomUUID();
      runner.enqueueChat(context, conversationId, turnId);
      return turnId;
    },
    admission: (turnId) => runner.chatAdmission(turnId),
    abandon: (turnId) => runner.abandonChat(turnId),
    mcpServers({ context, conversationId, owner, visibility }) {
      // A new turn's grant replaces whatever this conversation still held.
      grants.revokeConversation(conversationId);
      const grant = grants.issueBuddy({
        role: 'worker',
        buddyId: context.buddyId,
        workspaceId: context.workspaceId,
        conversationId,
        runId: context.coordinationRunId ?? null,
        returns: returnsFor(visibility, conversationId),
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
    adoptGrant: (grant) => grants.adopt(grant),
    settle(runId, leaseToken, status, detail) {
      const outcome =
        status === 'complete'
          ? ({ kind: 'complete', text: detail } as const)
          : status === 'failed'
            ? ({ kind: 'failed', code: 'execution_failed', error: detail } as const)
            : ({ kind: 'cancelled', reason: detail } as const);
      void runner
        .finishChat(runId, leaseToken, outcome)
        .catch((error) => console.error('[buddies] settle failed', runId, error));
    },
    finishAdoptedRun(runId, leaseToken, status, detail) {
      void runner
        .finishAdoptedRun(runId, leaseToken, status, detail)
        .catch((error) => console.error('[buddies] adopted run did not finish', runId, error));
    },
    revoke: (conversationId) => grants.revokeConversation(conversationId),
    afterTurn: (turn) => deps.reviewer.enqueue(turn),
  };
}

// Pattern: route-at-send (docs/patterns.md#route-at-send)
/**
 * Where answers to a turn's requests go, decided here, before the request exists, from the one
 * stored placement of the sending conversation (its kind never changes after creation). The crate
 * keeps it on the request, and nothing downstream re-derives it.
 *
 * Why not later: until 2026-10-01 the runner asked this question only after claiming a `reply`
 * run. For a human chat the answer was "nothing to do" (the `mailbox` job), but the run had already
 * queued behind the owner's turn as `conversation_busy`: 9 no-op replies waited up to 2h44m and
 * read as "blocked", and a CEO Buddy offered to cancel the owner's productive GPU turn. An Inbox
 * request creates no run at all. A human chat never takes automated input, so its Buddy reads
 * answers in its inbox; a background conversation is woken by a turn, behind its busy gate.
 * Guard: buddies-v2 "an answer to a request sent from a human chat starts no run …".
 */
export function returnsFor(visibility: BuddyVisibility, conversationId: string): Returns {
  switch (visibility) {
    case 'foreground':
      return INBOX;
    case 'background':
      return { kind: 'conversation', id: conversationId };
  }
}
