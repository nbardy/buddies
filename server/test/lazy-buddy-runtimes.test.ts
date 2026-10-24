/**
 * Buddy-kind runtimes are lazy at boot (2026-10-23: ~8k seats/DMs/branches/workers built eagerly,
 * 4-5 s of boot). Every by-id reader must therefore treat a cold stored record as EXISTING:
 * absent-then-recreate rebuilt it from the caller's config, which moves with the owner's pick.
 * Real crate, real records store, real config service and creation services; only the provider
 * process and the Buddy briefing are absent. Guards: slots `openConversation`, `openBranch`, and
 * the create command (creation-service.ts) never replay a create over a cold record.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  type BuddyContext,
  type ConversationConfig,
  type ConversationKind,
  buddyKind,
  createDefaultConversationConfig,
} from '@unleashd/shared';
import type { ConversationRegistry } from '../src/application/context';
import {
  type StableConversationPorts,
  openConversation,
  stableConversationId,
} from '../src/buddies/buddy-conversation-slots';
import { ConversationConfigService } from '../src/conversations/config-service';
import { createBuddyCreationService } from '../src/conversations/buddy-creation-service';
import {
  creationFingerprint,
  createConversationService,
} from '../src/conversations/creation-service';
import {
  type ConversationRuntime,
  createConversationRuntime,
  overlayHistoryFields,
} from '../src/conversations/runtime';
import { bootIngest } from '../src/ingest/boot';
import { createRuntimeBuilder } from '../src/ingest/runtimes';
import { resolveConfigAgainstProviderCatalog } from '../src/providers/catalog-service';
import { fakeBuddyPort } from './fixtures/buddy-port';
import { testExecutions } from './fixtures/fake-turn';
import { claudeLine, ingestHome } from './fixtures/ingest-home';
import { recordStore } from './fixtures/records';

const T0 = Date.parse('2026-09-01T00:00:00Z');
const context: BuddyContext = { buddyId: 'buddy-1', workspaceId: 'workspace-1' };
const sid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

/** One backend over a fixture HOME. Calling it again with the same HOME is a restart. */
async function boot(fixture: ReturnType<typeof ingestHome>) {
  const records = recordStore(fixture.appData);
  const configService = new ConversationConfigService({
    store: records,
    resolver: { resolve: async (config) => resolveConfigAgainstProviderCatalog(config) },
  });
  const map = new Map<string, ConversationRuntime>();
  let list: Awaited<ReturnType<typeof bootIngest>>['list'] | null = null;
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
    getConversation: (id) => map.get(id),
    readLatestOompaRuntime: async () => ({ available: false, run: null, reason: 'fixture' }),
    createSessionId: () => 'fresh-session',
    history: {
      fields: (conversation) =>
        list?.historyFields(conversation) ?? overlayHistoryFields(conversation),
      idle: (id) => list?.idle(id),
    },
  });
  const booted = await bootIngest(
    { home: fixture.home, appDataDir: fixture.appData },
    {
      records,
      runtime: (id) => map.get(id),
      discover: async () => null,
      externalActivity: {
        has: () => false,
        set: () => undefined,
        delete: () => undefined,
        entries: () => [][Symbol.iterator](),
      },
      completionSuppression: { isSuppressed: () => true },
      externalGraceMs: 30_000,
      broadcast: () => undefined,
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
    }
  );
  list = booted.list;
  const registry: ConversationRegistry<ConversationRuntime> = {
    get: (id) => map.get(id),
    has: (id) => map.has(id),
    set: (conversation) => void map.set(conversation.id, conversation),
    delete: (id) => map.delete(id),
    values: () => map.values(),
    entries: () => map.entries(),
    keys: () => map.keys(),
    get size() {
      return map.size;
    },
  };
  const builder = createRuntimeBuilder({
    registry,
    records,
    configService,
    joined: (id) => booted.list.joined(id),
    pinned: async () => new Set(),
    createConversation: (options) => new Conversation(options),
    resolveBuddyConversation: async () => {
      throw new Error('a cold record with a session must not re-brief at boot');
    },
    dispatchInitialMessage: async () => undefined,
    broadcast: () => undefined,
    logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
  });
  // Every create that reaches the runtime constructor outside the builder is a REPLAYED create.
  const replayedCreates: string[] = [];
  const creationPorts = {
    configService,
    materialize: (id: string) => builder.materialize(id),
    getConversation: (id: string) => map.get(id),
    createConversation: (options: ConstructorParameters<typeof Conversation>[0]) => {
      replayedCreates.push(options.id);
      return new Conversation(options);
    },
    registerConversation: (conversation: ConversationRuntime) => registry.set(conversation),
    createConversationLink: async () => undefined,
  };
  const buddyCreation = createBuddyCreationService({
    ...creationPorts,
    resolveBuddyConversation: async (ctx) => ({
      context: ctx,
      briefing: '',
      memoryGeneration: '0',
      workingDirectory: fixture.project,
      execution: { kind: 'no-agent' },
    }),
    installedAgent: () => {
      throw new Error('unused');
    },
    resolveWorkingDirectory: (directory) => directory,
    createId: () => {
      throw new Error('unused');
    },
    updateConversationStatus: () => undefined,
    broadcast: () => undefined,
  });
  const stable: StableConversationPorts = {
    slot: async () => ({ kind: 'absent' }),
    getConversation: (id) => builder.materialize(id),
    ensureConversationReady: buddyCreation.ensureConversationReady,
    createConversation: (input) => buddyCreation.createServerBuddyConversation(input),
    reconfigure: async () => undefined,
  };
  return {
    records,
    configService,
    registry,
    builder,
    replayedCreates,
    buddyCreation,
    stable,
    wsCreate: createConversationService(creationPorts),
    async close() {
      booted.list.stop();
      await booted.ingest.stop();
    },
  };
}

