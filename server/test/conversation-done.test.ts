import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { type ServerMessage, WS_PATH, createDefaultConversationConfig } from '@unleashd/shared';
import { ConversationConfigService } from '../src/conversations/config-service';
import { createConversationRuntime } from '../src/conversations/runtime';
import { resolveConfigAgainstProviderCatalog } from '../src/providers/catalog-service';
import { registerConversationWebSocket } from '../src/transport/conversation-websocket';
import { fakeBuddyPort } from './fixtures/buddy-port';
import { testExecutions } from './fixtures/fake-turn';
import { recordStore } from './fixtures/records';

const CONVERSATION_ID = '00000000-0000-4000-8000-0000000000d1';

function configLayer(root: string) {
  const store = recordStore(root);
  const service = new ConversationConfigService({
    store,
    resolver: { resolve: async (config) => resolveConfigAgainstProviderCatalog(config) },
  });
  return { store, service };
}

// Regression, 2026-09-23: hidden conversations reappeared after refreshes and
// server restarts. Hides lived in a client-synced list keyed by
// `sessionId ?? id`; the server rotates sessionId (Codex session.started,
// reset, resume), so a rotation orphaned the hide. Done now lives on the
// record under the stable conversationId. This drives the real WebSocket
// command into a real record store, rotates the provider session, reopens the
// store as a restart would, and requires the hide to hold — then unhides.
test('a hide set over the WebSocket survives session rotation and a restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'conversation-done-'));
  try {
    const config = createDefaultConversationConfig('codex');
    const { store, service } = configLayer(root);
    const record = await store.create({
      kind: { t: 'chat' },
      conversationId: CONVERSATION_ID,
      config,
      workingDirectory: '/tmp',
      provenance: 'user',
    });
    const Conversation = createConversationRuntime({
      executions: testExecutions(),
      broadcast: () => undefined,
      registerSessionAlias: () => undefined,
      unregisterSessionAlias: () => undefined,
      clearExternalRunningStatus: () => undefined,
      clearLocalCompletionSuppression: () => undefined,
      markLocalCompletionSuppression: () => undefined,
      persistCurrentSession: async () => undefined,
      buddies: fakeBuddyPort(),
      getConversation: () => undefined,
      readLatestOompaRuntime: async () => ({ available: false, run: null, reason: 'fixture' }),
      createSessionId: () => 'rotated-session',
    });
    const conversation = new Conversation({
      kind: { t: 'chat' },
      id: CONVERSATION_ID,
      workingDirectory: '/tmp',
      configState: { config, revision: 0, resolution: resolveConfigAgainstProviderCatalog(config) },
      done: record.done,
    });

    const broadcasts: ServerMessage[] = [];
    let onBroadcast: (() => void) | null = null;
    const webSocketServer = new EventEmitter();
    registerConversationWebSocket(
      webSocketServer as never,
      {
        listedRows: () => [],
        materialize: async () => undefined,
        forgetListed: () => undefined,
        registry: {
          get: (id: string) => (id === CONVERSATION_ID ? conversation : undefined),
          values: () => [conversation][Symbol.iterator](),
        },
        externalActivity: { has: () => false },
        initialLoadComplete: Promise.resolve(),
        isInitialLoadComplete: () => true,
        beginCommand: () => () => undefined,
        configService: service,
        getDefaultWorkingDirectory: () => '/tmp',
        broadcast: (message: ServerMessage) => {
          broadcasts.push(message);
          onBroadcast?.();
        },
        logger: { log: () => undefined, error: () => undefined },
      } as never
    );
    class Socket extends EventEmitter {
      readyState = 1;
      send() {}
    }
    const socket = new Socket();
    webSocketServer.emit('connection', socket, { url: WS_PATH });
    const setDone = async (done: boolean) => {
      const landed = new Promise<void>((resolve) => {
        onBroadcast = resolve;
      });
      socket.emit(
        'message',
        Buffer.from(
          JSON.stringify({ type: 'set_conversation_done', conversationId: CONVERSATION_ID, done })
        )
      );
      await landed;
      return broadcasts.at(-1);
    };

    const hidden = await setDone(true);
    assert.deepEqual(hidden, {
      type: 'patch',
      id: CONVERSATION_ID,
      patch: { t: 'done', done: true },
    });

    await service.setCurrentSession(CONVERSATION_ID, { provider: 'codex', sessionId: 'rotated' });
    const afterRestart = await configLayer(root).store.getByConversationId(CONVERSATION_ID);
    assert.equal(afterRestart?.done, true, 'hide must survive rotation and a store reopen');

    const restored = await setDone(false);
    assert.equal(
      restored?.type === 'patch' && restored.patch.t === 'done' && restored.patch.done,
      false
    );
    assert.equal((await configLayer(root).store.getByConversationId(CONVERSATION_ID))?.done, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
