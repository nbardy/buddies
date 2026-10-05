import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { type UnifiedAgentEvent, createParser } from '@nbardy/agent-cli';
import { buddyKind } from '@unleashd/shared';
import type { Message, Provider } from '@unleashd/shared';
import { type ConversationConfig, createDefaultConversationConfig } from '@unleashd/shared';
import type { CompletedBuddyTurn } from '../src/buddies/memory-review';
import type { BuddyPolicyPort } from '../src/buddies/policy-port';
import type { ChatAdmission } from '../src/buddies/runner';
import {
  type ConversationOptions,
  type ConversationRuntimeDependencies,
  createConversationRuntime,
} from '../src/conversations/runtime';
import { resolveConfigAgainstProviderCatalog } from '../src/providers/catalog-service';
import { type TurnTimeoutKind, TurnWatchdog } from '../src/turns/watchdog';
import { fakeBuddyPort } from './fixtures/buddy-port';
import { fakeExecuteTurn, testExecutions } from './fixtures/fake-turn';

const BACKGROUND_AGENT_FIXTURE = join(
  __dirname,
  '../../vendor/agent-cli-tool/test/fixtures/claude-2.1.283-background-agent.jsonl'
);

function messageText(message: Pick<Message, 'body'> | undefined): string {
  if (!message) return '';
  return message.body.t === 'text'
    ? message.body.text
    : message.body.parts
        .map((part) => (part.t === 'text' ? part.text : part.t === 'tool' ? part.name : ''))
        .join('\n');
}

function runtimeFixture(
  options: {
    provider?: Provider;
    config?: ConversationConfig;
    getConversation?: ConversationRuntimeDependencies['getConversation'];
    persistCurrentSession?: ConversationRuntimeDependencies['persistCurrentSession'];
    executeTurn?: ConversationRuntimeDependencies['executeTurn'];
    turnAttempts?: ConversationRuntimeDependencies['turnAttempts'];
    revokeBuddyControlCapability?: (conversationId: string) => void;
    enqueueBuddyChatRun?: () => { id: string };
    startBuddyChatRun?: (turnId: string) => ChatAdmission;
    abandonBuddyChatRun?: (turnId: string) => void;
    finishBuddyChatRun?: BuddyPolicyPort['settle'];
    finishBuddyRun?: BuddyPolicyPort['finishRun'];
    reviewCompletedBuddyTurn?: (turn: CompletedBuddyTurn) => void;
    readCurrentBuddyContext?: () => { briefing: string; memoryGeneration: string };
    buddyContext?: CompletedBuddyTurn['context'];
  } = {}
) {
  const aliases: Array<[string, string]> = [];
  const broadcasts: unknown[] = [];
  const config = options.config ?? createDefaultConversationConfig(options.provider ?? 'codex');
  const Conversation = createConversationRuntime({
    executions: testExecutions(),
    broadcast: (message) => broadcasts.push(message),
    registerSessionAlias: (sessionId, conversationId) => {
      if (sessionId) aliases.push([sessionId, conversationId]);
    },
    unregisterSessionAlias: () => undefined,
    clearExternalRunningStatus: () => undefined,
    clearLocalCompletionSuppression: () => undefined,
    markLocalCompletionSuppression: () => undefined,
    persistCurrentSession: options.persistCurrentSession ?? (async () => undefined),
    getConversation: options.getConversation ?? (() => undefined),
    readLatestOompaRuntime: async () => ({
      available: false,
      run: null,
      reason: 'No runs directory found',
    }),
    createSessionId: () => 'rotated-session',
    executeTurn: options.executeTurn,
    turnAttempts: options.turnAttempts,
    buddies: fakeBuddyPort({
      enqueueChat: options.enqueueBuddyChatRun && (() => options.enqueueBuddyChatRun!().id),
      admission: options.startBuddyChatRun,
      abandon: options.abandonBuddyChatRun,
      settle: options.finishBuddyChatRun,
      finishRun: options.finishBuddyRun,
      revoke: options.revokeBuddyControlCapability,
      afterTurn: options.reviewCompletedBuddyTurn,
      briefing: options.readCurrentBuddyContext,
    }),
  });
  const configState = {
    config,
    revision: 0,
    resolution: resolveConfigAgainstProviderCatalog(config),
  };
  const conversation = new Conversation({
    done: false,
    id: 'conversation-id',
    workingDirectory: '/tmp',
    configState,
    kind: options.buddyContext ? buddyKind(options.buddyContext) : { t: 'chat' },
  });
  return { aliases, broadcasts, configState, Conversation, conversation };
}