/** A stored, listed (transcript-backed) record: what a restart finds. */
async function store(
  fixture: ReturnType<typeof ingestHome>,
  server: Awaited<ReturnType<typeof boot>>,
  id: string,
  kind: ConversationKind,
  config: ConversationConfig,
  creation: { commandId: string; fingerprint: string }
) {
  fs.writeFileSync(
    fixture.transcript(id),
    claudeLine(id, 'user', `hello ${id}`, T0, fixture.project)
  );
  await server.configService.createOrReplay({
    conversationId: id,
    sessionBindings: [{ provider: 'claude', sessionId: id }],
    currentSession: { provider: 'claude', sessionId: id },
    workingDirectory: fixture.project,
    kind,
    config,
    creation,
  });
}

test('cold Buddy seats, branches and created ids are found by id, never re-created', async () => {
  const fixture = ingestHome('unleashd-lazy-buddy-');
  const claude = createDefaultConversationConfig('claude');
  const [seat, parent, source, fresh, coldParent, plain] = [1, 2, 3, 4, 5, 6].map(sid);
  const branch = stableConversationId(`branch:${parent}`);
  const coldBranch = stableConversationId(`branch:${coldParent}`);
  const created = {
    workingDirectory: fixture.project,
    config: claude,
    kind: { t: 'chat' } as ConversationKind,
  };
  let server = await boot(fixture);
  try {
    await store(fixture, server, seat, buddyKind(context), claude, {
      commandId: `channel-thread-${seat}`,
      fingerprint: 'seat-v1',
    });
    await store(fixture, server, parent, { t: 'chat' }, claude, {
      commandId: 'create-parent',
      fingerprint: creationFingerprint(created),
    });
    await store(fixture, server, source, buddyKind(context), claude, {
      commandId: 'create-source',
      fingerprint: 'source-v1',
    });
    await store(fixture, server, coldParent, { t: 'chat' }, claude, {
      commandId: 'create-cold-parent',
      fingerprint: 'cold-parent-v1',
    });
    await store(fixture, server, plain, { t: 'chat' }, claude, {
      commandId: 'create-plain',
      fingerprint: creationFingerprint(created),
    });
    // Branch of the parent, created once while it is warm, then the backend restarts.
    await server.builder.materialize(parent);
    assert.equal(
      await server.buddyCreation.openBranch({ conversationId: parent, ...context }),
      branch
    );
    assert.ok(server.registry.has(branch));
  } finally {
    await server.close();
  }

  server = await boot(fixture);
  try {
    await server.builder.recover();
    // Nothing runs and no first message is pending, so no runtime is built: the transcript-less
    // branch is listed from its record, and its fork source loads when the branch is opened.
    assert.deepEqual([...server.registry.keys()], []);

    // 1. A Buddy turn on a cold seat whose owner pick MOVED to another provider: the seat reopens
    // as stored. The old sync read said "absent" and replayed a create with the new config, which
    // conflicts with the stored fingerprint.
    const moved = createDefaultConversationConfig('codex');
    const reopened = await openConversation(server.stable, {
      context,
      conversationId: seat,
      commandId: `channel-thread-${seat}`,
      config: moved,
    });
    assert.equal(reopened.id, seat);
    assert.equal(reopened.config.provider, 'claude', 'it runs the stored config, not the new pick');

    // 2. A branch from a cold parent materializes the parent instead of "Owner chat is not loaded";
    // the branch that already exists is returned as is.
    assert.ok(!server.registry.has(coldParent));
    assert.equal(
      await server.buddyCreation.openBranch({ conversationId: coldParent, ...context }),
      coldBranch
    );
    assert.ok(server.registry.has(coldParent));
    assert.equal(
      await server.buddyCreation.openBranch({ conversationId: parent, ...context }),
      branch
    );

    // 3. A create command naming an existing cold id replays against the record and returns ITS
    // runtime. A fork's source is materialized too (the first turn reads it synchronously).
    assert.ok(!server.registry.has(plain));
    const again = await server.wsCreate({
      conversationId: plain,
      commandId: 'create-plain',
      ...created,
    });
    assert.equal(again, server.registry.get(plain));
    // A NEW id forked from a cold source holds the source's runtime (read on its first turn).
    await server.wsCreate({
      conversationId: fresh,
      commandId: 'create-fresh',
      ...created,
      resumedFromConversationId: source,
    });
    assert.ok(server.registry.has(source), 'a cold fork source is materialized, not "not loaded"');

    assert.deepEqual(
      server.replayedCreates,
      [coldBranch, fresh],
      'only the genuinely new id was created; no cold record was re-created'
    );
  } finally {
    await server.close();
    fixture.cleanup();
  }
});
