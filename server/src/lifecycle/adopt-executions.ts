import type { ExecutionHandle } from '@nbardy/agent-cli';
import type { GrantRecord } from '../buddies/grants';
import type { AdoptedRun } from '../buddies/runner';
import {
  type Adoption,
  type Effect,
  type Phase,
  adoption,
  holdsGrant,
} from '../turns/execution-state';
import { forEachConcurrently } from '../ingest/conversation-list';
import type { FoundExecution, TurnOwner } from '../turns/executions';
import type { PolicyAdoption } from '../turns/policy';

/** A conversation as the boot adoption pass sees it. */
export interface AdoptingConversation {
  adoptTurn(
    owner: TurnOwner,
    handle: ExecutionHandle,
    phase: Phase,
    effects: readonly Effect[]
  ): void;
}

export interface AdoptionPorts {
  /** The conversation that owns a turn, materialized and ready; undefined when it is gone. */
  conversation(id: string): Promise<AdoptingConversation | undefined>;
  attach(dir: string): ExecutionHandle;
  /** Kill the journal's process (if any), delete it, and revoke any grant boot restored for it. */
  discard(found: FoundExecution): void;
  /** An open attempt whose execution cannot be adopted ends as it always did at a restart. */
  attemptInterrupted(attemptId: string): void;
  logger: Pick<Console, 'log' | 'warn' | 'error'>;
}

const ADOPTION_CONCURRENCY = 8;

type Turn = Extract<FoundExecution, { t: 'turn' }>;

// Pattern: persisted-state-machine (docs/patterns.md#persisted-state-machine)
/**
 * Boot, first step, BEFORE the Buddy MCP endpoint listens: the grants of every journal that may
 * hold one (`holdsGrant`: a live `running` turn, nothing else). Restoring them later, at adoption,
 * left a window where an adopted turn's tool call met a 401 from the new backend (P1 review,
 * 2026-10-01). A stopped or timed-out turn's grant is never restored (2a).
 */
export function liveGrants(found: readonly FoundExecution[]): GrantRecord[] {
  return found.flatMap((item) =>
    item.t === 'turn' && holdsGrant(item.phase, item.process.t)
      ? GRANTS[item.owner.policy.t](item.owner.policy as never)
      : []
  );
}

const GRANTS: {
  readonly [P in PolicyAdoption as P['t']]: (policy: P) => GrantRecord[];
} = {
  chat: () => [],
  builder: ({ grant }) => (grant ? [grant] : []),
  buddy: ({ grant }) => [grant],
};

const RUNS: {
  readonly [P in PolicyAdoption as P['t']]: (policy: P, conversationId: string) => AdoptedRun[];
} = {
  chat: () => [],
  builder: () => [],
  buddy: ({ run }, conversationId) => [
    { runId: run.runId, leaseToken: run.leaseToken, conversationId },
  ],
};

/**
 * Boot, after conversations load and BEFORE the Buddy runner claims anything: every journal a
 * previous backend left is adopted by its conversation or discarded, as its phase decides
 * (execution-state.ts ADOPTIONS). Adopting first is what makes a second writer impossible: the
 * conversation is busy with the adopted turn by the time any run could resume its session (the
 * 2026-09-30 "already has an active writer" failure). Returns the Buddy runs the adopted turns
 * execute under: the runner renews their leases before its first claim, whose gate would otherwise
 * end a run whose lease ran out during the gap. A refused turn's run is not ended here: its lease
 * runs out and the gate ends it (Pattern: lease-heartbeat).
 * Boot trusts the phase alone because each phase reached disk before its effects ran: a `stopping`
 * turn is signalled again rather than revived (2a), and an `ended` one settles the outcome its
 * drain recorded rather than recovering as interrupted (2b). Guards: execution-crash-checker.test.ts
 * and the crash-window tests in execution-adoption.test.ts.
 */
export async function adoptExecutions(
  found: readonly FoundExecution[],
  ports: AdoptionPorts
): Promise<AdoptedRun[]> {
  // Fix-guard: serial adoption cost ~0.45 s per turn (16 turns = 7 s of a 18 s boot, 2026-10-23).
  // Journals of DIFFERENT conversations are independent, so they adopt concurrently (bounded);
  // journals of ONE conversation stay in scan order, because the second adopt of a busy
  // conversation is refused and which one wins must not depend on timing. Results keep scan order.
  const results: AdoptedRun[][] = found.map(() => []);
  const lanes = new Map<string, number[]>();
  found.forEach((item, index) => {
    const key = laneOf(item);
    const lane = lanes.get(key) ?? [];
    lane.push(index);
    lanes.set(key, lane);
  });
  await forEachConcurrently([...lanes.values()], ADOPTION_CONCURRENCY, async (lane) => {
    for (const index of lane) results[index] = await adoptOne(found[index], ports);
  });
  return results.flat();
}

/** Journals of one conversation share a lane; every other journal is its own. */
function laneOf(item: FoundExecution): string {
  switch (item.t) {
    case 'turn':
    case 'unstarted':
      return `conversation:${item.owner.conversationId}`;
    case 'oompa':
    case 'ephemeral':
    case 'unreadable':
      return `journal:${item.dir}`;
  }
}

async function adoptOne(item: FoundExecution, ports: AdoptionPorts): Promise<AdoptedRun[]> {
  switch (item.t) {
    case 'oompa':
      return []; // Oompa journals are not this pass's: it never touched them.
    case 'ephemeral':
    case 'unreadable':
      ports.discard(item);
      return [];
    case 'unstarted':
      return refuse(item, 'the provider never started', ports);
    case 'turn': {
      const plan = adoption(item.phase, item.process.t);
      return ADOPT[plan.t](item, plan as never, ports);
    }
  }
}

function refuse(
  item: Turn | Extract<FoundExecution, { t: 'unstarted' }>,
  reason: string,
  ports: AdoptionPorts
): AdoptedRun[] {
  ports.logger.warn(`[adopt] ${item.owner.conversationId}: ${reason}; discarding ${item.dir}`);
  ports.discard(item);
  ports.attemptInterrupted(item.owner.attemptId);
  return [];
}

const ADOPT: {
  readonly [A in Adoption as A['t']]: (
    item: Turn,
    plan: A,
    ports: AdoptionPorts
  ) => Promise<AdoptedRun[]>;
} = {
  // Abandoned or settled: nothing left to settle; its attempt is already terminal.
  discard: async (item, _, ports) => {
    ports.logger.log(
      `[adopt] ${item.owner.conversationId}: ${item.phase.t}; discarding ${item.dir}`
    );
    ports.discard(item);
    return [];
  },
  follow: async (item, { effects }, ports) => {
    const { owner } = item;
    const conversation = await ports.conversation(owner.conversationId);
    if (!conversation) return refuse(item, 'its conversation is gone', ports);
    try {
      conversation.adoptTurn(owner, ports.attach(item.dir), item.phase, effects);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return refuse(item, `adoption failed: ${message}`, ports);
    }
    ports.logger.log(
      `[adopt] ${owner.conversationId}: adopted ${item.phase.t} (${item.process.t}) ${owner.provider} turn ${owner.attemptId}`
    );
    return RUNS[owner.policy.t](owner.policy as never, owner.conversationId);
  },
};
