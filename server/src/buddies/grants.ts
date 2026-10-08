import { randomBytes } from 'node:crypto';
import type { Actor } from '@unleashd/buddies-core';
import { OWNER, buddyActor } from './core';
import type { HookSet } from './harness-steering';

/**
 * What one turn may do through the MCP endpoint. The token is readable by the agent's own
 * shell (T07: it sits in the CLI's env, or a 0600 file for muse), so a grant lives exactly as
 * long as its turn: revoked at settle, cancel or expiry, never reused.
 *
 * `author` is who posts and answers are written as. `principal` is whose authority task, doc,
 * run, schedule and team writes use. Only an owner-authored input makes the principal the
 * Owner (B1, T03: a seat answering another Buddy's post never holds owner authority).
 * The crate's `authorize` decides every call; the role only picks which tools are listed.
 */
// Pattern: capability-grants (docs/patterns.md#capability-grants)
export type Role = 'worker' | 'owner' | 'reviewer' | 'builder';
// What a turn's posts subscribe: itself, or its chat's branch (route-at-send, mcp.ts `subscriber`).
export type Subscribes = 'self' | 'branch';
export type OwnerChat = { conversationId: string; buddyId: string; workspaceId: string };

interface GrantBase {
  readonly token: string;
  readonly conversationId: string;
  readonly expiresAt: number;
  readonly author: Actor;
  readonly principal: Actor;
  /** Wraps each tool call: the reviewer counts calls before `call`, landed writes after (I3). */
  readonly observe: Observe;
}

/** A Buddy's turn: a worker, an owner-authored turn, or the post-turn memory reviewer. */
export interface BuddyGrant extends GrantBase {
  readonly role: 'worker' | 'owner' | 'reviewer';
  readonly buddyId: string;
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly subscribes: Subscribes;
  /** The hooks its process was spawned with: what can reach it mid-turn (harness-steering.ts). */
  readonly hooks: HookSet;
}

/** The owner's Buddy Builder chat: no Buddy of its own; it may only read and edit the team. */
export interface BuilderGrant extends GrantBase {
  readonly role: 'builder';
}

export type TurnGrant = BuddyGrant | BuilderGrant;

/**
 * A grant as data: what a replacement backend re-registers when it adopts a turn that is still
 * running (turns/executions.ts). The same token, scope and expiry; no new authority. `observe`
 * is not data: only the memory reviewer sets one, and its executions are never adopted.
 */
export type GrantRecord = Omit<BuddyGrant, 'observe'> | Omit<BuilderGrant, 'observe'>;

/**
 * κ for a grant read back from an execution journal. A journal written before task_01a11af2 has
 * no `hooks`: its process holds whatever hooks its backend had, which is `unrecorded`, said as such.
 */
export function adoptedGrant(record: GrantRecord): GrantRecord {
  if (record.role === 'builder' || 'hooks' in record) return record;
  return { ...(record as Omit<BuddyGrant, 'observe' | 'hooks'>), hooks: { t: 'unrecorded' } };
}

export type Observe = <T>(tool: string, input: unknown, call: () => Promise<T>) => Promise<T>;

export type BuddyGrantInput = {
  role: 'worker' | 'reviewer';
  buddyId: string;
  workspaceId: string;
  conversationId: string;
  runId: string | null;
  subscribes: Subscribes;
  hooks: HookSet;
  observe?: Observe;
};

const ignore: Observe = (_tool, _input, call) => call();

export type Grants = ReturnType<typeof createGrants>;

export function createGrants(options: { ttlMs: number; now?: () => number }) {
  const now = options.now ?? Date.now;
  const byToken = new Map<string, TurnGrant>();

  function issue<G extends TurnGrant>(
    grant: Omit<G, 'token' | 'expiresAt' | 'observe'> & { observe?: GrantBase['observe'] }
  ): G {
    const issued = {
      ...grant,
      observe: grant.observe ?? ignore,
      token: randomBytes(32).toString('base64url'),
      expiresAt: now() + options.ttlMs,
    } as unknown as G;
    byToken.set(issued.token, issued);
    return issued;
  }

  return {
    issueBuddy: (input: BuddyGrantInput) =>
      issue<BuddyGrant>({
        ...input,
        author: buddyActor(input.buddyId),
        principal: buddyActor(input.buddyId),
      }),

    issueBuilder: (conversationId: string) =>
      issue<BuilderGrant>({
        role: 'builder',
        conversationId,
        author: OWNER,
        principal: OWNER,
      }),

    /**
     * The owner wrote this turn's input: the conversation's worker grant becomes an owner grant.
     * Only the runtime calls this, and only for origin 'owner_input' (runtime.ts B1 rule).
     */
    promoteToOwner(conversationId: string): void {
      for (const grant of byToken.values()) {
        if (grant.conversationId !== conversationId || grant.role !== 'worker') continue;
        byToken.set(grant.token, { ...grant, role: 'owner', principal: OWNER });
      }
    },

    /** The grant this token holds now (after any promotion), as data. */
    record(token: string): GrantRecord {
      const grant = byToken.get(token);
      if (!grant) throw new Error('No live grant for this token');
      const { observe: _observe, ...record } = grant;
      return record;
    },

    /** Re-register an adopted turn's grant exactly as it was issued (same token and expiry). */
    adopt(record: GrantRecord): void {
      byToken.set(record.token, { ...adoptedGrant(record), observe: ignore } as TurnGrant);
    },

    lookup(bearer: string): TurnGrant | null {
      const grant = byToken.get(bearer);
      if (!grant) return null;
      if (grant.expiresAt > now()) return grant;
      byToken.delete(bearer);
      return null;
    },

    /** The hooks of the Buddy turn live in `conversationId` here; null: no live turn holds one. */
    liveHooks(conversationId: string): HookSet | null {
      for (const grant of byToken.values())
        if (grant.role !== 'builder' && grant.conversationId === conversationId) return grant.hooks;
      return null;
    },

    revokeConversation(conversationId: string): void {
      for (const grant of [...byToken.values()])
        if (grant.conversationId === conversationId) byToken.delete(grant.token);
    },

    revokeRun(runId: string): void {
      for (const grant of [...byToken.values()])
        if (grant.role !== 'builder' && grant.runId === runId) byToken.delete(grant.token);
    },

    size(): number {
      return byToken.size;
    },
  };
}
