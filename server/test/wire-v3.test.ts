import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import {
  EncodedRowsSchema,
  MessagePageSchema,
  type ServerMessage,
  WS_PATH,
  buddyKind,
  createDefaultConversationConfig,
  decodeRows,
} from '@unleashd/shared';
import express from 'express';
import { type ConversationRuntime, createConversationRuntime } from '../src/conversations/runtime';
import { registerConversationRoutes } from '../src/http/conversation-routes';
import { resolveConfigAgainstProviderCatalog } from '../src/providers/catalog-service';
import { registerConversationWebSocket } from '../src/transport/conversation-websocket';
import { fakeBuddyPort } from './fixtures/buddy-port';
import { testExecutions } from './fixtures/fake-turn';

// Guards for protocol v3 (T09, 2026-09-25). Measured before it on a copy of
// the live data: `init` was 1.87 MB for 1,161 conversations (every row carried
// config, resolution, a message preview, and a Buddy kind with its
// allowed-operations list), and marking a 1,099-message chat done re-sent the
// whole conversation — 1.36 MB — to every socket.

const config = createDefaultConversationConfig('codex');
const configState = {
  config,
  revision: 0,
  resolution: resolveConfigAgainstProviderCatalog(config),
};
const broadcasts: ServerMessage[] = [];
const Conversation = createConversationRuntime({
  executions: testExecutions(),
  broadcast: (message) => broadcasts.push(message as ServerMessage),
  registerSessionAlias: () => undefined,
  unregisterSessionAlias: () => undefined,
  clearExternalRunningStatus: () => undefined,
  clearLocalCompletionSuppression: () => undefined,
  markLocalCompletionSuppression: () => undefined,
  persistCurrentSession: async () => undefined,
  buddies: fakeBuddyPort(),
  getConversation: () => undefined,
  readLatestOompaRuntime: async () => ({ available: false, run: null, reason: 'fixture' }),
  createSessionId: () => 'session',
});

const LONG_BODY = 'A realistic message body. '.repeat(200); // ~5 KB
const ALLOWED_OPS = Array.from({ length: 40 }, (_, index) => `buddy.operation_${index}`);

/** A heavy conversation: 200 × 5 KB messages; every third one a delegated Buddy run. */
function heavyConversation(index: number): ConversationRuntime {
  const conversation = new Conversation({
    id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
    workingDirectory: `/Users/dev/git/project-${index % 20}`,
    configState,
    done: false,
    kind:
      index % 3 === 0
        ? buddyKind({
            buddyId: `buddy_${index % 7}-f595-4d83-bbc8-b227e3b4920d`,
            workspaceId: `project_${index % 4}-13d1-426a-9544-7e7830a2b5c6`,
            delegatedByBuddyId: 'buddy_lead',
            allowedBuddyOperations: ALLOWED_OPS,
          })
        : { t: 'chat' },
  });
  conversation.messages = Array.from({ length: 200 }, (_, n) => ({
    role: n % 2 === 0 ? ('user' as const) : ('assistant' as const),
    body: { t: 'text', text: `${n === 0 ? `Question ${index}: ` : ''}${LONG_BODY}` },
    timestamp: new Date(Date.UTC(2026, 8, 25, 0, index, n)),
  }));
  return conversation;
}

function socketHarness(conversations: ConversationRuntime[]) {
  const byId = new Map(conversations.map((conversation) => [conversation.id, conversation]));
  const sockets = new EventEmitter();
  const socketBroadcasts: string[] = [];
  registerConversationWebSocket(
    sockets as never,
    {
      listedRows: () => [],
      materialize: async () => undefined,
      forgetListed: () => undefined,
      registry: {
        get: (id: string) => byId.get(id),
        values: () => byId.values(),
      },
      externalActivity: { has: () => false },
      initialLoadComplete: Promise.resolve(),
      isInitialLoadComplete: () => true,
      beginCommand: () => () => undefined,
      configService: { setDone: async (_id: string, done: boolean) => ({ done }) },
      getDefaultWorkingDirectory: () => '/',
      broadcast: (message: ServerMessage) => socketBroadcasts.push(JSON.stringify(message)),
      logger: { log: () => undefined, error: () => undefined },
    } as never
  );
  class Socket extends EventEmitter {
    readyState = 1;
    readonly sent: string[] = [];
    send(frame: string) {
      this.sent.push(frame);
    }
  }
  const socket = new Socket();
  sockets.emit('connection', socket, { url: WS_PATH });
  return { socket, socketBroadcasts };
}