/** Capture what reaches the provider boundary; the turn never answers. */
function captureSpawns() {
  const spawns: Array<{ content: string; forkSourceSessionId?: string }> = [];
  const stubs: Array<ReturnType<typeof openTurnStub>> = [];
  return {
    spawns,
    executeTurn: fakeExecuteTurn((request) => {
      spawns.push({
        content: request.prompt,
        ...(request.forkSessionId ? { forkSourceSessionId: request.forkSessionId } : {}),
      });
      const stub = openTurnStub();
      stubs.push(stub);
      return stub.turn;
    }),
    /** Stop the open turn so the test process can exit (kill escalation timers are unref'd). */
    release(conversation: { resetProcess(): void }) {
      conversation.resetProcess();
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function eventually(assertion: () => void): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  assertion();
}

test('resumed Buddy turns re-brief only when the memory generation changes', async () => {
  // Regression: from 5c0cec4 (2026-09-20) every Buddy turn re-sent the full
  // ~20k-char briefing, so a provider transcript carried one copy per turn
  // (44 in one session) and every later step re-read all of them.
  type Request = Parameters<NonNullable<ConversationRuntimeDependencies['executeTurn']>>[0];
  const requests: Request[] = [];
  let current = {
    briefing: 'BRIEFING_GEN_1',
    memoryGeneration: '1',
  };
  const fixture = runtimeFixture({
    readCurrentBuddyContext: () => current,
    executeTurn: fakeExecuteTurn((request) => {
      requests.push(request);
      const sessionId = request.resumeSessionId ?? 'native-session';
      return {
        events: (async function* () {
          yield { type: 'session.started' as const, sessionId };
          yield { type: 'turn.started' as const };
          yield { type: 'turn.complete' as const, reason: 'success' as const };
        })(),
        completed: Promise.resolve({ exitCode: 0, signal: null, sessionId, reason: 'success' }),
        stop: () => undefined,
      };
    }),
  });
  const conversation = new fixture.Conversation({
    done: false,
    id: 'steady-buddy',
    workingDirectory: '/tmp',
    configState: fixture.configState,
    kind: buddyKind({ buddyId: 'buddy', workspaceId: 'workspace' }),
  });
  const turn = async (content: string) => {
    conversation.sendMessage(content, { origin: 'owner_input', inputId: content });
    await eventually(() => assert.equal(conversation.hasActiveProcess(), false));
  };

  await turn('one');
  await turn('two');
  current = { ...current, briefing: 'BRIEFING_GEN_2', memoryGeneration: '2' };
  await turn('three');
  await turn('four');

  assert.deepEqual(
    requests.map((request) => request.prompt.match(/BRIEFING_GEN_\d/)?.[0] ?? 'none'),
    ['BRIEFING_GEN_1', 'none', 'BRIEFING_GEN_2', 'none']
  );
  assert.deepEqual(
    requests.map((request) => request.resumeSessionId),
    [undefined, 'native-session', 'native-session', 'native-session']
  );
});

// The session audience key fences a provider session: owner turns and worker/message turns in one
// Buddy conversation never share one. Memory stopped using it on 2026-09-26 (one memory per Buddy);
// its strings did not change, so every session saved under the old key still resumes on deploy.
test('session audience key: an owner turn resumes a session saved under the old key; a non-owner turn resets it', async () => {
  type Request = Parameters<NonNullable<ConversationRuntimeDependencies['executeTurn']>>[0];
  const requests: Request[] = [];
  const persisted: Array<string | undefined> = [];
  const fixture = runtimeFixture({
    readCurrentBuddyContext: () => ({ briefing: 'BRIEFING', memoryGeneration: '1' }),
    persistCurrentSession: async (_conversation, _sessionId, audienceKey) => {
      persisted.push(audienceKey);
    },
    executeTurn: fakeExecuteTurn((request) => {
      requests.push(request);
      const sessionId = request.resumeSessionId ?? `fresh-${requests.length}`;
      return {
        events: (async function* () {
          yield { type: 'session.started' as const, sessionId };
          yield { type: 'turn.started' as const };
          yield { type: 'turn.complete' as const, reason: 'success' as const };
        })(),
        completed: Promise.resolve({ exitCode: 0, signal: null, sessionId, reason: 'success' }),
        stop: () => undefined,
      };
    }),
  });
  const ownerKey = '{"kind":"thread","threadId":"seat-buddy"}';
  const conversation = new fixture.Conversation({
    done: false,
    id: 'seat-buddy',
    workingDirectory: '/tmp',
    configState: fixture.configState,
    kind: buddyKind({ buddyId: 'buddy', workspaceId: 'workspace' }),
    existingSessionId: 'saved-session',
    existingSessionAudienceKey: ownerKey,
  });
  const turn = async (content: string, owner: boolean) => {
    conversation.sendMessage(
      content,
      owner ? { origin: 'owner_input', inputId: content } : undefined
    );
    await eventually(() => assert.equal(conversation.hasActiveProcess(), false));
  };

  await turn('one', true);
  await turn('two', true);
  await turn('from another buddy', false);

  assert.deepEqual(
    requests.map((request) => request.resumeSessionId),
    ['saved-session', 'saved-session', undefined],
    'two owner turns share the saved session; the non-owner turn starts fresh'
  );
  assert.deepEqual(persisted, [
    ownerKey,
    ownerKey,
    '{"kind":"workspace","workspaceId":"workspace"}',
  ]);
});

test('provider completion waits for the normalized event stream and session persistence', async () => {
  const persistence = deferred<void>();
  const completion = deferred<{
    exitCode: number;
    signal: null;
    sessionId: string;
    reason: 'success';
  }>();
  async function* events() {
    yield { type: 'session.started' as const, sessionId: 'provider-session' };
    yield { type: 'turn.started' as const };
    yield { type: 'text.delta' as const, text: 'durable output' };
    yield { type: 'turn.complete' as const, reason: 'success' as const };
  }
  const revoked: string[] = [];
  const reviews: CompletedBuddyTurn[] = [];
  const fixture = runtimeFixture({
    buddyContext: { buddyId: 'buddy-1', workspaceId: 'workspace-1' },
    reviewCompletedBuddyTurn: (turn) => reviews.push(turn),
    persistCurrentSession: () => persistence.promise,
    revokeBuddyControlCapability: (conversationId) => revoked.push(conversationId),
    executeTurn: fakeExecuteTurn(() => ({
      events: events(),
      completed: completion.promise,
      stop: () => undefined,
    })),
  });
  let automationOutput: string | null = null;
  fixture.conversation.once('buddy-turn-complete', (output) => {
    assert.equal(reviews.length, 1, 'snapshot precedes listeners admitting a new turn');
    automationOutput = output;
  });

  fixture.conversation.sendMessage('Run the turn');
  completion.resolve({
    exitCode: 0,
    signal: null,
    sessionId: 'provider-session',
    reason: 'success',
  });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(fixture.conversation.hasActiveProcess(), true);
  assert.equal(
    automationOutput,
    null,
    'automation ownership must not release on turn.complete before process/event drain'
  );
  assert.equal(
    fixture.conversation.messages.some((message) =>
      messageText(message).includes('durable output')
    ),
    false,
    'completion must not release ownership while session persistence blocks event consumption'
  );
  assert.deepEqual(revoked, [], 'control authority remains until the joined turn drains');
  assert.equal(reviews.length, 0, 'memory review also waits for process exit and event drain');

  persistence.resolve();
  await eventually(() => assert.equal(fixture.conversation.hasActiveProcess(), false));
  assert.equal(
    fixture.conversation.messages.some((message) =>
      messageText(message).includes('durable output')
    ),
    true
  );
  assert.equal(automationOutput, 'durable output');
  assert.deepEqual(revoked, ['conversation-id']);
  assert.equal(reviews.length, 1);
  assert.ok(reviews[0].messages.some((message) => messageText(message) === 'durable output'));
  assert.ok(reviews[0].attemptId);
});

// 493c1c7: a resumed Claude seat emitted a result for drained task-notifications
// before the prompt's own answer; sealing on that first turn.complete dropped the answer.
test('an early turn.complete does not drop the prompt answer that follows it', async () => {
  async function* events() {
    yield { type: 'turn.started' as const };
    yield { type: 'turn.complete' as const, reason: 'success' as const };
    yield { type: 'text.delta' as const, text: 'The real answer' };
  }
  const fixture = runtimeFixture({
    executeTurn: fakeExecuteTurn(() => ({
      events: events(),
      completed: Promise.resolve({
        exitCode: 0,
        signal: null,
        sessionId: 'provider-session',
        reason: 'success',
      }),
      stop: () => undefined,
    })),
  });
  let output = '';
  fixture.conversation.once('buddy-turn-complete', (text: string) => {
    output = text;
  });
  fixture.conversation.sendMessage('The owner prompt');
  await eventually(() => assert.equal(fixture.conversation.hasActiveProcess(), false));
  assert.match(output, /The real answer/);
});

test('buddy completion preserves current-turn prose when a tool is last', async () => {
  let turn = 0;
  const fixture = runtimeFixture({
    executeTurn: fakeExecuteTurn(() => {
      turn += 1;
      const current = turn;
      async function* events() {
        yield { type: 'turn.started' as const };
        yield { type: 'text.delta' as const, text: current === 1 ? 'Old turn' : 'Current answer' };
        yield { type: 'tool.use' as const, name: 'Read', input: { file_path: '/a' } };
        yield { type: 'turn.complete' as const, reason: 'success' as const };
      }
      return {
        events: events(),
        completed: Promise.resolve({
          exitCode: 0,
          signal: null,
          sessionId: 'provider-session',
          reason: 'success' as const,
        }),
        stop: () => undefined,
      };
    }),
  });
  const outputs: string[] = [];
  fixture.conversation.on('buddy-turn-complete', (text: string) => outputs.push(text));
  fixture.conversation.sendMessage('First');
  await eventually(() => assert.equal(fixture.conversation.hasActiveProcess(), false));
  fixture.conversation.sendMessage('Second');
  await eventually(() => assert.equal(fixture.conversation.hasActiveProcess(), false));
  assert.deepEqual(outputs, ['Old turn', 'Current answer']);
});

// The terminal failure names the provider's own message, unwrapped from its JSON
// envelope, instead of the generic "Provider reported an error" (493c1c7).
test('a provider error fails the turn with its own message, not the JSON envelope', async () => {
  async function* events() {
    yield { type: 'turn.started' as const };
    yield {
      type: 'error' as const,
      message: '{"error":{"message":"The gpt-5.4 model is not supported when using Codex"}}',
    };
    yield { type: 'turn.complete' as const, reason: 'error' as const };
  }
  const fixture = runtimeFixture({
    executeTurn: fakeExecuteTurn(() => ({
      events: events(),
      completed: Promise.resolve({
        exitCode: 1,
        signal: null,
        sessionId: 'provider-session',
        reason: 'error',
      }),
      stop: () => undefined,
    })),
  });
  let failure = '';
  fixture.conversation.once('buddy-turn-failed', (reason: string) => {
    failure = reason;
  });
  fixture.conversation.sendMessage('Run the turn');
  await eventually(() => assert.equal(fixture.conversation.hasActiveProcess(), false));
  assert.equal(failure, 'The gpt-5.4 model is not supported when using Codex');
});

test('event-stream failure after turn.complete fails automation after joined drain', async () => {
  const reviews: CompletedBuddyTurn[] = [];
  async function* events() {
    yield { type: 'turn.started' as const };
    yield { type: 'text.delta' as const, text: 'partial output' };
    yield { type: 'turn.complete' as const, reason: 'success' as const };
    throw new Error('event stream failed after completion marker');
  }
  const fixture = runtimeFixture({
    buddyContext: { buddyId: 'buddy-1', workspaceId: 'workspace-1' },
    reviewCompletedBuddyTurn: (turn) => reviews.push(turn),
    executeTurn: fakeExecuteTurn(() => ({
      events: events(),
      completed: Promise.resolve({
        exitCode: 0,
        signal: null,
        sessionId: 'provider-session',
        reason: 'success',
      }),
      stop: () => undefined,
    })),
  });
  let completed = false;
  let failure: string | null = null;
  fixture.conversation.once('buddy-turn-complete', () => {
    completed = true;
  });
  fixture.conversation.once('buddy-turn-failed', (reason) => {
    failure = reason;
  });

  fixture.conversation.sendMessage('Run the turn');
  await eventually(() => assert.equal(fixture.conversation.hasActiveProcess(), false));

  assert.equal(completed, false);
  assert.equal(failure, 'event stream failed after completion marker');
  assert.deepEqual(reviews, []);
});

test('only a successfully exited Buddy turn schedules memory review', async () => {
  for (const outcome of ['ordinary', 'failed', 'cancelled', 'success'] as const) {
    const reviews: CompletedBuddyTurn[] = [];
    const completion = deferred<{
      exitCode: number;
      signal: null;
      sessionId: string;
      reason: 'success' | 'error';
    }>();
    const fixture = runtimeFixture({
      buddyContext:
        outcome === 'ordinary' ? undefined : { buddyId: 'buddy-1', workspaceId: 'workspace-1' },
      reviewCompletedBuddyTurn: (turn) => reviews.push(turn),
      executeTurn: fakeExecuteTurn(() => ({
        events: (async function* () {
          yield { type: 'turn.started' as const };
          yield { type: 'text.delta' as const, text: 'Completed answer' };
          yield { type: 'turn.complete' as const, reason: 'success' as const };
        })(),
        completed: completion.promise,
        stop: () => undefined,
      })),
    });
    fixture.conversation.sendMessage('Remember our result');
    if (outcome === 'cancelled') fixture.conversation.stop();
    completion.resolve({
      exitCode: outcome === 'failed' ? 1 : 0,
      signal: null,
      sessionId: 'review-session',
      reason: outcome === 'failed' ? 'error' : 'success',
    });
    await eventually(() => assert.equal(fixture.conversation.hasActiveProcess(), false));
    assert.equal(reviews.length, outcome === 'success' ? 1 : 0, outcome);
  }
});

test('preflight failure immediately rejects an automation turn listener', () => {
  const config: ConversationConfig = {
    provider: 'codex',
    model: { mode: 'explicit', modelId: 'model-that-does-not-exist' },
    reasoning: { mode: 'default' },
  };
  const { conversation } = runtimeFixture({ config });
  let failure: string | undefined;
  conversation.once('buddy-turn-failed', (reason) => {
    failure = reason;
  });

  conversation.sendMessage('Run an automation');

  assert.equal(
    failure,
    'Configuration unavailable: Model is unavailable for codex: model-that-does-not-exist'
  );
  assert.equal(conversation.hasActiveProcess(), false);
});

test('synchronous provider startup failure notifies automation listeners', () => {
  const { conversation } = runtimeFixture({
    executeTurn: fakeExecuteTurn(() => {
      throw new Error('provider startup rejected');
    }),
  });
  let failure: string | undefined;
  conversation.once('buddy-turn-failed', (reason) => {
    failure = reason;
  });

  assert.throws(() => conversation.sendMessage('Run an automation'), /provider startup rejected/);
  assert.equal(failure, 'provider startup rejected');
  assert.equal(conversation.hasActiveProcess(), false);
});

test('a Codex turn that fails before creating a thread retries without resume', async () => {
  type Request = Parameters<NonNullable<ConversationRuntimeDependencies['executeTurn']>>[0];
  const requests: Request[] = [];
  const { conversation } = runtimeFixture({
    executeTurn: fakeExecuteTurn((request) => {
      requests.push(request);
      const first = requests.length === 1;
      return {
        events: (async function* () {
          yield { type: 'turn.started' as const };
          if (first) {
            yield { type: 'error' as const, message: 'required MCP server failed to initialize' };
          } else {
            yield { type: 'session.started' as const, sessionId: 'real-codex-thread' };
            yield { type: 'text.delta' as const, text: 'Ready' };
            yield { type: 'turn.complete' as const, reason: 'success' as const };
          }
        })(),
        completed: Promise.resolve({
          exitCode: first ? 1 : 0,
          signal: null,
          sessionId: first ? '' : 'real-codex-thread',
          reason: first ? ('error' as const) : ('success' as const),
        }),
        stop: () => undefined,
      };
    }),
  });

  conversation.sendMessage('First request');
  await eventually(() => assert.equal(conversation.hasActiveProcess(), false));
  conversation.sendMessage('Retry');
  await eventually(() => assert.equal(conversation.hasActiveProcess(), false));

  assert.equal(requests.length, 2);
  assert.equal(requests[0].resumeSessionId, undefined);
  assert.equal(requests[1].resumeSessionId, undefined);
  assert.equal(conversation.sessionId, 'real-codex-thread');
});

test('a missing Codex rollout clears a legacy phantom session binding', async () => {
  type Request = Parameters<NonNullable<ConversationRuntimeDependencies['executeTurn']>>[0];
  const requests: Request[] = [];
  const fixture = runtimeFixture({
    executeTurn: fakeExecuteTurn((request) => {
      requests.push(request);
      const missing = requests.length === 1;
      return {
        events: (async function* () {
          yield { type: 'turn.started' as const };
          if (missing) {
            yield {
              type: 'error' as const,
              message: 'thread/resume failed: no rollout found for thread id phantom-thread',
            };
          } else {
            yield { type: 'session.started' as const, sessionId: 'new-codex-thread' };
            yield { type: 'text.delta' as const, text: 'Ready' };
            yield { type: 'turn.complete' as const, reason: 'success' as const };
          }
        })(),
        completed: Promise.resolve({
          exitCode: missing ? 1 : 0,
          signal: null,
          sessionId: missing ? '' : 'new-codex-thread',
          reason: missing ? ('error' as const) : ('success' as const),
        }),
        stop: () => undefined,
      };
    }),
  });
  const conversation = new fixture.Conversation({
    id: 'legacy-codex-conversation',
    done: false,
    kind: { t: 'chat' },
    workingDirectory: '/tmp',
    configState: fixture.configState,
    existingSessionId: 'phantom-thread',
  });

  conversation.sendMessage('Resume');
  await eventually(() => assert.equal(conversation.hasActiveProcess(), false));
  conversation.sendMessage('Retry');
  await eventually(() => assert.equal(conversation.hasActiveProcess(), false));

  assert.equal(requests.length, 2);
  assert.equal(requests[0].resumeSessionId, 'phantom-thread');
  assert.equal(requests[1].resumeSessionId, undefined);
  assert.equal(conversation.sessionId, 'new-codex-thread');
});

test('unsupported Buddy provider leaves a queued message retryable', () => {
  const fixture = runtimeFixture({ provider: 'gemini' });
  const conversation = new fixture.Conversation({
    done: false,
    id: 'gemini-buddy',
    workingDirectory: '/tmp',
    configState: fixture.configState,
    kind: buddyKind({
      buddyId: 'buddy-1',
      workspaceId: 'workspace-1',
      buddyProjectId: null,
      legacyWorkItemId: null,
      automationRunId: null,
      delegatedByBuddyId: null,
      parentBuddyConversationId: null,
      allowedBuddyOperations: ['read'],
    }),
  });

  assert.equal(conversation.kind.t, 'buddy');
  conversation.enqueueMessage('Hello Buddy');

  assert.equal(conversation.isRunning, false);
  assert.equal(conversation.hasActiveProcess(), false);
  assert.equal(conversation.queue[0]?.status, 'pending');
  assert.match(
    messageText(conversation.messages.at(-1)),
    /cannot start Buddy conversations.*required Buddy state tools/
  );
});

// Owner decision 2026-09-25: a Buddy at its run limit delays a chat/channel turn
// instead of failing it. Before this, the turn threw "Conversation execution
// slot is unavailable" and the channel posted "Couldn't reply".
test('a foreground Buddy turn over capacity waits pending, then starts once admitted', async () => {
  let free = false;
  let providerStarts = 0;
  const abandoned: string[] = [];
  const settlements: unknown[][] = [];
  const executeTurn = fakeExecuteTurn(() => {
    providerStarts += 1;
    return {
      events: (async function* () {
        yield { type: 'turn.started' as const };
        yield { type: 'turn.complete' as const, reason: 'success' as const };
      })(),
      completed: Promise.resolve({
        exitCode: 0,
        signal: null,
        reason: 'success' as const,
        sessionId: 'provider-session',
      }),
      stop: () => undefined,
    };
  });
  const fixture = runtimeFixture({
    buddyContext: { buddyId: 'busy-buddy', workspaceId: 'workspace-1' },
    enqueueBuddyChatRun: () => ({ id: 'queued-turn' }),
    startBuddyChatRun: (runId) =>
      free
        ? {
            kind: 'admitted',
            run: {
              id: runId,
              claim_token: 'claim',
              deadline: new Date(Date.now() + 60_000).toISOString(),
            },
          }
        : { kind: 'waiting', reason: 'Waiting for a run slot: 5 of 5 active.' },
    abandonBuddyChatRun: (runId) => abandoned.push(runId),
    finishBuddyChatRun: async (...args) => {
      settlements.push(args);
    },
    executeTurn,
  });
  const { conversation } = fixture;

  // A direct send (the channel responder's path) lines up in the queue too.
  conversation.sendMessage('Reply in the thread', { origin: 'owner_input', inputId: 'post-1' });
  assert.equal(providerStarts, 0);
  assert.equal(conversation.queue.length, 1);
  assert.equal(conversation.queue[0]?.status, 'pending');
  assert.equal(conversation.isRunning, false);

  free = true;
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.equal(providerStarts, 1, 'the poller starts the turn once its Buddy has a slot');
  assert.deepEqual(abandoned, []);
});

test('stopping a turn that waits for a run slot drops it and releases its place', () => {
  const abandoned: string[] = [];
  const fixture = runtimeFixture({
    buddyContext: { buddyId: 'busy-buddy', workspaceId: 'workspace-1' },
    enqueueBuddyChatRun: () => ({ id: 'queued-turn' }),
    startBuddyChatRun: () => ({ kind: 'waiting', reason: 'full' }),
    abandonBuddyChatRun: (runId) => abandoned.push(runId),
  });
  fixture.conversation.enqueueMessage('Wait for me', { origin: 'owner_input', inputId: 'owner' });
  assert.equal(fixture.conversation.queue.length, 1);
  fixture.conversation.stop();
  assert.equal(fixture.conversation.queue.length, 0);
  assert.deepEqual(abandoned, ['queued-turn'], 'a waiting row left behind would pin the FIFO line');
});

test('waiting Buddy chats share one admission tick, which stops when the last one leaves', () => {
  // Regression guard for 03-app-core.md §5 #2: each waiting conversation used
  // to own a 1 s setInterval into sync SQLite, so N queued chats meant N timers.
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const ticks = new Set<unknown>();
  let cleared = 0;
  globalThis.setInterval = ((handler: () => void, ms?: number) => {
    const timer = realSetInterval(handler, ms);
    if (ms === 1000) ticks.add(timer);
    return timer;
  }) as typeof setInterval;
  globalThis.clearInterval = ((timer: Parameters<typeof clearInterval>[0]) => {
    if (ticks.has(timer)) cleared += 1;
    realClearInterval(timer);
  }) as typeof clearInterval;
  try {
    const waiting = ['a', 'b', 'c'].map((id) => {
      const fixture = runtimeFixture({
        buddyContext: { buddyId: 'busy-buddy', workspaceId: 'workspace-1' },
        enqueueBuddyChatRun: () => ({ id: `queued-${id}` }),
        startBuddyChatRun: () => ({ kind: 'waiting', reason: 'full' }),
        abandonBuddyChatRun: () => undefined,
      });
      fixture.conversation.enqueueMessage('Wait', { origin: 'owner_input', inputId: id });
      return fixture.conversation;
    });
    assert.equal(ticks.size, 1, 'three waiting chats must share one admission timer');
    waiting[0].stop();
    waiting[1].stop();
    assert.equal(cleared, 0, 'the tick must survive while a chat still waits');
    waiting[2].stop();
    assert.equal(cleared, 1, 'the tick must stop once nobody waits');
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
});

test('historical automation transcripts refuse every user turn-admission path', () => {
  let providerStarts = 0;
  const fixture = runtimeFixture({
    executeTurn: fakeExecuteTurn(() => {
      providerStarts += 1;
      throw new Error('must not start');
    }),
  });
  const conversation = new fixture.Conversation({
    done: false,
    id: 'automation-history',
    workingDirectory: '/tmp',
    configState: fixture.configState,
    kind: buddyKind({
      buddyId: 'buddy-1',
      workspaceId: 'workspace-1',
      automationRunId: 'terminal-run',
    }),
  });

  conversation.sendMessage('Continue this completed automation');
  conversation.enqueueMessage('Queue work on this completed automation');
  conversation.interruptAndSend('Interrupt this completed automation');

  assert.equal(providerStarts, 0);
  assert.equal(conversation.hasActiveProcess(), false);
  assert.deepEqual(conversation.queue, []);
  assert.match(messageText(conversation.messages.at(-1)), /automation transcript is read-only/);
});

test('first message in a user fork inherits the native source session without copying history', () => {
  const conversations = new Map<
    string,
    ReturnType<ConversationRuntimeDependencies['getConversation']>
  >();
  const capture = captureSpawns();
  const fixture = runtimeFixture({
    executeTurn: capture.executeTurn,
    getConversation: (id) => conversations.get(id),
  });
  const source = new fixture.Conversation({
    kind: { t: 'chat' },
    done: false,
    id: 'source-conversation',
    workingDirectory: '/tmp',
    configState: fixture.configState,
    existingSessionId: 'source-native-session',
  });
  conversations.set(source.id, source);

  const child = new fixture.Conversation({
    kind: { t: 'chat' },
    done: false,
    id: 'child-conversation',
    workingDirectory: '/tmp',
    configState: fixture.configState,
    resumedFromConversationId: source.id,
  });

  child.enqueueMessage('Continue the original objective from this fork.');
  const spawned = capture.spawns[0];
  capture.release(child);

  assert.deepEqual(spawned, {
    content: 'Continue the original objective from this fork.',
    forkSourceSessionId: 'source-native-session',
  });
  assert.deepEqual(
    child.messages.map((message) => messageText(message)),
    ['Continue the original objective from this fork.']
  );
});

test('native session fork falls back to a fresh handoff when memory generation changes', () => {
  const conversations = new Map<
    string,
    ReturnType<ConversationRuntimeDependencies['getConversation']>
  >();
  const capture = captureSpawns();
  // The Buddy module's current briefing is the child's: memory advanced since the source.
  const fixture = runtimeFixture({
    executeTurn: capture.executeTurn,
    getConversation: (id) => conversations.get(id),
    readCurrentBuddyContext: () => ({ briefing: 'New memory', memoryGeneration: 'generation-7' }),
  });
  const buddyContext = {
    buddyId: 'buddy-1',
    workspaceId: 'workspace-1',
    buddyProjectId: null,
    legacyWorkItemId: null,
    automationRunId: null,
    delegatedByBuddyId: null,
    parentBuddyConversationId: null,
  };
  const source = new fixture.Conversation({
    done: false,
    id: 'source-buddy-conversation',
    workingDirectory: '/tmp',
    configState: fixture.configState,
    existingSessionId: 'source-native-session',
    kind: buddyKind(buddyContext),
    buddyBriefing: 'Old memory',
    buddyMemoryGeneration: 'generation-6',
  });
  conversations.set(source.id, source);

  const child = new fixture.Conversation({
    done: false,
    id: 'child-buddy-conversation',
    workingDirectory: '/tmp',
    configState: fixture.configState,
    resumedFromConversationId: source.id,
    kind: buddyKind(buddyContext),
    buddyBriefing: 'New memory',
    buddyMemoryGeneration: 'generation-7',
  });

  child.enqueueMessage('Continue with current memory.');
  const spawned = capture.spawns[0];
  capture.release(child);

  assert.equal(spawned?.forkSourceSessionId, undefined);
  assert.match(spawned?.content ?? '', /New memory/);
  assert.doesNotMatch(spawned?.content ?? '', /Old memory/);
});

test('same-provider fork on a fork-incapable harness falls back to string handoff', () => {
  const conversations = new Map<
    string,
    ReturnType<ConversationRuntimeDependencies['getConversation']>
  >();
  const capture = captureSpawns();
  const fixture = runtimeFixture({
    executeTurn: capture.executeTurn,
    provider: 'muse',
    getConversation: (id) => conversations.get(id),
  });
  const source = new fixture.Conversation({
    kind: { t: 'chat' },
    done: false,
    id: 'muse-source',
    workingDirectory: '/tmp',
    configState: fixture.configState,
    existingSessionId: 'muse-native-session',
  });
  conversations.set(source.id, source);

  const child = new fixture.Conversation({
    kind: { t: 'chat' },
    done: false,
    id: 'muse-child',
    workingDirectory: '/tmp',
    configState: fixture.configState,
    resumedFromConversationId: source.id,
  });

  child.enqueueMessage('Continue the original objective from this fork.');
  const spawned = capture.spawns[0];
  capture.release(child);

  assert.equal(spawned?.forkSourceSessionId, undefined);
  assert.ok(spawned?.content.includes('Continue the original objective from this fork.'));
  assert.deepEqual(
    child.messages.filter((message) => message.role === 'system').map((m) => messageText(m)),
    []
  );
});

test('every harness receives its resolved effort in one request shape', () => {
  // Guards T08 S2: the request builder used to be three identical per-harness
  // branches plus a cast fallback. A regression here drops a claude/codex/muse
  // effort silently (the provider would run at its own default).
  type Request = Parameters<NonNullable<ConversationRuntimeDependencies['executeTurn']>>[0];
  const expected: Record<Provider, string | undefined> = {
    claude: 'medium',
    codex: 'medium',
    muse: 'medium',
    gemini: undefined,
    opencode: undefined,
    cursor: undefined,
  };
  for (const provider of Object.keys(expected) as Provider[]) {
    const requests: Request[] = [];
    const stub = openTurnStub();
    const { conversation } = runtimeFixture({
      provider,
      executeTurn: fakeExecuteTurn((request) => {
        requests.push(request);
        return stub.turn;
      }),
    });
    conversation.sendMessage('effort probe');
    assert.equal(requests.length, 1, provider);
    const request = requests[0] as Request & { reasoningEffort?: string };
    assert.equal(request.harness, provider);
    assert.equal(request.reasoningEffort, expected[provider], provider);
    assert.equal(request.prompt, 'effort probe');
    conversation.resetProcess();
  }
});

test('a session reset rotates the provider session and re-registers its alias', () => {
  // A stale alias would route the old session's trailing disk writes to this
  // conversation's fresh context.
  const { aliases, conversation } = runtimeFixture();
  conversation.resetProcess();
  assert.equal(conversation.sessionId, 'rotated-session');
  assert.deepEqual(aliases.at(-1), ['rotated-session', 'conversation-id']);
});

test('timer-only heartbeats cannot mask provider idleness, while native advancement can', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const fired: TurnTimeoutKind[] = [];
  const watchdog = new TurnWatchdog(
    { bridgeMs: 2 * 60_000, providerIdleMs: 60 * 60_000, maxRuntimeMs: 24 * 60 * 60_000 },
    (kind) => fired.push(kind)
  );
  watchdog.start(Date.now());

  // Keep the bridge healthy for 59 minutes. One native advancement near the
  // original provider deadline must extend only the provider-progress clock.
  for (let minute = 1; minute <= 59; minute += 1) {
    t.mock.timers.tick(60_000);
    watchdog.note({
      type: 'progress',
      source: 'agent-cli.heartbeat',
      data: { nativeSessionAdvanced: minute === 59, nativeSessionAvailable: true },
    });
  }
  // Continue bridge-only heartbeats until the refreshed one-hour provider
  // deadline. The bridge never stalls, but provider idleness must terminate.
  for (let minute = 1; minute <= 59; minute += 1) {
    t.mock.timers.tick(60_000);
    watchdog.note({ type: 'progress', source: 'agent-cli.heartbeat' });
    assert.deepEqual(fired, [], 'native advancement should extend provider deadline');
  }
  t.mock.timers.tick(60_000);
  assert.deepEqual(fired, ['provider']);
  assert.equal(watchdog.idle().providerIdleSeconds, 3_600);
  watchdog.clear();
});

/**
 * Runs a Claude turn that emits `events`, then only bridge heartbeats (the parent is idle) for up
 * to `minutes`. Returns whether the turn is still running and how often it was stopped.
 */
async function silentClaudeTurn(
  t: { mock: { timers: { tick(ms: number): void } } },
  events: UnifiedAgentEvent[],
  minutes: number
) {
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  const heartbeat: UnifiedAgentEvent = { type: 'progress', source: 'agent-cli.heartbeat' };
  const queued: UnifiedAgentEvent[] = [...events];
  let wake: (() => void) | null = null;
  const stub = openTurnStub();
  const turn = {
    ...stub.turn,
    events: (async function* () {
      for (;;) {
        while (queued.length > 0) yield queued.shift()!;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    })(),
  };
  const { conversation } = runtimeFixture({
    provider: 'claude',
    executeTurn: fakeExecuteTurn(() => turn),
  });
  conversation.sendMessage('start the workers');
  await flush();
  for (let minute = 1; minute <= minutes && conversation.isRunning; minute += 1) {
    t.mock.timers.tick(60_000);
    queued.push(heartbeat);
    (wake as (() => void) | null)?.();
    await flush();
  }
  const outcome = { running: conversation.isRunning, stops: stub.stops() };
  if (outcome.running) conversation.stop();
  return outcome;
}

/**
 * The unified events agent-cli's own Claude parser produces for a recorded claude 2.1.283 turn:
 * one `Agent` launched with run_in_background (its sub-agent runs a foreground Bash, also a
 * Claude task), then that agent's task start and finish.
 */
function recordedBackgroundAgentTurn(): UnifiedAgentEvent[] {
  const parse = createParser('claude');
  return readFileSync(BACKGROUND_AGENT_FIXTURE, 'utf-8')
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line) => parse(JSON.parse(line)));
}

// agent_notes/2026-09-26_claude-p-background-agents-ceiling.md: agent-cli lets `claude -p` wait
// 12 h for its background agents, but the parent is silent meanwhile, so the 60-minute
// provider-idle watchdog killed every such wait. A launch now widens only that clock, by the
// harness's declared wait, and the turn still ends if Claude hangs past it.
test('a Claude turn waiting on a background agent outlives the provider-idle limit', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const run = (launch: UnifiedAgentEvent, minutes: number) =>
    silentClaudeTurn(t, [{ type: 'turn.started' }, launch], minutes);
  const agent = (runInBackground: boolean): UnifiedAgentEvent => ({
    type: 'tool.use',
    name: 'Agent',
    input: { description: 'worker', prompt: 'build it', run_in_background: runInBackground },
  });
  const idleMinutes = 60;
  const waitMinutes = 12 * 60; // agent-cli's CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS default

  const foreground = await run(agent(false), idleMinutes + 1);
  assert.deepEqual(foreground, { running: false, stops: 1 }, 'a plain silent turn still stalls');

  const waiting = await run(agent(true), idleMinutes + 1);
  assert.deepEqual(waiting, { running: true, stops: 0 }, 'the background wait is not a stall');

  const hung = await run(agent(true), waitMinutes + idleMinutes + 1);
  assert.deepEqual(hung, { running: false, stops: 1 }, 'past the declared wait it stalls again');
});

