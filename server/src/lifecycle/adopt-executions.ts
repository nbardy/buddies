import type { ExecutionHandle } from '@nbardy/agent-cli';
import type { RunStatus } from '@unleashd/buddies-core';
import type { AdoptedRun } from '../buddies/runner';
import type { AdoptedStop, FoundExecution, TurnOwner } from '../turns/executions';
import type { AdoptedExecution } from '../turns/policy';
import { describeTurnTimeout } from '../turns/watchdog';

/** A conversation as the boot adoption pass sees it. */
export interface AdoptingConversation {
  adoptTurn(owner: TurnOwner, handle: ExecutionHandle, execution: AdoptedExecution): void;
}

/**
 * The Buddy run a turn executes under, as the crate holds it now. `none`: the turn has no run (a
 * chat or Builder turn). `released`: the run no longer waits on this execution (settled, or never
 * claimed by it).
 */
export type RunStanding = 'none' | 'held' | 'cancel_requested' | 'released';

export interface AdoptionPorts {
  /** The conversation that owns a turn, materialized and ready; undefined when it is gone. */
  conversation(id: string): Promise<AdoptingConversation | undefined>;
  attach(dir: string): ExecutionHandle;
  /** Kill the journal's process (if any) and delete it. */
  discard(found: FoundExecution): void;
  /** An open attempt whose execution cannot be adopted ends as it always did at a restart. */
  attemptInterrupted(attemptId: string): void;
  /** The crate's view of a Buddy run (existing durable stop state: `cancel_requested`). */
  runStatus(runId: string): Promise<RunStatus>;
  /** A turn with no run of its own may run this long from its start (TURN_MAX_RUNTIME_MS). */
  maxRuntimeMs: number;
  now(): number;
  logger: Pick<Console, 'log' | 'warn' | 'error'>;
}

/**
 * Boot, after conversations load and BEFORE the Buddy runner recovers or claims anything: every
 * journal a previous backend left is adopted by its conversation or discarded. Adopting first is
 * what makes a second writer impossible: the conversation is busy with the adopted turn by the
 * time any run could resume its session (the 2026-09-30 "already has an active writer" failure).
 * Returns the Buddy runs the adopted turns execute under, which recovery must keep.
 */
// Pattern: detached-execution (docs/patterns.md#detached-execution)
export async function adoptExecutions(
  found: readonly FoundExecution[],
  ports: AdoptionPorts
): Promise<AdoptedRun[]> {
  const adopted: AdoptedRun[] = [];
  for (const item of found) {
    switch (item.t) {
      case 'ephemeral':
      case 'unreadable':
        ports.discard(item);
        continue;
      case 'turn': {
        const run = await adoptTurn(item, ports);
        if (run) adopted.push(run);
        continue;
      }
    }
  }
  return adopted;
}

/** How boot treats one turn journal, decided once from what is on disk (`standingOf`). */
// Pattern: sum-types (docs/patterns.md#sum-types)
export type Standing =
  | { t: 'adopt'; execution: AdoptedExecution }
  | { t: 'discard'; reason: string };

/**
 * The κ of boot adoption: one decision per journal from durable facts only. A turn is adopted as a
 * LIVE writer (grant restored, deadline re-armed) only when its execution runs, no stop was
 * recorded for it, its run (if any) still holds it, and its deadline has not passed. Anything the
 * old backend was ending is re-stopped; until 2026-10-01 a backend SIGKILLed inside the 3 s kill
 * grace had its stopped turns adopted as live, grants and all (release blocker 2a; guard:
 * adoption-stop.test.ts).
 */
