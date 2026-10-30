import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  type ConfigResolution,
  type ConversationConfig,
  type Provider,
  buddyKind,
} from '@unleashd/shared';
import {
  ConfigRevisionConflictError,
  type ConversationRecordStore,
  openRecords,
  recordsLocation,
} from '../src/conversations/config-records';
import {
  ConversationConfigResolutionError,
  type ConversationConfigResolver,
  ConversationConfigService,
  ConversationTombstonedError,
  applyConversationConfigPatch,
} from '../src/conversations/config-service';
import { creationFingerprint } from '../src/conversations/creation-service';
import { recordStore } from './fixtures/records';

const CONVERSATION_ID = '550e8400-e29b-41d4-a716-446655440000';
const FORK_ID = '550e8400-e29b-41d4-a716-446655440001';

const DEFAULT_CONFIG: ConversationConfig = {
  provider: 'codex',
  model: { mode: 'default' },
  reasoning: { mode: 'default' },
};

const DEFAULTS: Record<Provider, string> = {
  claude: 'opus',
  codex: 'gpt-5.6-sol',
  opencode: 'opencode/big-pickle',
  gemini: 'gemini-3.1-pro-preview',
  cursor: 'composer-2.5',
  muse: 'muse-spark-1.3',
  pi: 'openai-codex/gpt-6.1-sol',
};

const resolver: ConversationConfigResolver = {
  async resolve(config): Promise<ConfigResolution> {
    const modelId =
      config.model.mode === 'default' ? DEFAULTS[config.provider] : config.model.modelId;
    if (modelId === 'retired-model') {
      return {
        status: 'unavailable',
        catalogRevision: 'test-catalog-1',
        error: {
          code: 'model_unavailable',
          message: 'Model is unavailable',
          provider: config.provider,
          modelId,
        },
      };
    }
    const defaultEffort =
      modelId === 'gpt-5.6-sol' ? 'ultra' : modelId === 'gpt-5.6-terra' ? 'xhigh' : undefined;
    const reasoningEffort =
      config.reasoning.mode === 'explicit'
        ? config.reasoning.effort
        : config.reasoning.mode === 'default'
          ? defaultEffort
          : undefined;
    if (reasoningEffort === 'invalid') {
      return {
        status: 'unavailable',
        catalogRevision: 'test-catalog-1',
        error: {
          code: 'reasoning_unavailable',
          message: 'Reasoning effort is unavailable',
          provider: config.provider,
          modelId,
        },
      };
    }
    return {
      status: 'resolved',
      catalogRevision: 'test-catalog-1',
      value: {
        provider: config.provider,
        modelId,
        ...(reasoningEffort ? { reasoningEffort } : {}),
      },
    };
  },
};

