import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { PROTOCOL_VERSION, WS_PATH, buddyKind } from '@unleashd/shared';
import { createDefaultConversationConfig } from '@unleashd/shared';
import type { BuddyContext } from '@unleashd/shared';
import { type ConversationOptions, createConversationRuntime } from '../src/conversations/runtime';
import { resolveConfigAgainstProviderCatalog } from '../src/providers/catalog-service';
import { registerConversationWebSocket } from '../src/transport/conversation-websocket';
import { fakeBuddyPort } from './fixtures/buddy-port';
import { testExecutions } from './fixtures/fake-turn';

const buddyContext: BuddyContext = {
  buddyId: 'buddy-1',
  workspaceId: 'workspace-1',
  buddyProjectId: null,
};

function runtimeFixture() {
  const broadcasts: unknown[] = [];
  const config = createDefaultConversationConfig('codex');
  const Conversation = createConversationRuntime({
    executions: testExecutions(),
    broadcast: (message) => broadcasts.push(message),
    registerSessionAlias: () => undefined,
    unregisterSessionAlias: () => undefined,
    clearExternalRunningStatus: () => undefined,
    clearLocalCompletionSuppression: () => undefined,
    markLocalCompletionSuppression: () => undefined,
    persistCurrentSession: async () => undefined,
    buddies: fakeBuddyPort(),
    getConversation: () => undefined,
    readLatestOompaRuntime: async () => ({
      available: false,
      run: null,
      reason: 'No Oompa runtime',
    }),
    createSessionId: () => 'rotated-session',
  });
  return {
    broadcasts,
    config,
    Conversation,
    configState: {
      config,
      revision: 0,
      resolution: resolveConfigAgainstProviderCatalog(config),
    },
  };
}

test('empty Buddy conversation construction is inert and drops a swarm debug prefix', () => {
  const fixture = runtimeFixture();
  const conversation = new fixture.Conversation({
    done: false,
    id: 'buddy-conversation',
    workingDirectory: '/tmp',
    configState: fixture.configState,
    kind: buddyKind(buddyContext),
    buddyBriefing: 'Private Buddy briefing',
    swarmDebugPrefix: 'SWARM DEBUG',
  });

  assert.equal(conversation.isRunning, false);
  assert.equal(conversation.process, null);
  assert.deepEqual(conversation.messages, []);
  assert.deepEqual(fixture.broadcasts, []);
  assert.deepEqual(conversation.buddyContext, buddyContext);
  assert.equal(conversation.swarmDebugPrefix, null);
});