// The widened budget used to last the whole turn: agent-cli's Claude parser dropped the
// task_* lines, so nothing said the agents were done and a turn hung after they finished lived
// 13 h. The finish of the last background task now restores the normal idle limit.
test('a recorded background agent finishing restores the idle limit', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  // Claude flushes every `result` only at exit, so the live stream ends at the last task line.
  const live = recordedBackgroundAgentTurn().filter((event) => event.type !== 'turn.complete');
  const agentFinish = live.findIndex(
    (event) =>
      event.type === 'task.finished' &&
      live.some((e) => e.type === 'task.started' && e.background && e.taskId === event.taskId)
  );
  assert.ok(agentFinish > 0, 'the fixture carries the background agent finishing');

  const stillWorking = await silentClaudeTurn(t, live.slice(0, agentFinish), 61);
  assert.deepEqual(stillWorking, { running: true, stops: 0 }, 'agent still running: waiting');

  const finished = await silentClaudeTurn(t, live, 61);
  assert.deepEqual(finished, { running: false, stops: 1 }, 'agent done: silence is a stall');
});

test('a recorded Claude 2.1 Agent launch becomes a sub-agent', async () => {
  // Claude Code 2.1 names its spawn tool `Agent`; only `Task` was recognised, so 2.1
  // background agents never appeared as sub-agents.
  const { conversation } = await runScriptedTurn('claude', recordedBackgroundAgentTurn());
  assert.deepEqual(
    conversation.subAgents.map((agent) => agent.description),
    ['Run background task and reply']
  );
});