async function withService(
  run: (service: ConversationConfigService, store: ConversationRecordStore) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unleashd-config-service-'));
  const store = recordStore(root, () => new Date('2026-07-28T12:00:00.000Z'));
  const service = new ConversationConfigService({ store, resolver });
  try {
    await run(service, store);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('pure provider transition resets dependent selections and enforces lifecycle', () => {
  const reset = applyConversationConfigPatch(
    {
      provider: 'codex',
      model: { mode: 'explicit', modelId: 'gpt-5.6-terra' },
      reasoning: { mode: 'disabled' },
    },
    { isRunning: false, queueDepth: 0, hasStartedSession: false },
    { kind: 'set_provider', provider: 'claude' }
  );
  assert.deepEqual(reset, {
    ok: true,
    value: {
      provider: 'claude',
      model: { mode: 'default' },
      reasoning: { mode: 'default' },
    },
  });

  const locked = applyConversationConfigPatch(
    DEFAULT_CONFIG,
    { isRunning: false, queueDepth: 0, hasStartedSession: true },
    { kind: 'set_provider', provider: 'claude' }
  );
  assert.equal(locked.ok, false);
  if (!locked.ok) assert.equal(locked.error.code, 'provider_locked');

  const modelWhileBusy = applyConversationConfigPatch(
    DEFAULT_CONFIG,
    { isRunning: false, queueDepth: 1, hasStartedSession: false },
    { kind: 'set_model', model: { mode: 'explicit', modelId: 'gpt-5.4' } }
  );
  assert.equal(modelWhileBusy.ok, true);

  const reasoningWhileRunning = applyConversationConfigPatch(
    DEFAULT_CONFIG,
    { isRunning: true, queueDepth: 1, hasStartedSession: true },
    { kind: 'set_reasoning', reasoning: { mode: 'disabled' } }
  );
  assert.equal(reasoningWhileRunning.ok, true);

  const providerWhileBusy = applyConversationConfigPatch(
    DEFAULT_CONFIG,
    { isRunning: true, queueDepth: 1, hasStartedSession: false },
    { kind: 'set_provider', provider: 'claude' }
  );
  assert.equal(providerWhileBusy.ok, false);
  if (!providerWhileBusy.ok) assert.equal(providerWhileBusy.error.code, 'conversation_busy');
});

test('a config update stays replayable, so a thread seat reopens on the new settings', async () => {
  await withService(async (service) => {
    const kind = buddyKind({ buddyId: 'buddy_1', workspaceId: 'project_1' });
    const fingerprintFor = (config: ConversationConfig) =>
      creationFingerprint({ workingDirectory: '/tmp/project', config, kind });
    const create = (config: ConversationConfig) =>
      service.createOrReplay({
        conversationId: CONVERSATION_ID,
        workingDirectory: '/tmp/project',
        kind,
        config,
        creation: { commandId: 'channel-thread-seat', fingerprint: fingerprintFor(config) },
      });
    const created = await create(DEFAULT_CONFIG);
    const nextConfig: ConversationConfig = {
      ...DEFAULT_CONFIG,
      reasoning: { mode: 'explicit', effort: 'low' },
    };
    const updated = await service.update(
      created.state,
      { isRunning: false, queueDepth: 0, hasStartedSession: true },
      {
        conversationId: CONVERSATION_ID,
        commandId: 'set-reasoning',
        expectedRevision: 0,
        patch: { kind: 'set_reasoning', reasoning: nextConfig.reasoning },
      }
    );
    assert.equal(updated.ok, true);

    const replayed = await create(nextConfig);
    assert.equal(replayed.replayed, true);
    assert.deepEqual(replayed.state.config.reasoning, { mode: 'explicit', effort: 'low' });
    // The creation-time config no longer matches what the conversation runs.
    await assert.rejects(create(DEFAULT_CONFIG), ConfigRevisionConflictError);
  });
});

test('create, update, fork, and hydrate preserve selection intent and revisions', async () => {
  await withService(async (service, store) => {
    const created = await service.create({
      conversationId: CONVERSATION_ID,
      kind: { t: 'chat' },
      config: DEFAULT_CONFIG,
    });
    assert.equal(created.revision, 0);
    assert.equal(created.resolution.status, 'resolved');

    const updated = await service.update(
      created,
      { isRunning: false, queueDepth: 0, hasStartedSession: false },
      {
        conversationId: CONVERSATION_ID,
        commandId: 'command-1',
        expectedRevision: 0,
        patch: {
          kind: 'set_model',
          model: { mode: 'explicit', modelId: 'gpt-5.6-terra' },
        },
      }
    );
    assert.equal(updated.ok, true);
    if (!updated.ok) return;
    assert.equal(updated.value.next.revision, 1);
    assert.deepEqual(updated.value.next.config.reasoning, { mode: 'default' });
    assert.deepEqual((await store.getByConversationId(CONVERSATION_ID))?.lastResolvedConfig, {
      provider: 'codex',
      modelId: 'gpt-5.6-terra',
      reasoningEffort: 'xhigh',
    });

    const hydrated = await service.hydrate({
      conversationId: CONVERSATION_ID,
      discoveredKind: { t: 'chat' },
      sessionBindings: [{ provider: 'codex', sessionId: 'native-session' }],
      sessionEvidence: { provider: 'codex', reportedModel: 'gpt-5.4-high' },
    });
    assert.equal(hydrated.migrated, false);
    assert.deepEqual(hydrated.state.config, updated.value.next.config);
    assert.equal(
      (await store.findBySession('codex', 'native-session'))?.conversationId,
      CONVERSATION_ID
    );

    const recoveredByNativeSession = await service.hydrate({
      conversationId: 'native-session',
      discoveredKind: { t: 'chat' },
      sessionBindings: [{ provider: 'codex', sessionId: 'native-session' }],
      sessionEvidence: { provider: 'codex', reportedModel: 'gpt-5.6-sol' },
    });
    assert.equal(recoveredByNativeSession.record.conversationId, CONVERSATION_ID);
    assert.deepEqual(recoveredByNativeSession.state.config, updated.value.next.config);

    assert.equal(await service.delete(CONVERSATION_ID), true);
    assert.equal((await store.getByConversationId(CONVERSATION_ID))?.status, 'deleted');
    assert.equal(await service.purge(CONVERSATION_ID), true);
    assert.equal(await store.getByConversationId(CONVERSATION_ID), undefined);
  });
});

test('Fable session hydration recovers reported model names and preserves saved selections', async () => {
  await withService(async (service, store) => {
    const sessionEvidence = {
      provider: 'claude' as const,
      reportedModel: 'claude-fable-5-1',
      source: 'external_session' as const,
    };
    const imported = await service.hydrate({
      conversationId: CONVERSATION_ID,
      discoveredKind: { t: 'chat' },
      sessionBindings: [{ provider: 'claude', sessionId: 'imported-fable-session' }],
      sessionEvidence,
    });
    assert.equal(imported.migrated, true);
    assert.deepEqual(imported.diagnostics, []);
    assert.deepEqual((await store.getByConversationId(CONVERSATION_ID))?.config, {
      provider: 'claude',
      model: { mode: 'explicit', modelId: 'fable' },
      reasoning: { mode: 'disabled' },
    });
    assert.equal(imported.record.lastResolvedConfig?.modelId, 'fable');

    const savedConfig: ConversationConfig = {
      provider: 'claude',
      model: { mode: 'explicit', modelId: 'opus' },
      reasoning: { mode: 'explicit', effort: 'high' },
    };
    await service.create({ kind: { t: 'chat' }, conversationId: FORK_ID, config: savedConfig });
    const existing = await service.hydrate({
      conversationId: FORK_ID,
      discoveredKind: { t: 'chat' },
      sessionBindings: [{ provider: 'claude', sessionId: 'saved-claude-session' }],
      sessionEvidence,
    });
    assert.equal(existing.migrated, false);
    assert.deepEqual(existing.state.config, savedConfig);
    assert.deepEqual((await store.getByConversationId(FORK_ID))?.config, savedConfig);
  });
});

test('matching create replay recovers crash metadata without duplicating the record', async () => {
  await withService(async (service, store) => {
    const input = {
      conversationId: CONVERSATION_ID,
      kind: { t: 'chat' } as const,
      config: DEFAULT_CONFIG,
      workingDirectory: '/tmp/project',
      creation: {
        commandId: 'create-command',
        fingerprint: 'request-fingerprint',
        initialMessage: 'Start here',
      },
    };
    const concurrent = await Promise.all([
      service.createOrReplay(input),
      service.createOrReplay(input),
    ]);
    assert.deepEqual(concurrent.map((result) => result.replayed).sort(), [false, true]);

    const replayed = await service.createOrReplay(input);
    assert.equal(replayed.replayed, true);
    assert.equal(replayed.record.workingDirectory, '/tmp/project');
    assert.equal(replayed.record.creation?.initialMessage, 'Start here');
    assert.equal((await store.listSummaries()).length, 1);

    await assert.rejects(
      service.createOrReplay({
        ...input,
        creation: { ...input.creation, fingerprint: 'different-request' },
      }),
      ConfigRevisionConflictError
    );
  });
});

test('current session rotation is authoritative and tombstones block hydration', async () => {
  await withService(async (service, store) => {
    await service.create({
      conversationId: CONVERSATION_ID,
      kind: { t: 'chat' },
      config: DEFAULT_CONFIG,
      currentSession: { provider: 'codex', sessionId: 'session-1' },
    });
    await service.setCurrentSession(CONVERSATION_ID, {
      provider: 'codex',
      sessionId: 'session-2',
    });
    const rotated = await service.getRecord(CONVERSATION_ID);
    assert.equal(rotated?.currentSession?.sessionId, 'session-2');
    assert.equal(rotated?.sessionBindings[0]?.sessionId, 'session-1');

    await service.delete(CONVERSATION_ID);
    await assert.rejects(
      service.hydrate({
        conversationId: 'session-2',
        discoveredKind: { t: 'chat' },
        sessionBindings: [{ provider: 'codex', sessionId: 'session-2' }],
        sessionEvidence: { provider: 'codex', reportedModel: 'gpt-5.6-sol' },
      }),
      ConversationTombstonedError
    );
    assert.equal((await store.findBySession('codex', 'session-2'))?.status, 'deleted');
  });
});

test('updates reject stale revisions and unavailable combinations without persisting', async () => {
  await withService(async (service, store) => {
    const created = await service.create({
      conversationId: CONVERSATION_ID,
      kind: { t: 'chat' },
      config: DEFAULT_CONFIG,
    });
    const stale = await service.update(
      created,
      { isRunning: false, queueDepth: 0, hasStartedSession: false },
      {
        conversationId: CONVERSATION_ID,
        commandId: 'stale',
        expectedRevision: 10,
        patch: { kind: 'set_reasoning', reasoning: { mode: 'disabled' } },
      }
    );
    assert.equal(stale.ok, false);
    if (!stale.ok) assert.equal(stale.error.code, 'revision_conflict');

    const unavailable = await service.update(
      created,
      { isRunning: false, queueDepth: 0, hasStartedSession: false },
      {
        conversationId: CONVERSATION_ID,
        commandId: 'bad',
        expectedRevision: 0,
        patch: {
          kind: 'set_model',
          model: { mode: 'explicit', modelId: 'retired-model' },
        },
      }
    );
    assert.equal(unavailable.ok, false);
    assert.equal((await store.getByConversationId(CONVERSATION_ID))?.configRevision, 0);
  });
});

// Pattern: fix-guards (docs/patterns.md#fix-guards). config-store.ts
// serialized config writes with in-memory promise locks, which covered one
// process; the records store compares-and-sets inside its own write
// transaction (T23b). Two services on two connections (the shape of two
// processes) update from the same revision: exactly one may commit, and the
// loser must be told the winner's revision, never overwrite it.
test('two writers updating from one revision: one commits, the other gets revision_conflict', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unleashd-config-cas-'));
  try {
    const services = [recordStore(root), recordStore(root)].map(
      (store) => new ConversationConfigService({ store, resolver })
    );
    const created = await services[0].create({
      conversationId: CONVERSATION_ID,
      kind: { t: 'chat' },
      config: DEFAULT_CONFIG,
    });
    const idle = { isRunning: false, queueDepth: 0, hasStartedSession: false };
    const results = await Promise.all(
      (['low', 'high'] as const).map((effort, i) =>
        services[i].update(created, idle, {
          conversationId: CONVERSATION_ID,
          commandId: effort,
          expectedRevision: 0,
          patch: { kind: 'set_reasoning', reasoning: { mode: 'explicit', effort } },
        })
      )
    );
    const winners = results.flatMap((r) => (r.ok ? [r.value] : []));
    const losers = results.flatMap((r) => (r.ok ? [] : [r.error]));
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.equal(losers[0].code, 'revision_conflict');
    assert.match(losers[0].message, /expected 0, actual 1/);
    const stored = await recordStore(root).getByConversationId(CONVERSATION_ID);
    assert.equal(stored?.configRevision, 1);
    assert.equal(stored?.provenance, 'user');
    assert.deepEqual(stored?.config, winners[0].next.config);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Opening a missing records file creates an EMPTY store: a data dir that still
// holds the JSON records would boot with every conversation's config gone.
test('a data dir with unimported JSON records refuses to boot', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'unleashd-records-unimported-'));
  try {
    await mkdir(path.join(root, 'conversation-config', 'v1', 'by-conversation'), {
      recursive: true,
    });
    const location = recordsLocation(root);
    assert.equal(location.t, 'unimported');
    await assert.rejects(openRecords(location), /one-time records import[\s\S]*03fc931/);
    await assert.rejects(access(location.file), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('create and fork require a currently resolved configuration', async () => {
  await withService(async (service) => {
    await assert.rejects(
      service.create({
        conversationId: CONVERSATION_ID,
        kind: { t: 'chat' },
        config: {
          ...DEFAULT_CONFIG,
          model: { mode: 'explicit', modelId: 'retired-model' },
        },
      }),
      ConversationConfigResolutionError
    );
  });
});

test('session hydration never guesses an unknown reported model', async () => {
  await withService(async (service) => {
    // A future Codex id ending in an effort-like suffix is unknown, not decomposed.
    const futureSuffix = await service.hydrate({
      conversationId: CONVERSATION_ID,
      discoveredKind: { t: 'chat' },
      sessionBindings: [{ provider: 'codex', sessionId: 'future-codex' }],
      sessionEvidence: {
        provider: 'codex',
        reportedModel: 'gpt-example-ultra',
        source: 'external_session',
      },
    });
    assert.deepEqual(futureSuffix.state.config.model, { mode: 'default' });
    assert.deepEqual(futureSuffix.state.config.reasoning, { mode: 'disabled' });
    assert.equal(futureSuffix.record.provenance, 'external_discovered');
    assert.equal(futureSuffix.diagnostics[0]?.code, 'unknown_reported_model');

    const futureFable = await service.hydrate({
      conversationId: FORK_ID,
      discoveredKind: { t: 'chat' },
      sessionBindings: [{ provider: 'claude', sessionId: 'future-fable' }],
      sessionEvidence: { provider: 'claude', reportedModel: 'claude-fable-future' },
    });
    assert.deepEqual(futureFable.state.config.model, { mode: 'default' });
    assert.equal(futureFable.diagnostics[0]?.code, 'unknown_reported_model');
  });
});

// Pattern: fix-guards (docs/patterns.md#fix-guards)
test('an invalidated session stays fresh after hydration', async () => {
  await withService(async (service, store) => {
    await service.create({
      conversationId: CONVERSATION_ID,
      kind: { t: 'chat' },
      config: DEFAULT_CONFIG,
      currentSession: { provider: 'codex', sessionId: 'missing-rollout' },
    });
    await service.invalidateCurrentSession(CONVERSATION_ID, 'missing-rollout');
    const hydrated = await service.hydrate({
      conversationId: CONVERSATION_ID,
      discoveredKind: { t: 'chat' },
      sessionBindings: [],
      sessionEvidence: { provider: 'codex' },
    });
    assert.equal(hydrated.record.currentSession, undefined);
    assert.equal(hydrated.record.sessionBindings[0]?.sessionId, 'missing-rollout');
    assert.equal(
      (await store.findBySession('codex', 'missing-rollout'))?.conversationId,
      CONVERSATION_ID
    );
    await service.setCurrentSession(CONVERSATION_ID, {
      provider: 'codex',
      sessionId: 'real-thread',
    });
    await service.invalidateCurrentSession(CONVERSATION_ID, 'missing-rollout');
    assert.equal(
      (await service.getRecord(CONVERSATION_ID))?.currentSession?.sessionId,
      'real-thread'
    );
  });
});
