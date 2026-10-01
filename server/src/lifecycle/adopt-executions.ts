import type { ExecutionHandle } from '@nbardy/agent-cli';
import type { AdoptedRun } from '../buddies/runner';
import type { FoundExecution, TurnOwner } from '../turns/executions';
import type { AdoptedExecution } from '../turns/policy';

/** A conversation as the boot adoption pass sees it. */
export interface AdoptingConversation {
  adoptTurn(owner: TurnOwner, handle: ExecutionHandle, execution: AdoptedExecution): void;
}

export interface AdoptionPorts {
  /** The conversation that owns a turn, materialized and ready; undefined when it is gone. */
  conversation(id: string): Promise<AdoptingConversation | undefined>;
  attach(dir: string): ExecutionHandle;
  /** Kill the journal's process (if any) and delete it. */
  discard(found: FoundExecution): void;
  /** An open attempt whose execution cannot be adopted ends as it always did at a restart. */
  attemptInterrupted(attemptId: string): void;
  logger: Pick<Console, 'log' | 'warn' | 'error'>;
}

/**
 * Boot, after conversations load and BEFORE the Buddy runner recovers or claims anything: every
 * journal a previous backend left is adopted by its conversation or discarded. Adopting first is
 * what makes a second writer impossible: the conversation is busy with the adopted turn by the
 * time any run could resume its session (the 2026-09-30 "already has an active writer" failure).
 * Returns the Buddy runs the adopted turns execute under, which recovery must keep.
 */
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
  if (item.state.kind === 'unstarted') return refuse('the provider never started');
  const conversation = await ports.conversation(owner.conversationId);
  if (!conversation) return refuse('its conversation is gone');
  try {
    conversation.adoptTurn(owner, ports.attach(item.dir), executionAt(item.state));
  } catch (error) {
    return refuse(`adoption failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  ports.logger.log(
    `[adopt] ${owner.conversationId}: adopted ${item.state.kind} ${owner.provider} turn ${owner.attemptId}`
  );
  return owner.policy.t === 'buddy'
    ? { runId: owner.policy.run.runId, conversationId: owner.conversationId }
    : null;
}

// Pattern: sum-types (docs/patterns.md#sum-types)
function executionAt(state: Extract<FoundExecution, { t: 'turn' }>['state']): AdoptedExecution {
  switch (state.kind) {
    case 'running':
      return { state: 'running' };
    case 'exited':
    case 'lost':
      return { state: 'ended' };
    case 'unstarted':
      throw new Error('an unstarted execution is refused, never adopted');
  }
}
