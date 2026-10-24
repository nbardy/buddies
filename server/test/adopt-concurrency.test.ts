/**
 * Boot adoption ran one journal at a time (~0.45 s each; 16 turns = 7 s of an 18 s boot,
 * 2026-10-23). It now adopts different conversations concurrently, but two journals of ONE
 * conversation must stay in scan order: the second adopt of a busy conversation is refused, so the
 * winner must not depend on timing. Results (adopted runs) keep scan order.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExecutionHandle } from '@nbardy/agent-cli';
import { type AdoptionPorts, adoptExecutions } from '../src/lifecycle/adopt-executions';
import type { FoundExecution } from '../src/turns/executions';

function buddyTurn(conversationId: string, attemptId: string): FoundExecution {
  return {
    t: 'turn',
    dir: `/journal/${attemptId}`,
    phase: { t: 'running' },
    process: { t: 'live' },
    owner: {
      conversationId,
      attemptId,
      provider: 'claude',
      policy: {
        t: 'buddy',
        run: { runId: `run-${attemptId}`, leaseToken: `lease-${attemptId}` },
      },
    },
  } as unknown as FoundExecution;
}

test('different conversations adopt concurrently; one conversation adopts in scan order', async () => {
  const journals = [
    buddyTurn('a', 'a1'),
    buddyTurn('a', 'a2'),
    buddyTurn('b', 'b1'),
    buddyTurn('c', 'c1'),
  ];
  const started: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const ports: AdoptionPorts = {
    conversation: async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight--;
      return {
        adoptTurn: (owner) => {
          started.push(owner.attemptId);
        },
      };
    },
    attach: () => ({}) as ExecutionHandle,
    discard: () => undefined,
    attemptInterrupted: () => undefined,
    logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
  };
  const adopted = await adoptExecutions(journals, ports);

  assert.ok(peak >= 3, `conversations a, b, c should overlap (peak ${peak})`);
  assert.ok(started.indexOf('a1') < started.indexOf('a2'), 'a1 is adopted before a2');
  assert.deepEqual(
    adopted.map((run) => run.runId),
    ['run-a1', 'run-a2', 'run-b1', 'run-c1'],
    'adopted runs keep scan order'
  );
});