test('empty Buddy WebSocket creation resolves and registers without sending a provider turn', async () => {
  const fixture = runtimeFixture();
  const conversations = new Map<string, InstanceType<typeof fixture.Conversation>>();
  const transportBroadcasts: unknown[] = [];
  let initialDispatches = 0;
  let runtimeCreations = 0;
  let conversationLinks = 0;
  let buddyCancellations = 0;
  let acceptsCommands = false;
  let finishInitialLoad!: () => void;
  const initialLoadComplete = new Promise<void>((resolve) => {
    finishInitialLoad = resolve;
  });
  class FakeSocket extends EventEmitter {
    readyState = 1;
    sent: string[] = [];
    send(payload: string): void {
      this.sent.push(payload);
    }
  }
  const webSocketServer = new EventEmitter();
  registerConversationWebSocket(
    webSocketServer as never,
    {
      listedRows: () => [],
      materialize: async () => undefined,
      forgetListed: () => undefined,
      registry: {
        get: (id: string) => conversations.get(id),
        set: (conversation: InstanceType<typeof fixture.Conversation>) => {
          conversations.set(conversation.id, conversation);
        },
        delete: (id: string) => conversations.delete(id),
        values: () => conversations.values(),
        keys: () => conversations.keys(),
      },
      sessions: {
        markDeleted: () => undefined,
        aliasEntries: () => [][Symbol.iterator](),
        unregisterConversationAliases: () => undefined,
      },
      externalActivity: { clear: () => undefined, has: () => false },
      completionSuppression: { clear: () => undefined },
      initialLoadComplete,
      isInitialLoadComplete: () => acceptsCommands,
      beginCommand: () => () => undefined,
      configService: {
        getRecord: async (id: string) => (conversations.has(id) ? { status: 'active' } : null),
        delete: async () => true,
        createOrReplay: async (input: {
          conversationId: string;
          config: typeof fixture.config;
          workingDirectory: string;
          kind: unknown;
        }) => ({
          record: { workingDirectory: input.workingDirectory, kind: input.kind },
          state: {
            config: input.config,
            revision: 0,
            resolution: resolveConfigAgainstProviderCatalog(input.config),
          },
        }),
      },
      getDefaultWorkingDirectory: () => '/tmp',
      resolveWorkingDirectory: (directory: string) => directory,
      resolveBuddyConversation: async () => ({
        context: buddyContext,
        briefing: 'PRIVATE BRIEFING',
        workingDirectory: '/tmp',
        provider: 'codex',
      }),
      createConversation: (options: ConversationOptions) => {
        runtimeCreations += 1;
        return new fixture.Conversation(options);
      },
      createConversationLink: async () => {
        conversationLinks += 1;
      },
      cancelBuddyConversation: () => {
        buddyCancellations += 1;
      },
      dispatchInitialMessage: async () => {
        initialDispatches += 1;
      },
      broadcast: (message: unknown) => transportBroadcasts.push(message),
      broadcastExcept: (_socket: unknown, message: unknown) => transportBroadcasts.push(message),
      logger: { log: () => undefined, error: () => undefined },
    } as never
  );

  const socket = new FakeSocket();
  webSocketServer.emit('connection', socket, { url: WS_PATH });
  assert.deepEqual(JSON.parse(socket.sent[0]), {
    type: 'hello',
    protocol: { version: PROTOCOL_VERSION },
    defaultCwd: '/tmp',
    loading: true,
    archivedBuddyIds: [],
    cwds: [],
    buddies: [],
    rows: [],
  });
  socket.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        type: 'create_conversation',
        commandId: 'create-empty-buddy',
        conversationId: '00000000-0000-4000-8000-000000000123',
        workingDirectory: '/tmp',
        config: fixture.config,
        kind: { t: 'buddy', context: buddyContext },
      })
    )
  );
  socket.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        type: 'create_conversation',
        commandId: 'create-empty-buddy',
        conversationId: '00000000-0000-4000-8000-000000000123',
        workingDirectory: '/tmp',
        config: fixture.config,
        kind: { t: 'buddy', context: buddyContext },
      })
    )
  );
  await new Promise((resolve) => setImmediate(resolve));

  const conversation = conversations.get('00000000-0000-4000-8000-000000000123');
  assert.ok(conversation);
  assert.equal(runtimeCreations, 1);
  assert.equal(conversationLinks, 1);
  assert.equal(initialDispatches, 2, 'both replay callers check durable initial delivery');
  assert.equal(conversation.isRunning, false);
  assert.equal(conversation.process, null);
  assert.deepEqual(conversation.messages, []);
  assert.equal(
    fixture.broadcasts.some((message) => (message as { type?: string }).type === 'message'),
    false
  );
  finishInitialLoad();
  acceptsCommands = true;
  socket.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        type: 'delete_conversation',
        conversationId: '00000000-0000-4000-8000-000000000123',
      })
    )
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(buddyCancellations, 1);
  assert.equal(conversations.has('00000000-0000-4000-8000-000000000123'), false);
});

test('existing hydrated Buddy messages repair the durable link before admission', async () => {
  const calls: string[] = [];
  const conversation = {
    id: '00000000-0000-4000-8000-000000000456',
    sessionId: 'provider-session',
    provider: 'codex',
    buddyContext,
    kind: buddyKind(buddyContext),
    sendMessage: () => calls.push('send'),
    enqueueMessage: () => calls.push('queue'),
    interruptAndSend: () => calls.push('interrupt'),
    promoteQueuedMessage: (messageId: string) => calls.push(`promote:${messageId}`),
    configState: () => ({ config: {}, revision: 0, resolution: { status: 'resolved' } }),
  };
  class FakeSocket extends EventEmitter {
    readyState = 1;
    sent: string[] = [];
    send(payload: string): void {
      this.sent.push(payload);
    }
  }
  const webSocketServer = new EventEmitter();
  const registry = new Map([[conversation.id, conversation]]);
  registerConversationWebSocket(
    webSocketServer as never,
    {
      listedRows: () => [],
      materialize: async () => undefined,
      forgetListed: () => undefined,
      registry: {
        get: (id: string) => registry.get(id),
        set: (value: typeof conversation) => registry.set(value.id, value),
        delete: (id: string) => registry.delete(id),
        values: () => registry.values(),
        keys: () => registry.keys(),
      },
      sessions: {
        markDeleted: () => undefined,
        aliasEntries: () => [][Symbol.iterator](),
        unregisterConversationAliases: () => undefined,
      },
      externalActivity: { clear: () => undefined, has: () => false },
      completionSuppression: { clear: () => undefined },
      initialLoadComplete: Promise.resolve(),
      isInitialLoadComplete: () => true,
      beginCommand: () => () => undefined,
      configService: {
        getRecord: async () => ({ status: 'active' }),
      },
      getDefaultWorkingDirectory: () => '/tmp',
      resolveWorkingDirectory: (directory: string) => directory,
      resolveBuddyConversation: async () => ({
        context: buddyContext,
        briefing: 'briefing',
        workingDirectory: '/tmp',
        provider: 'codex',
      }),
      createConversation: () => conversation,
      createConversationLink: async () => {
        calls.push('link');
      },
      isBuddyArchived: async () => false,
      cancelBuddyConversation: () => undefined,
      dispatchInitialMessage: async () => undefined,
      broadcast: () => undefined,
      broadcastExcept: () => undefined,
      logger: { log: () => undefined, error: () => undefined },
    } as never
  );
  const socket = new FakeSocket();
  webSocketServer.emit('connection', socket, { url: WS_PATH });

  for (const [type, commandId, messageId] of [
    ['queue_message', 'queue-command', undefined],
    ['interrupt_and_send', 'interrupt-command', undefined],
    ['promote_queued_message', undefined, 'queued-1'],
  ] as const) {
    socket.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type,
          ...(commandId ? { commandId } : {}),
          ...(messageId ? { messageId } : { content: type }),
          conversationId: conversation.id,
        })
      )
    );
    await new Promise((resolve) => setImmediate(resolve));
  }

  assert.deepEqual(calls, ['link', 'queue', 'interrupt', 'promote:queued-1']);
});

