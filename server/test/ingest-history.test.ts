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
  type ConversationCreationMetadata,
  type ConversationKind,
  buddyKind,
  ConversationDetailSchema,
  type Message,
  MessagePageSchema,
  createDefaultConversationConfig,
  detectOompaSubcommand,
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
import { mergedCount, sessionMessages } from '../src/ingest/history';
import { mergeSessionMessages } from '../src/lifecycle/session-history';
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
async function serve(
  fixture: ReturnType<typeof ingestHome>,
  pinned: ReadonlySet<string> = new Set()
) {
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
    pinned: async () => pinned,
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
    registry,
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

// Boot settles multi-session records from a digest count instead of building every merged
// history (2026-10-23: ~2 s of main thread over 618 records). The count is only trustworthy if it
// equals the real merge on a fork (inherited prefix), a repeated identical line inside a session,
// and a diverging tail.
test('mergedCount equals the length of the real merge across forked sessions', async () => {
  const fixture = ingestHome('unleashd-merged-count-');
  const a = sessionId(1);
  const b = sessionId(2);
  const { project } = fixture;
  const prefix =
    claudeLine(a, 'user', 'Plan', T0, project) +
    claudeLine(a, 'assistant', 'A plan', T0 + 1_000, project) +
    claudeLine(a, 'user', 'Again', T0 + 2_000, project);
  fs.writeFileSync(fixture.transcript(a), prefix);
  fs.writeFileSync(
    fixture.transcript(b),
    prefix.replaceAll(a, b) +
      claudeLine(b, 'assistant', 'Shipped', T0 + 3_000, project) +
      claudeLine(b, 'user', 'Thanks', T0 + 4_000, project)
  );
  const { ingest, list } = await bootIngest(
    { home: fixture.home, appDataDir: fixture.appData },
    {
      records: recordStore(fixture.appData),
      runtime: () => undefined,
      discover: async () => null,
      externalActivity: {
        has: () => false,
        set: () => undefined,
        delete: () => undefined,
        entries: () => new Map<string, number>().entries(),
      },
      completionSuppression: { isSuppressed: () => false },
      externalGraceMs: 30_000,
      broadcast: () => undefined,
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
    }
  );
  try {
    const { rows } = await ingest.listSessions({ since: 0 });
    const bound = rows.filter((row) => [a, b].includes(row.sessionId));
    assert.equal(bound.length, 2);
    const real = mergeSessionMessages(
      await Promise.all(bound.map((row) => sessionMessages(ingest, row, row.messageCount)))
    );
    const fast = await mergedCount(
      ingest,
      bound.map((row) => ({ ...row, count: row.messageCount }))
    );
    assert.equal(real.length, 5, 'prefix of 3 counted once plus 2 new rows');
    assert.equal(fast, real.length);
  } finally {
    list.stop();
    await ingest.stop();
    fixture.cleanup();
  }
});

test('detectOompaSubcommand still sees quoted and wrapped oompa launches', () => {
  assert.equal(detectOompaSubcommand('oompa swarm x.json'), 'swarm');
  assert.equal(detectOompaSubcommand('bash -lc "cd /x && OOMPA run y.json"'), 'run');
  assert.equal(detectOompaSubcommand('"/usr/bin/oom"\'pa\' swarm z.json'), 'swarm');
  assert.equal(detectOompaSubcommand('ls -la && git status'), null);
});

// Fix-guard: eager recovery built one runtime per app-created record (8,176 on 2026-10-23, 4.0 s of
// an 18 s boot) though the list index already serves their rows. Fails if recover() materializes
// a cold listed chat again, or if a cold chat stops opening on first use.
test('boot materializes only the records that need a runtime; a cold chat opens on first use', async () => {
  const fixture = ingestHome('unleashd-ingest-lazy-');
  const records = recordStore(fixture.appData);
  const listed = [1, 2, 3].map(sessionId);
  const [cold, pinned, coldToo] = listed;
  const empty = sessionId(4);
  for (const [n, id] of listed.entries()) {
    fs.writeFileSync(
      fixture.transcript(id),
      claudeLine(id, 'user', `question ${n}`, T0 + n * 1_000, fixture.project)
    );
  }
  for (const id of [...listed, empty]) {
    await records.create({
      conversationId: id,
      kind: { t: 'chat' },
      sessionBindings: id === empty ? [] : [{ provider: 'claude', sessionId: id }],
      currentSession: id === empty ? undefined : { provider: 'claude', sessionId: id },
      config: createDefaultConversationConfig('claude'),
      workingDirectory: fixture.project,
      provenance: 'user',
    });
  }
  const server = await serve(fixture, new Set([pinned]));
  try {
    await server.builder.recover();
    // Only pinned (queued inputs / live runs) holds a runtime; the listed chats and the
    // transcript-less one (listed from its record) stay cold.
    assert.deepEqual([...server.registry.keys()], [pinned]);
    assert.ok(server.list.joined(empty)?.row, 'the transcript-less chat is listed from its record');
    assert.ok(server.list.joined(cold)?.row, 'the cold chat is served from the list index');

    const detail = await server.detail(cold);
    assert.equal(detail.status, 200, 'a command on a cold conversation must still find a runtime');
    assert.ok(server.registry.has(cold), 'first use materializes it');
    assert.ok(!server.registry.has(coldToo), 'and only it');
  } finally {
    await server.close();
    fixture.cleanup();
  }
});

const bareKinds: Array<[string, ConversationKind]> = [
  ['worker', { t: 'worker', swarmId: 'swarm-1', workerId: 'w1', role: 'work' }],
  ['seat', buddyKind({ buddyId: 'buddy-1', workspaceId: 'workspace-1' })],
  [
    'background buddy',
    buddyKind({ buddyId: 'buddy-1', workspaceId: 'workspace-1', automationRunId: 'run-1' }),
  ],
  ['builder', { t: 'builder' }],
  ['chat', { t: 'chat' }],
];

async function createBare(
  server: Awaited<ReturnType<typeof serve>>,
  fixture: ReturnType<typeof ingestHome>,
  conversationId: string,
  kind: ConversationKind,
  creation?: ConversationCreationMetadata
) {
  await server.records.create({
    conversationId,
    kind,
    sessionBindings: [],
    config: createDefaultConversationConfig('claude'),
    workingDirectory: fixture.project,
    creation,
    provenance: 'user',
  });
}

// Fix-guard: transcript-less records (4,114 on 2026-10-23: background Buddy workers, seats that never
// ran, builders, branches) were built into runtimes at boot only because the runtime was their one
// list row (0.8-2.8 s). Their row now comes from the record, and sidebar counts read it, so it must
// deep-equal what the runtime would say. Fails if the two row rules drift apart.
test('a record without a transcript is listed from the record alone, with the row its runtime would serve', async () => {
  const fixture = ingestHome('unleashd-ingest-bare-');
  const server = await serve(fixture);
  try {
    const source = sessionId(900);
    await createBare(server, fixture, source, { t: 'chat' });
    const cases: Array<[string, ConversationKind, ConversationCreationMetadata | undefined]> = [
      ...bareKinds.map(([name, kind]): [string, ConversationKind, undefined] => [name, kind, undefined]),
      ['branch', { t: 'chat' }, { resumedFromConversationId: source }],
    ];
    const ids = cases.map((_, n) => sessionId(901 + n));
    for (const [n, [, kind, creation]] of cases.entries()) {
      await createBare(server, fixture, ids[n], kind, creation);
    }
  } finally {
    await server.close();
  }
  // A restart: every record is cold, so the rows below can only come from the records.
  const restarted = await serve(fixture);
  try {
    await restarted.builder.recover();
    assert.equal(restarted.registry.size, 0, 'boot builds no runtime for cold transcript-less records');
    const cold = new Map(restarted.list.rows().map((row) => [row.id, row]));
    assert.equal(cold.size, bareKinds.length + 2, 'every record is listed without a runtime');
    for (const [id, row] of cold) {
      const runtime = await restarted.builder.materialize(id);
      assert.ok(runtime, `${id} opens on first use`);
      assert.deepEqual(row, runtime.toRow(), `${id}: record-derived row equals the runtime's`);
    }
    assert.equal(restarted.registry.size, cold.size);
  } finally {
    await restarted.close();
    fixture.cleanup();
  }
});

test('boot still materializes a never-dispatched first message and leaves its cold neighbours', async () => {
  const fixture = ingestHome('unleashd-ingest-pending-');
  const server = await serve(fixture);
  const [pending, dispatched, plain] = [1, 2, 3].map((n) => sessionId(950 + n));
  try {
    await createBare(server, fixture, pending, { t: 'chat' }, { initialMessage: 'hello' });
    await createBare(
      server,
      fixture,
      dispatched,
      { t: 'chat' },
      { initialMessage: 'hello', initialMessageDispatchedAt: new Date(T0).toISOString() }
    );
    await createBare(server, fixture, plain, { t: 'chat' });
  } finally {
    await server.close();
  }
  const restarted = await serve(fixture);
  try {
    await restarted.builder.recover();
    assert.deepEqual([...restarted.registry.keys()], [pending]);
  } finally {
    await restarted.close();
    fixture.cleanup();
  }
});