async function eventually<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition never held');
}

test('hello carries rows only and stays inside its per-row budget', async () => {
  const conversations = Array.from({ length: 300 }, (_, index) => heavyConversation(index));
  const { socket } = socketHarness(conversations);
  const hello = await eventually(() => socket.sent.find((frame) => frame.includes('"hello"')));

  // Budget: 300 B per row keeps ~1,200 conversations under the 0.3 MB target.
  // 1.87 MB / 1,161 rows ≈ 1,610 B per row before T09.
  const perRow = hello.length / conversations.length;
  assert.ok(perRow <= 300, `hello spends ${perRow.toFixed(0)} B per row (budget 300)`);
  // The label is the first user line, bounded; no body goes past it.
  assert.ok(!hello.includes(LONG_BODY.slice(0, 120)), 'hello carries no message bodies');
  assert.ok(!hello.includes('buddy.operation_'), 'hello carries no Buddy run data');

  const decoded = decodeRows(EncodedRowsSchema.parse(JSON.parse(hello)));
  assert.equal(decoded.length, conversations.length);
  assert.equal(decoded[0].messageCount, 200);
  assert.equal(decoded[0].label.startsWith('Question 0:'), true);
});

test('a done toggle on a large conversation sends one small patch, never the conversation', async () => {
  const conversation = heavyConversation(0);
  const { socket, socketBroadcasts } = socketHarness([conversation]);
  socket.emit(
    'message',
    Buffer.from(
      JSON.stringify({ type: 'set_conversation_done', conversationId: conversation.id, done: true })
    )
  );
  const [frame] = await eventually(() => (socketBroadcasts.length ? socketBroadcasts : undefined));
  assert.equal(socketBroadcasts.length, 1);
  assert.deepEqual(JSON.parse(frame), {
    type: 'patch',
    id: conversation.id,
    patch: { t: 'done', done: true },
  });
  // v2 sent 1.36 MB here for a 1,099-message chat.
  assert.ok(frame.length < 200, `done patch is ${frame.length} bytes`);
});

// The epoch (a replaced history refetches) is the ingest list's: ingest-history.test.ts.
test('message bodies page by seq', async () => {
  const conversation = heavyConversation(1);
  const app = express();
  registerConversationRoutes(
    app,
    async (id) => (id === conversation.id ? conversation : undefined),
    async (id, { afterSeq, limit }) =>
      id === conversation.id
        ? {
            epoch: 0,
            total: conversation.messages.length,
            afterSeq,
            messages: conversation.messages.slice(afterSeq + 1, afterSeq + 1 + limit),
          }
        : null,
    { ingest: () => ({ t: 'starting' }) }
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/conversations/${conversation.id}/messages`;
    const read = async (query: string) => {
      const response = await fetch(`${base}?${query}`);
      return { status: response.status, body: await response.json() };
    };
    const first = MessagePageSchema.parse((await read('afterSeq=-1&limit=150')).body);
    assert.equal(first.total, 200);
    assert.equal(first.messages.length, 150);
    const rest = MessagePageSchema.parse((await read('afterSeq=149&limit=150')).body);
    assert.equal(rest.messages.length, 50);

    assert.equal((await read('afterSeq=nope')).status, 400);
  } finally {
    server.close();
  }
});