// A background `Agent`'s tool_result ("Async agent launched") returns at once while the agent
// keeps working; only Claude's task_notification (agent-cli `task.finished`) marks its end.
// The row read `completed` from launch on; it now follows the task events.
test('a recorded background agent stays running until its task finishes', async () => {
  const events = recordedBackgroundAgentTurn();
  const statusAfter: string[] = [];
  const { conversation } = runtimeFixture({
    provider: 'claude',
    executeTurn: fakeExecuteTurn(() => ({
      events: (async function* () {
        for (const event of events) {
          yield event;
          statusAfter.push(`${event.type}:${conversation.subAgents[0]?.status ?? 'none'}`);
        }
      })(),
      completed: Promise.resolve({
        exitCode: 0,
        signal: null,
        sessionId: 'scripted-session',
        reason: 'success',
      }),
      stop: () => undefined,
    })),
  });
  conversation.sendMessage('scripted');
  await conversation.waitForTurnDrain();

  const launch = events.findIndex((event) => event.type === 'tool.result');
  const agentStart = events.find(
    (event): event is Extract<UnifiedAgentEvent, { type: 'task.started' }> =>
      event.type === 'task.started' && event.background
  );
  const agentFinish = events.findIndex(
    (event) => event.type === 'task.finished' && event.toolUseId === agentStart?.toolUseId
  );
  assert.equal(statusAfter[launch], 'tool.result:running', 'launch result leaves it running');
  assert.equal(statusAfter[agentFinish - 1], 'tool.result:running', 'still running before');
  assert.equal(statusAfter[agentFinish], 'task.finished:completed', 'its task end completes it');
});