export function standingOf(
  item: Extract<FoundExecution, { t: 'turn' }>,
  run: RunStanding,
  facts: { now: number; maxRuntimeMs: number }
): Standing {
  const { owner, state, intent } = item;
  if (state.kind === 'unstarted') return { t: 'discard', reason: 'the provider never started' };
  if (run === 'released') return { t: 'discard', reason: 'its run no longer waits on it' };
  const stopping = (stop: AdoptedStop): Standing => ({
    t: 'adopt',
    execution: { state: 'stopping', stop },
  });
  switch (intent.t) {
    case 'reset':
      return { t: 'discard', reason: 'it was being reset for a fresh session' };
    case 'stop':
    case 'timeout':
      return stopping(intent);
    case 'continue':
      break;
  }
  // Recorded by the crate before the old backend signalled anything (runner.cancel).
  if (run === 'cancel_requested') return stopping({ t: 'stop', cause: 'user_stop' });
  if (state.kind !== 'running') return { t: 'adopt', execution: { state: 'ended' } };
  const startedAt = Date.parse(owner.startedAt);
  if (facts.now >= deadlineOf(owner, startedAt, facts.maxRuntimeMs)) {
    const elapsedSeconds = Math.round((facts.now - startedAt) / 1000);
    return stopping({
      t: 'timeout',
      ...describeTurnTimeout('max', {
        elapsedSeconds,
        bridgeIdleSeconds: 0,
        providerIdleSeconds: 0,
        sawMeaningfulOutput: true,
      }),
    });
  }
  return { t: 'adopt', execution: { state: 'running' } };
}

/** When the turn's own budget ends: its run's deadline, else the runtime cap from its start. */
function deadlineOf(owner: TurnOwner, startedAt: number, maxRuntimeMs: number): number {
  switch (owner.policy.t) {
    case 'buddy':
      return Date.parse(owner.policy.run.deadline);
    case 'chat':
    case 'builder':
      return startedAt + maxRuntimeMs;
  }
}

/** The crate's run status as this boot boundary needs it. */
export function runStandingOf(status: RunStatus): RunStanding {
  switch (status) {
    case 'running':
      return 'held';
    case 'cancel_requested':
      return 'cancel_requested';
    case 'queued':
    case 'complete':
    case 'failed':
    case 'cancelled':
      return 'released';
  }
}

async function adoptTurn(
  item: Extract<FoundExecution, { t: 'turn' }>,
  ports: AdoptionPorts
): Promise<AdoptedRun | null> {
  const { owner } = item;
  const refuse = (reason: string) => {
    ports.logger.warn(`[adopt] ${owner.conversationId}: ${reason}; discarding ${item.dir}`);
    ports.discard(item);
    ports.attemptInterrupted(owner.attemptId);
    return null;
  };
  let standing: Standing;
  try {
    const run =
      owner.policy.t === 'buddy'
        ? runStandingOf(await ports.runStatus(owner.policy.run.runId))
        : 'none';
    standing = standingOf(item, run, { now: ports.now(), maxRuntimeMs: ports.maxRuntimeMs });
  } catch (error) {
    return refuse(`its run is unreadable: ${error instanceof Error ? error.message : error}`);
  }
  switch (standing.t) {
    case 'discard':
      return refuse(standing.reason);
    case 'adopt':
      return adoptInto(item, standing.execution, ports, refuse);
  }
}

async function adoptInto(
  item: Extract<FoundExecution, { t: 'turn' }>,
  execution: AdoptedExecution,
  ports: AdoptionPorts,
  refuse: (reason: string) => null
): Promise<AdoptedRun | null> {
  const { owner } = item;
  const conversation = await ports.conversation(owner.conversationId);
  if (!conversation) return refuse('its conversation is gone');
  try {
    conversation.adoptTurn(owner, ports.attach(item.dir), execution);
  } catch (error) {
    return refuse(`adoption failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  ports.logger.log(
    `[adopt] ${owner.conversationId}: adopted ${execution.state} ${owner.provider} turn ${owner.attemptId}`
  );
  return owner.policy.t === 'buddy'
    ? { runId: owner.policy.run.runId, conversationId: owner.conversationId }
    : null;
}
