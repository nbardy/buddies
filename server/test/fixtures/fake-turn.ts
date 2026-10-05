import type { ExecuteCommandRequest, UnifiedAgentEvent, executeCommand } from '@nbardy/agent-cli';
import { type ExecutionJournals, createExecutionJournals } from '../../src/turns/executions';
import { tempDir } from './temp';

/**
 * The part of an agent-cli turn handle the conversation runtime reads. Tests
 * script this instead of spawning a provider; the type keeps every fake turn
 * honest about the fields the runtime actually uses.
 */
export interface FakeTurn {
  events: AsyncIterable<UnifiedAgentEvent>;
  completed: Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    sessionId: string;
    reason: 'success' | 'out_of_tokens' | 'error' | 'killed';
  }>;
  stop(signal?: NodeJS.Signals): void;
}

/** A scripted provider boundary for `ConversationRuntimeDependencies.executeTurn`. */
export function fakeExecuteTurn(
  run: (request: ExecuteCommandRequest) => FakeTurn
): typeof executeCommand {
  // No process: pid 0, and the journal the runtime created for the turn (it removes it at drain).
  const execute = (request: ExecuteCommandRequest) => ({
    pid: 0,
    journalDir: request.journalDir,
    ...run(request),
  });
  return execute as unknown as typeof executeCommand;
}

/** A throwaway executions root: each runtime turn writes its owner journal here. */
export function testExecutions(): ExecutionJournals {
  return createExecutionJournals(tempDir('unleashd-test-executions-'));
}