test('bridge watchdog terminates a turn when neither unified events nor heartbeats arrive', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const stub = openTurnStub();
  const { broadcasts, conversation } = runtimeFixture({
    executeTurn: fakeExecuteTurn(() => stub.turn),
  });
  conversation.sendMessage('never answered');
  assert.equal(conversation.isRunning, true);

  t.mock.timers.tick(2 * 60_000);

  assert.equal(conversation.isRunning, false);
  assert.equal(stub.stops(), 1, 'the stalled provider is terminated');
  assert.ok(
    broadcasts.some(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        'body' in message &&
        typeof message.body === 'object' &&
        message.body !== null &&
        'text' in message.body &&
        typeof message.body.text === 'string' &&
        message.body.text.includes('Turn event bridge stalled')
    )
  );
});

// First-turn prompt markers are kind-routed: only buddy_builder threads may
// carry the builder briefing. A buddy (or general) thread must never be
// misclassified into the builder prompt — see 2026-09-07 report where a
// Product Development Lead thread rendered the buddy-builder briefing.
// Driven through the runtime, so this checks the prompt the provider receives.
test('first-turn markers are kind-exclusive: builder, buddy, general', async () => {
  const capture = captureSpawns();
  const fixture = runtimeFixture({
    executeTurn: capture.executeTurn,
    readCurrentBuddyContext: () => ({ briefing: 'PRIVATE BRIEFING', memoryGeneration: '7' }),
  });
  const firstPrompt = async (kind: ConversationOptions['kind'], id: string) => {
    const conversation = new fixture.Conversation({
      done: false,
      id,
      workingDirectory: '/tmp',
      configState: fixture.configState,
      kind,
      swarmDebugPrefix: 'SWARM DEBUG',
    });
    const before = capture.spawns.length;
    conversation.sendMessage('Lets make some updates', { origin: 'owner_input', inputId: id });
    await eventually(() => assert.equal(capture.spawns.length, before + 1));
    capture.release(conversation);
    return capture.spawns[before].content;
  };

  const builder = await firstPrompt({ t: 'builder' }, 'builder-thread');
  assert.match(builder, /unleashd:buddy-builder-v1/);
  assert.doesNotMatch(builder, /unleashd:buddy-context-v2/);
  // The Builder hires into the conversation directory. Slack New Buddy sets that to the workspace.
  assert.match(builder, /Working directory: \/tmp\n/);
  assert.match(builder, /Hire into the workspace with that root path/);

  // The hidden briefing is injected once, with its memory generation, and never the swarm prefix.
  const buddy = await firstPrompt(
    buddyKind({ buddyId: 'buddy-1', workspaceId: 'workspace-1' }),
    'buddy-thread'
  );
  assert.match(buddy, /^<!-- unleashd:buddy-context-v2 /);
  assert.equal(buddy.match(/PRIVATE BRIEFING/g)?.length, 1);
  assert.match(
    buddy,
    new RegExp(`buddy-memory-generation ${Buffer.from('7').toString('base64url')} `)
  );
  assert.doesNotMatch(buddy, /unleashd:buddy-builder-v1|unleashd:swarm-prefix/);
  assert.match(buddy, /\n\nLets make some updates$/);

  const general = await firstPrompt({ t: 'chat' }, 'general-thread');
  assert.doesNotMatch(general, /unleashd:buddy-builder-v1/);
  assert.doesNotMatch(general, /unleashd:buddy-context-v2/);
  assert.match(general, /unleashd:swarm-prefix/);
});

