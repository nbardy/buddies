/**
 * Message bodies from the ingest store (T13b S2), end to end: the REAL crate over a fixture HOME,
 * a real records store and config service, real runtimes built from records, and the real HTTP
 * routes. Catches: a conversation outside the old loader's 500-transcript window 404ing or opening
 * empty; the live-turn overlay and the provider's own flush of the same turn both showing; and a
 * transcript rewritten on disk not making loaded clients refetch.
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { ExecutionHandle } from '@nbardy/agent-cli';
import {
  ConversationDetailSchema,
  type Message,
  MessagePageSchema,
  createDefaultConversationConfig,
} from '@unleashd/shared';
import express from 'express';
import type { ConversationRegistry } from '../src/application/context';
import { ConversationConfigService } from '../src/conversations/config-service';
import {
  type ConversationBroadcast,
  type ConversationRuntime,
  createConversationRuntime,
  overlayHistoryFields,
} from '../src/conversations/runtime';
import { builderFirstTurnPrompt } from '../src/buddies/turn-policy';
import { registerConversationRoutes } from '../src/http/conversation-routes';
import { bootIngest } from '../src/ingest/boot';
import type { ConversationList } from '../src/ingest/conversation-list';
import { createRuntimeBuilder } from '../src/ingest/runtimes';
import { resolveConfigAgainstProviderCatalog } from '../src/providers/catalog-service';
import { fakeBuddyPort } from './fixtures/buddy-port';
import { testExecutions } from './fixtures/fake-turn';
import { claudeLine, ingestHome, until } from './fixtures/ingest-home';
import { recordStore } from './fixtures/records';

const T0 = Date.parse('2026-09-01T00:00:00Z');
const OLD_WINDOW = 500;
function textOf(message: Message): string {
  assert.equal(message.body.t, 'text');
  return message.body.t === 'text' ? message.body.text : '';
}

function sessionId(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

/** A server over one fixture HOME: list, runtimes and routes, as server.ts composes them. */
async function serve(fixture: ReturnType<typeof ingestHome>) {
  const records = recordStore(fixture.appData);
  const configService = new ConversationConfigService({
    store: records,
    resolver: { resolve: async (config) => resolveConfigAgainstProviderCatalog(config) },
  });
  const sent: ConversationBroadcast[] = [];
  const registry = new Map<string, ConversationRuntime>();
  let list: ConversationList | null = null;
  const Conversation = createConversationRuntime({
    executions: testExecutions(),
    broadcast: (data) => sent.push(data as ConversationBroadcast),
    registerSessionAlias: () => undefined,
    unregisterSessionAlias: () => undefined,
    clearExternalRunningStatus: () => undefined,
    clearLocalCompletionSuppression: () => undefined,
    markLocalCompletionSuppression: () => undefined,
    persistCurrentSession: async () => undefined,
    buddies: fakeBuddyPort(),
    getConversation: (id) => registry.get(id),
    readLatestOompaRuntime: async () => ({ available: false, run: null, reason: 'fixture' }),
    createSessionId: () => 'fresh-session',
    history: {
      fields: (conversation) =>
        list?.historyFields(conversation) ?? overlayHistoryFields(conversation),
      idle: (id) => list?.idle(id),
    },
  });
  const external = new Map<string, number>();
  const booted = await bootIngest(
    { home: fixture.home, appDataDir: fixture.appData },
    {
      records,
      runtime: (id) => registry.get(id),
      discover: async () => null,
      externalActivity: {
        has: (id) => external.has(id),
        set: (id, at) => void external.set(id, at),
        delete: (id) => void external.delete(id),
        entries: () => external.entries(),
      },
      completionSuppression: { isSuppressed: () => true },
      externalGraceMs: 30_000,
      broadcast: (data) => sent.push(data),
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
    }
  );
  list = booted.list;
  const runtimeRegistry: ConversationRegistry<ConversationRuntime> = {
    get: (id: string) => registry.get(id),
    has: (id: string) => registry.has(id),
    set: (conversation: ConversationRuntime) => void registry.set(conversation.id, conversation),
    delete: (id: string) => registry.delete(id),
    values: () => registry.values(),
    entries: () => registry.entries(),
    keys: () => registry.keys(),
    get size() {
      return registry.size;
    },
  };
  const builder = createRuntimeBuilder({
    registry: runtimeRegistry,
    records,
    configService,
    joined: (id) => booted.list.joined(id),
    createConversation: (options) => new Conversation(options),
    resolveBuddyConversation: async () => {
      throw new Error('no Buddies here');
    },
    dispatchInitialMessage: async () => undefined,
    broadcast: (data) => sent.push(data),
    logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
  });
  const app = express();
  registerConversationRoutes(
    app,
    (id) => builder.materialize(id),
    (id, page) => booted.list.page(id, page),
    { ingest: () => ({ t: 'starting' }) }
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/conversations`;
  return {
    records,
    sent,
    list: booted.list,
    builder,
    /** Every message, paged the way the client pages (500 at a time). */
    async history(id: string) {
      const messages: Message[] = [];
      let epoch = -1;
      for (let afterSeq = -1; ; ) {
        const response = await fetch(`${base}/${id}/messages?afterSeq=${afterSeq}&limit=500`);
        assert.equal(response.status, 200);
        const page = MessagePageSchema.parse(await response.json());
        epoch = page.epoch;
        messages.push(...page.messages);
        afterSeq += page.messages.length;
        if (page.messages.length === 0 || afterSeq + 1 >= page.total) break;
      }
      return { epoch, messages };
    },
    detail: (id: string) => fetch(`${base}/${id}`),
    async close() {
      server.close();
      booted.list.stop();
      await booted.ingest.stop();
    },
  };
}

test('a conversation outside the old 500-transcript window opens with its full history', async () => {
  const fixture = ingestHome('unleashd-ingest-window-');
  const records = recordStore(fixture.appData);
  const config = createDefaultConversationConfig('claude');
  // The oldest of 501 transcripts, long enough to need several pages.
  const oldest = sessionId(0);
  let lines = '';
  for (let n = 0; n < 1_200; n++) {
    lines += claudeLine(
      oldest,
      n % 2 ? 'assistant' : 'user',
      `turn ${n}`,
      T0 + n * 1_000,
      fixture.project
    );
  }
  fs.writeFileSync(fixture.transcript(oldest), lines);
  for (let n = 1; n <= OLD_WINDOW; n++) {
    const id = sessionId(n);
    fs.writeFileSync(
      fixture.transcript(id),
      claudeLine(id, 'user', `newer ${n}`, T0 + 86_400_000 + n, fixture.project)
    );
  }
  await records.create({
    conversationId: oldest,
    kind: { t: 'chat' },
    sessionBindings: [{ provider: 'claude', sessionId: oldest }],
    currentSession: { provider: 'claude', sessionId: oldest },
    config,
    provenance: 'external_discovered',
  });
  const server = await serve(fixture);
  try {
    const detail = await server.detail(oldest);
    assert.equal(detail.status, 200, 'S1 404d here: no runtime held its history');
    assert.equal(ConversationDetailSchema.parse(await detail.json()).sessionId, oldest);
    const { messages } = await server.history(oldest);
    assert.equal(messages.length, 1_200);
    assert.equal(textOf(messages[0]), 'turn 0');
    assert.equal(textOf(messages[1_199]), 'turn 1199');
  } finally {
    await server.close();
    fixture.cleanup();
  }
});

test('the live-turn overlay shows once, then gives way to the provider rows at idle', async () => {
  const fixture = ingestHome('unleashd-ingest-overlay-');
  const records = recordStore(fixture.appData);
  const id = sessionId(7);
  const file = fixture.transcript(id);
  fs.writeFileSync(
    file,
    claudeLine(id, 'user', 'first question', T0, fixture.project) +
      claudeLine(id, 'assistant', 'first answer', T0 + 1_000, fixture.project)
  );
  await records.create({
    conversationId: id,
    kind: { t: 'chat' },
    sessionBindings: [{ provider: 'claude', sessionId: id }],
    currentSession: { provider: 'claude', sessionId: id },
    config: createDefaultConversationConfig('claude'),
    workingDirectory: fixture.project,
    provenance: 'user',
  });
  const server = await serve(fixture);
  try {
    const conversation = await server.builder.materialize(id);
    assert.ok(conversation);
    // A turn this server runs: its rows are the overlay until the provider's file has them.
    const sentAt = Date.now();
    conversation.process = {} as ExecutionHandle;
    conversation.appendMessage({
      role: 'user',
      body: { t: 'text', text: 'second question' },
      timestamp: new Date(sentAt),
    });
    conversation.appendMessage({
      role: 'assistant',
      body: { t: 'text', text: 'streamed answer' },
      timestamp: new Date(sentAt + 10),
    });
    assert.equal(conversation.toRow().messageCount, 4);

    // The provider flushes the same turn while it runs: held back, never shown twice.
    fs.appendFileSync(
      file,
      claudeLine(id, 'user', 'second question', sentAt + 400, fixture.project) +
        claudeLine(id, 'assistant', 'final answer', sentAt + 2_000, fixture.project)
    );
    await until(() => server.list.joined(id)?.sessions[0]?.messageCount === 4 || undefined);
    const during = await server.history(id);
    assert.deepEqual(during.messages.map(textOf), [
      'first question',
      'first answer',
      'second question',
      'streamed answer',
    ]);

    // Idle: the provider's rows replace the live ones; still four messages, no duplicates.
    const sentBefore = server.sent.length;
    conversation.process = null;
    const settled = await until(() => {
      const data = server.sent
        .slice(sentBefore)
        .find((candidate) => candidate.type === 'patch' && candidate.patch.t === 'activity');
      return data?.type === 'patch' && data.patch.t === 'activity' ? data.patch : undefined;
    });
    assert.equal(settled.messageCount, 4);
    const after = await server.history(id);
    assert.deepEqual(after.messages.map(textOf), [
      'first question',
      'first answer',
      'second question',
      'final answer',
    ]);
    assert.equal(conversation.toRow().messageCount, after.messages.length);
  } finally {
    await server.close();
    fixture.cleanup();
  }
});

// Regression (task_01a10d29, 2026-10-06): the Builder's first prompt carried its working directory
// after the envelope, ingest could not strip it, and the transcript's user row became a recovery
// placeholder. The overlay merge pairs turns by user text, so nothing paired: after a reload the
// opening and final replies each showed twice. The transcript line is the server's own prompt.
test('a Builder first turn shows once after idle, with the text the owner typed', async () => {
  const fixture = ingestHome('unleashd-ingest-builder-');
  const records = recordStore(fixture.appData);
  const id = sessionId(11);
  const file = fixture.transcript(id);
  fs.writeFileSync(file, '');
  await records.create({
    conversationId: id,
    kind: { t: 'builder' },
    sessionBindings: [{ provider: 'claude', sessionId: id }],
    currentSession: { provider: 'claude', sessionId: id },
    config: createDefaultConversationConfig('claude'),
    workingDirectory: fixture.project,
    provenance: 'user',
  });
  const server = await serve(fixture);
  try {
    const conversation = await server.builder.materialize(id);
    assert.ok(conversation);
    const sentAt = Date.now();
    conversation.process = {} as ExecutionHandle;
    const live = ['Kick off my Buddies', 'I will hire one engineer.', 'Hired Notes Engineer.'];
    live.forEach((text, n) =>
      conversation.appendMessage({
        role: n === 0 ? 'user' : 'assistant',
        body: { t: 'text', text },
        timestamp: new Date(sentAt + n * 10),
      })
    );
    fs.appendFileSync(
      file,
      claudeLine(
        id,
        'user',
        builderFirstTurnPrompt(live[0], true, fixture.project),
        sentAt + 400,
        fixture.project
      ) +
        claudeLine(id, 'assistant', live[1], sentAt + 2_000, fixture.project) +
        claudeLine(id, 'assistant', live[2], sentAt + 9_000, fixture.project)
    );
    await until(() => server.list.joined(id)?.sessions[0]?.messageCount === 3 || undefined);

    const sentBefore = server.sent.length;
    conversation.process = null;
    await until(() =>
      server.sent
        .slice(sentBefore)
        .find((data) => data.type === 'patch' && data.patch.t === 'activity')
    );
    const after = await server.history(id);
    assert.deepEqual(after.messages.map(textOf), live);
  } finally {
    await server.close();
    fixture.cleanup();
  }
});

test('a transcript rewritten on disk makes loaded clients refetch', async () => {
  const fixture = ingestHome('unleashd-ingest-rewrite-');
  const records = recordStore(fixture.appData);
  const id = sessionId(9);
  const file = fixture.transcript(id);
  fs.writeFileSync(
    file,
    claudeLine(id, 'user', 'original question', T0, fixture.project) +
      claudeLine(id, 'assistant', 'original answer', T0 + 1_000, fixture.project)
  );
  await records.create({
    conversationId: id,
    kind: { t: 'chat' },
    sessionBindings: [{ provider: 'claude', sessionId: id }],
    currentSession: { provider: 'claude', sessionId: id },
    config: createDefaultConversationConfig('claude'),
    provenance: 'external_discovered',
  });
  const server = await serve(fixture);
  try {
    const before = await server.history(id);
    // Same length, different history: only the epoch (and the `rewritten` patch) can tell.
    fs.writeFileSync(
      file,
      claudeLine(id, 'user', 'edited question', T0, fixture.project) +
        claudeLine(id, 'assistant', 'edited answer', T0 + 1_000, fixture.project)
    );
    await until(() =>
      server.sent.find(
        (data) => data.type === 'patch' && data.id === id && data.patch.t === 'rewritten'
      )
    );
    const after = await server.history(id);
    assert.notEqual(after.epoch, before.epoch);
    assert.deepEqual(after.messages.map(textOf), ['edited question', 'edited answer']);
  } finally {
    await server.close();
    fixture.cleanup();
  }
});