test('replaying create_conversation reports the real failure, not a config mismatch', async () => {
  // Regression guard (2026-09-06). The replay path's catch answered every
  // failure with "Conversation ID already exists with different configuration".
  // dispatchInitialMessage rethrows Buddy-authority rejections, so an inactive
  // Buddy read to the user as a config mismatch — right after conversation_created.
  // Deleting this test lets that misattribution return silently: the happy-path
  // test above never makes dispatch throw.
  const fixture = runtimeFixture();
  const conversationId = '00000000-0000-4000-8000-000000000456';
  const existing = new fixture.Conversation({
    done: false,
    id: conversationId,
    workingDirectory: '/tmp',
    configState: fixture.configState,
    kind: buddyKind(buddyContext),
  });
  const conversations = new Map([[conversationId, existing]]);
  const rejectionText = 'Buddy authority rejected the initial message: buddy is inactive';
  class FakeSocket extends EventEmitter {
    readyState = 1;
    sent: string[] = [];
    send(payload: string): void {
      this.sent.push(payload);
    }
  }
  const webSocketServer = new EventEmitter();
  registerConversationWebSocket(
    webSocketServer as never,
    {
      listedRows: () => [],
      materialize: async () => undefined,
      forgetListed: () => undefined,
      registry: {
        get: (id: string) => conversations.get(id),
        set: () => undefined,
        delete: (id: string) => conversations.delete(id),
        values: () => conversations.values(),
        keys: () => conversations.keys(),
      },
      sessions: {
        markDeleted: () => undefined,
        aliasEntries: () => [][Symbol.iterator](),
        unregisterConversationAliases: () => undefined,
      },
      externalActivity: { clear: () => undefined, has: () => false },
      completionSuppression: { clear: () => undefined },
      initialLoadComplete: Promise.resolve(),
      isInitialLoadComplete: () => true,
      beginCommand: () => () => undefined,
      configService: {
        getRecord: async (id: string) => (conversations.has(id) ? { status: 'active' } : null),
        delete: async () => true,
        // A matching replay: createOrReplay succeeds, so the only thing left
        // to throw inside that try is dispatchInitialMessage.
        createOrReplay: async () => ({ record: { workingDirectory: '/tmp' }, replayed: true }),
      },
      getDefaultWorkingDirectory: () => '/tmp',
      resolveWorkingDirectory: (directory: string) => directory,
      resolveBuddyConversation: async () => ({
        context: buddyContext,
        briefing: 'PRIVATE BRIEFING',
        workingDirectory: '/tmp',
        provider: 'codex',
      }),
      createConversation: () => existing,
      createConversationLink: async () => undefined,
      cancelBuddyConversation: () => undefined,
      dispatchInitialMessage: async () => {
        throw new Error(rejectionText);
      },
      broadcast: () => undefined,
      broadcastExcept: () => undefined,
      logger: { log: () => undefined, error: () => undefined },
    } as never
  );

  const socket = new FakeSocket();
  webSocketServer.emit('connection', socket, { url: WS_PATH });
  socket.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        type: 'create_conversation',
        commandId: 'replay-existing',
        conversationId,
        workingDirectory: '/tmp',
        config: fixture.config,
        kind: { t: 'buddy', context: buddyContext },
      })
    )
  );
  await new Promise((resolve) => setImmediate(resolve));

  const acks = socket.sent
    .map(
      (payload) =>
        JSON.parse(payload) as { type: string; result?: { t: string; error?: { message: string } } }
    )
    .filter((message) => message.type === 'ack');
  const rejected = acks.find((message) => message.result?.t === 'rejected');
  assert.ok(rejected, 'a replay failure must surface as a rejected ack');
  assert.equal(rejected.result?.error?.message, rejectionText);
  assert.ok(
    acks.some((message) => message.result?.t === 'created'),
    'the replay still acknowledges the existing conversation before dispatch runs'
  );
});