test('foreground Buddy deadline uses the conversation budget and reports timeout after joined drain', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const completed = deferred<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    sessionId: string;
    reason: 'killed';
  }>();
  const stopped = deferred<void>();
  const terminals: Parameters<
    NonNullable<ConversationRuntimeDependencies['turnAttempts']>['terminal']
  >[0][] = [];
  const settlements: Parameters<BuddyPolicyPort['settle']>[] = [];
  let release = false;
  const fixture = runtimeFixture({
    enqueueBuddyChatRun: () => ({ id: 'owned-run' }),
    // The run's lease is the chat's deadline (the runner leases for TURN_MAX_RUNTIME_MS; guard in
    // buddies-v2.test.ts). A short lease exercises the same callback without waiting a day.
    startBuddyChatRun: () => {
      return {
        kind: 'admitted',
        run: {
          id: 'owned-run',
          claim_token: 'private-fixture-token',
          deadline: new Date(Date.now() + 1000).toISOString(),
        },
      };
    },
    finishBuddyChatRun: async (...args) => {
      settlements.push(args);
    },
    turnAttempts: {
      queued: () => {},
      starting: () => {},
      running: () => {},
      stopping: () => {},
      activity: () => {},
      bindProviderSession: () => {},
      terminal: (result) => terminals.push(result),
    },
    executeTurn: fakeExecuteTurn(() => ({
      events: (async function* () {
        yield { type: 'turn.started' as const };
        yield { type: 'text.delta' as const, text: 'Still working' };
        await stopped.promise;
        yield { type: 'turn.complete' as const, reason: 'killed' as const };
      })(),
      completed: completed.promise,
      stop: () => {
        release = true;
      },
    })),
  });
  const conversation = new fixture.Conversation({
    done: false,
    id: 'foreground-timeout',
    workingDirectory: '/tmp',
    configState: fixture.configState,
    kind: buddyKind({ buddyId: 'buddy-fixture', workspaceId: 'workspace-fixture' }),
  });
  conversation.sendMessage('Keep working');
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(1000);
  assert.equal(release, true);
  assert.equal(terminals.at(-1)?.terminalCause, 'max_runtime_timeout');
  assert.equal(terminals.at(-1)?.state, 'failed');
  assert.equal(conversation.hasActiveProcess(), true);
  assert.equal(settlements.length, 0, 'ownership must wait for process and event drain');
  stopped.resolve();
  completed.resolve({
    exitCode: null,
    signal: 'SIGTERM',
    sessionId: 'provider-session',
    reason: 'killed',
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(conversation.hasActiveProcess(), false);
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0][2].t, 'failed');
  assert.match(JSON.stringify(settlements[0][2]), /maximum runtime/);
});

test('background deadline uses timeout classification and waits for provider drain', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  const completed = deferred<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    sessionId: string;
    reason: 'killed';
  }>();
  const stopped = deferred<void>();
  const terminals: Parameters<
    NonNullable<ConversationRuntimeDependencies['turnAttempts']>['terminal']
  >[0][] = [];
  const settlements: Parameters<BuddyPolicyPort['finishRun']>[] = [];
  let release = false;
  const fixture = runtimeFixture({
    // The runner-owned run settles through the same port call live and adopted (finishRun).
    finishBuddyRun: async (...args) => {
      settlements.push(args);
    },
    turnAttempts: {
      queued: () => {},
      starting: () => {},
      running: () => {},
      stopping: () => {},
      activity: () => {},
      bindProviderSession: () => {},
      terminal: (result) => terminals.push(result),
    },
    executeTurn: fakeExecuteTurn(() => ({
      events: (async function* () {
        yield { type: 'turn.started' as const };
        yield { type: 'text.delta' as const, text: 'Still working' };
        await stopped.promise;
        yield { type: 'turn.complete' as const, reason: 'killed' as const };
      })(),
      completed: completed.promise,
      stop: () => {
        release = true;
      },
    })),
  });
  const conversation = new fixture.Conversation({
    done: false,
    id: 'foreground-timeout',
    workingDirectory: '/tmp',
    configState: fixture.configState,
    kind: buddyKind({ buddyId: 'buddy-fixture', workspaceId: 'workspace-fixture' }, 'background'),
  });
  const execution = conversation.runCoordinationMessage(
    'Keep working',
    { buddyId: 'buddy-fixture', workspaceId: 'workspace-fixture', coordinationRunId: 'worker-run' },
    'worker-token',
    // The run's deadline is armed by the policy (it used to be a server.ts timer that no
    // adopting backend could re-arm).
    new Date(Date.now() + 1000).toISOString()
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(1000);
  assert.equal(release, true);
  assert.equal(terminals.at(-1)?.terminalCause, 'max_runtime_timeout');
  assert.equal(terminals.at(-1)?.state, 'failed');
  assert.equal(conversation.hasActiveProcess(), true);
  assert.equal(settlements.length, 0, 'ownership must wait for process and event drain');
  stopped.resolve();
  completed.resolve({
    exitCode: null,
    signal: 'SIGTERM',
    sessionId: 'provider-session',
    reason: 'killed',
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(conversation.hasActiveProcess(), false);
  assert.equal(settlements.length, 1);
  await execution;
  assert.deepEqual(settlements[0].slice(0, 2), ['worker-run', 'worker-token']);
  const outcome = settlements[0][2];
  assert.equal(outcome.t === 'failed' && outcome.cause, 'max_runtime_timeout');
  assert.match(JSON.stringify(outcome), /maximum runtime/);
});

function openTurnStub() {
  let stops = 0;
  const turn = {
    // No events on purpose: a post-stop turn.started would re-arm the bridge
    // watchdog on the dead turn and stall test exit for the full timeout.
    events: (async function* () {
      await new Promise<never>(() => {});
    })(),
    completed: new Promise<never>(() => {}),
    stop: () => {
      stops += 1;
    },
  };
  return { turn, stops: () => stops };
}

function runningFixture() {
  const opened: Array<ReturnType<typeof openTurnStub>> = [];
  const fixture = runtimeFixture({
    executeTurn: fakeExecuteTurn(() => {
      const stub = openTurnStub();
      opened.push(stub);
      return stub.turn;
    }),
  });
  return { ...fixture, opened };
}

test('interrupt keeps the pending queue and sends the new message first', () => {
  // Regression guard (2026-09-19): interrupt_and_send used to flush every
  // pending queued message, so interrupting silently discarded work the user
  // had queued. Interrupt stops the turn, not the queue — the in-flight head
  // is retired with the killed turn and the new message goes first.
  const { conversation, broadcasts, opened } = runningFixture();
  conversation.enqueueMessage('First');
  conversation.enqueueMessage('Second');
  assert.equal(conversation.queue.length, 2);
  assert.equal(conversation.queue[0]?.status, 'sending');
  assert.equal(conversation.queue[1]?.status, 'pending');

  conversation.interruptAndSend('Urgent');

  assert.equal(opened[0]?.stops(), 1);
  assert.deepEqual(
    conversation.queue.map((m) => [m.content, m.status]),
    [
      ['Urgent', 'pending'],
      ['Second', 'pending'],
    ]
  );
  const lastQueue = [...broadcasts]
    .reverse()
    .find(
      (m) =>
        (m as { type?: string }).type === 'patch' &&
        (m as { patch: { t: string } }).patch.t === 'queue'
    ) as { patch: { queue: Array<{ content: string }> } } | undefined;
  assert.deepEqual(
    lastQueue?.patch.queue.map((m) => m.content),
    ['Urgent', 'Second']
  );
});

test('interrupt with no active turn sends ahead of the queue', () => {
  const fixture = runtimeFixture();
  fixture.conversation.isRunning = true;
  fixture.conversation.enqueueMessage('First');
  fixture.conversation.enqueueMessage('Second');

  fixture.conversation.interruptAndSend('Urgent');

  assert.deepEqual(
    fixture.conversation.queue.map((m) => [m.content, m.status]),
    [
      ['Urgent', 'pending'],
      ['First', 'pending'],
      ['Second', 'pending'],
    ]
  );
  fixture.conversation.clearQueue();
  fixture.conversation.isRunning = false;
});

test('promote moves a pending message first and interrupts the turn', () => {
  const { conversation, opened } = runningFixture();
  conversation.enqueueMessage('First');
  conversation.enqueueMessage('Second');
  conversation.enqueueMessage('Third');
  const thirdId = conversation.queue[2]?.id;
  assert.ok(thirdId);

  conversation.promoteQueuedMessage(thirdId);

  assert.equal(opened[0]?.stops(), 1);
  assert.deepEqual(
    conversation.queue.map((m) => [m.content, m.status]),
    [
      ['Third', 'pending'],
      ['Second', 'pending'],
    ]
  );

  // Unknown or non-pending ids are a no-op, like cancelQueuedMessage.
  conversation.promoteQueuedMessage('missing-id');
  assert.equal(conversation.queue.length, 2);
});

type ScriptedEvent = import('@nbardy/agent-cli').UnifiedAgentEvent;

/** Run one real turn whose provider stream is `events`, and wait for it to drain. */
async function runScriptedTurn(provider: Provider, events: ScriptedEvent[]) {
  const { conversation, broadcasts } = runtimeFixture({
    provider,
    executeTurn: fakeExecuteTurn(() => ({
      events: (async function* () {
        yield* events;
      })(),
      completed: Promise.resolve({
        exitCode: 0,
        signal: null,
        sessionId: 'scripted-session',
        reason: 'success',
      }),
      stop: () => undefined,
    })),
  });
  conversation.sendMessage('scripted');
  await conversation.waitForTurnDrain();
  return { conversation, broadcasts };
}

/** Real provider records enter through the same parser as executeTurn. */
function codexCollab(
  tool: string,
  phase: 'started' | 'completed',
  extra: Record<string, unknown>
): UnifiedAgentEvent[] {
  return createParser('codex')({
    type: `item.${phase}`,
    item: { type: 'collab_tool_call', tool, sender_thread_id: 'parent', ...extra },
  });
}

test('codex collab threads become native sub-agents that parent completion leaves alone', async () => {
  // Exercise the parser, not a second hand-written tool.use contract: the runtime
  // must consume canonical child states and publish exactly one patch per observation.
  const { conversation, broadcasts } = await runScriptedTurn('codex', [
    { type: 'turn.started' },
    ...codexCollab('spawn_agent', 'started', { prompt: 'Write file_1.md' }),
    ...codexCollab('spawn_agent', 'completed', {
      prompt: 'Write file_1.md',
      receiver_thread_ids: ['child-1'],
      agents_states: { 'child-1': { status: 'pending_init', message: null } },
    }),
    ...codexCollab('wait', 'completed', {
      receiver_thread_ids: ['child-1'],
      agents_states: { 'child-1': { status: 'completed', message: 'test-confirmed' } },
    }),
    ...codexCollab('spawn_agent', 'completed', {
      prompt: 'Second child',
      receiver_thread_ids: ['child-2'],
      agents_states: { 'child-2': { status: 'pending_init', message: null } },
    }),
    { type: 'text.delta', text: 'SUBAGENTS_OK' },
    { type: 'turn.complete', reason: 'success' },
  ]);
  const byId = new Map(conversation.subAgents.map((agent) => [agent.id, agent]));
  assert.deepEqual(
    [...byId.keys()],
    ['child-1', 'child-2'],
    'one row per collab child, no generic spawn row'
  );
  assert.equal(byId.get('child-1')?.description, '[Codex Agent] Write file_1.md');
  assert.equal(byId.get('child-1')?.status, 'completed');
  assert.equal(byId.get('child-1')?.statusSource, 'native');
  assert.equal(byId.get('child-1')?.toolUses, 1);
  assert.equal(byId.get('child-1')?.currentAction, 'Done');
  assert.equal(byId.get('child-2')?.status, 'pending', 'parent completion must not settle it');
  assert.equal(byId.get('child-2')?.completedAt, undefined);
  assert.ok(byId.get('child-1')?.completedAt instanceof Date);
  const patches = broadcasts.filter(
    (message) => (message as { patch?: { t: string } }).patch?.t === 'subagent'
  );
  assert.equal(patches.length, 3, 'one patch per normalized child observation');
  const completed = new Set(
    broadcasts.flatMap((message) => {
      const patch = message as {
        type?: string;
        patch?: { t: string; subAgent?: { id: string; status: string } };
      };
      return patch.type === 'patch' &&
        patch.patch?.t === 'subagent' &&
        patch.patch.subAgent?.status === 'completed'
        ? [patch.patch.subAgent.id]
        : [];
    })
  );
  assert.deepEqual([...completed], ['child-1']);
  const assistant = conversation.messages.filter((message) => message.role === 'assistant');
  const visible = assistant.map(messageText).join('\n');
  assert.match(visible, /SUBAGENTS_OK/);
  assert.equal((visible.match(/spawn_agent/g) ?? []).length, 1);
  assert.doesNotMatch(visible, /\bwait\b/);
});

test('a childless Codex collab completion keeps one visible attempt and no child', async () => {
  const started = codexCollab('spawn_agent', 'started', {
    id: 'failed-spawn',
    prompt: 'Inspect the files',
  });
  const completed = codexCollab('spawn_agent', 'completed', {
    id: 'failed-spawn',
    prompt: 'Inspect the files',
    status: 'failed',
  });
  assert.equal(started[0]?.type, 'tool.use');
  assert.equal(completed[0]?.type, 'tool.use', 'the no-tools gate still observes completion');
  if (started[0]?.type === 'tool.use' && completed[0]?.type === 'tool.use') {
    assert.equal(started[0].phase, 'started');
    assert.equal(completed[0].phase, 'completed');
  }
  const { conversation } = await runScriptedTurn('codex', [
    { type: 'turn.started' },
    ...started,
    ...completed,
    { type: 'turn.complete', reason: 'success' },
  ]);
  const assistant = conversation.messages.filter((message) => message.role === 'assistant');
  assert.equal(
    assistant
      .flatMap((message) => (message.body.t === 'parts' ? message.body.parts : []))
      .filter((part) => part.t === 'tool' && part.name === 'spawn_agent').length,
    1
  );
  assert.equal(conversation.subAgents.length, 0);
});

test('native sub-agent operations are applied once and follow-ups can reopen a child', async () => {
  const observation = (id: string, tool: string, status: string) =>
    codexCollab(tool, 'completed', {
      id,
      prompt: 'Child work',
      receiver_thread_ids: ['child', 'other'],
      agents_states: { child: { status }, other: { status: 'failed' } },
    });
  const spawn = observation('spawn', 'spawn_agent', 'in_progress');
  const done = observation('done', 'wait', 'completed');
  const reopen = observation('follow-up', 'send_input', 'in_progress');
  const { conversation, broadcasts } = await runScriptedTurn('codex', [
    ...spawn,
    // A parent's command is not a child interaction, even when a child is running.
    ...createParser('codex')({
      type: 'item.started',
      item: { type: 'command_execution', command: 'pwd' },
    }),
    ...done,
    ...spawn,
    ...done,
    ...reopen,
    ...reopen,
    { type: 'turn.complete', reason: 'success' },
  ]);
  const [agent] = conversation.subAgents;
  assert.equal(conversation.subAgents.length, 2);
  assert.equal(agent.description, '[Codex Agent] Child work');
  assert.equal(
    agent.status,
    'running',
    'parent completion leaves the reopened native child running'
  );
  assert.equal(agent.currentAction, 'Sending follow-up');
  assert.equal(agent.completedAt, undefined, 'a running child has no terminal timestamp');
  assert.equal(agent.toolUses, 2, 'one wait and one follow-up, no replay or parent tools');
  const other = conversation.subAgents[1];
  assert.equal(other.toolUses, 2, 'the same operation observes each child independently');
  assert.equal(other.status, 'error');
  assert.equal(other.currentAction, 'Error');
  assert.ok(other.completedAt instanceof Date);
  assert.equal(
    broadcasts.filter((message) => (message as { patch?: { t: string } }).patch?.t === 'subagent')
      .length,
    6
  );
});

test('a Task tool starts a generic sub-agent that parent completion settles', async () => {
  const { conversation } = await runScriptedTurn('claude', [
    { type: 'turn.started' },
    {
      type: 'tool.use',
      name: 'Task',
      input: { description: 'Explore', subagent_type: 'scout', _blockId: 'block-1' },
    },
    { type: 'tool.use', name: 'Read', input: { file_path: '/repo/src/a.ts' } },
    { type: 'turn.complete', reason: 'success' },
  ]);
  const [agent] = conversation.subAgents;
  assert.equal(conversation.subAgents.length, 1);
  assert.equal(agent.id, 'block-1');
  assert.equal(agent.description, '[scout] Explore');
  assert.equal(agent.toolUses, 1);
  assert.equal(agent.status, 'completed');
  assert.equal(agent.statusSource, 'inferred_parent_completion');
});

// Regression: a provider binary absent from PATH showed an empty Buddy DM bubble; `spawn codex
// ENOENT` reached only the server log (fresh-install trial 2026-10-05). Real executeTurn and journal, PATH without the CLI (sh exits 127, never spawn ENOENT).
test('a missing provider binary settles the turn with a visible system message naming it', async () => {
  const saved = process.env.PATH;
  // System dirs only: the journal's /bin/sh wrapper itself needs coreutils, but no agent CLI.
  process.env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  try {
    // The in-memory notice is gone after a backend restart; the attempt journal is what the DM
    // rebuilds the message from, so a missing command must be journaled as spawn_failed.
    const terminals: { terminalCause: string }[] = [];
    const fixture = runtimeFixture({
      turnAttempts: {
        queued: () => {},
        starting: () => {},
        running: () => {},
        stopping: () => {},
        activity: () => {},
        bindProviderSession: () => {},
        terminal: (result) => terminals.push(result),
      },
    });
    let failure = '';
    fixture.conversation.once('buddy-turn-failed', (reason: string) => {
      failure = reason;
    });
    fixture.conversation.sendMessage('hi');
    await eventually(() => assert.notEqual(failure, ''));
    const notices = fixture.conversation.messages.filter((m) => m.role === 'system');
    assert.equal(notices.length, 1, 'one notice, not one per error channel');
    const text = messageText(notices[0]);
    assert.match(text, /codex/);
    assert.match(text, /Setup/);
    assert.equal(failure, text);
    assert.deepEqual(
      terminals.map((t) => t.terminalCause),
      ['spawn_failed']
    );
  } finally {
    process.env.PATH = saved;
  }
});
