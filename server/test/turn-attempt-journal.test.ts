import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TurnAttempts } from '@unleashd/ingest';
import type { StructuredObservabilityLogger } from '../src/observability';
import { TurnAttemptJournal, createJournalTurnAttemptObserver } from '../src/observability';

const silentLogger: StructuredObservabilityLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
async function temporaryDirectory(t: test.TestContext): Promise<string> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'unleashd-attempts-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('SQLite attempt history preserves exact outcome, correlation, and indexed latest order', async (t) => {
  const directory = await temporaryDirectory(t);
  let clock = Date.parse('2026-07-29T00:00:00.000Z');
  const journal = new TurnAttemptJournal({
    directory,
    serverBootId: 'boot-1',
    now: () => new Date(clock++),
    logger: silentLogger,
  });
  await journal.initialize(new Set());
  await journal.startAttempt({ attemptId: 'a1', conversationId: 'c1', queueMessageId: 'q1' });
  await journal.transitionAttempt({ attemptId: 'a1', state: 'starting' });
  await journal.transitionAttempt({ attemptId: 'a1', state: 'running', providerSessionId: 's1' });
  await journal.touchAttempt({
    attemptId: 'a1',
    activity: {
      source: 'agent_cli_heartbeat',
      providerEventType: 'progress',
      heartbeat: { phase: 'startup', rawStdoutSilentSeconds: 30 },
    },
  });
  const failed = await journal.finishAttempt({
    attemptId: 'a1',
    state: 'failed',
    terminalCause: 'provider_idle_timeout',
  });
  await journal.startAttempt({ attemptId: 'a2', conversationId: 'c1', queueMessageId: 'q2' });
  assert.equal(failed.queueMessageId, 'q1');
  assert.equal(failed.providerSessionId, 's1');
  assert.equal(failed.terminalCause, 'provider_idle_timeout');
  assert.equal(failed.lastBridgeActivityAt, failed.lastActivityAt);
  assert.equal(failed.lastProviderProgressAt, undefined);
  assert.deepEqual(
    (await journal.queryAttempts({ conversationId: 'c1', limit: 1 })).map((a) => a.attemptId),
    ['a2']
  );
  assert.equal((await journal.queryAttempts({ providerSessionId: 's1' }))[0]?.attemptId, 'a1');
  assert.equal((await journal.recentEvents({ attemptId: 'a1' })).length, 5);
  assert.equal(
    (await journal.recentEvents({ conversationId: 'c1', limit: 1 }))[0]?.kind,
    'attempt_created'
  );
  assert.equal(
    (await fs.promises.readdir(directory)).some((name) => name.endsWith('.jsonl')),
    false
  );
});

test('observer queues asynchronous observations and boot recovery interrupts only old active attempts', async (t) => {
  const directory = await temporaryDirectory(t);
  const first = new TurnAttemptJournal({ directory, serverBootId: 'boot-1', logger: silentLogger });
  await first.initialize(new Set());
  const observer = createJournalTurnAttemptObserver(first, silentLogger);
  observer.queued({ attemptId: 'active', conversationId: 'c1', queueMessageId: 'q1' });
  observer.starting('active');
  observer.running('active', 's1');
  observer.bindProviderSession('active', 's2');
  observer.activity(
    'active',
    {
      source: 'native_session',
      providerEventType: 'progress',
      heartbeat: { nativeSessionAdvanced: true, nativeSessionSizeBytes: 123 },
    },
    's2'
  );
  observer.queued({ attemptId: 'done', conversationId: 'c1' });
  observer.terminal({ attemptId: 'done', state: 'failed', terminalCause: 'spawn_failed' });
  await first.flush();
  const active = await first.getAttempt('active');
  assert.equal(active?.providerSessionId, 's2');
  assert.equal(active?.queueMessageId, 'q1');
  assert.equal(active?.lastProviderProgressAt, active?.lastActivityAt);
  assert.equal(active?.lastActivity?.heartbeat?.nativeSessionSizeBytes, 123);
  const second = new TurnAttemptJournal({
    directory,
    serverBootId: 'boot-2',
    logger: silentLogger,
  });
  assert.equal((await second.initialize(new Set())).recoveredAttempts, 1);
  assert.equal((await second.getAttempt('active'))?.terminalCause, 'server_restart');
  assert.equal((await second.getAttempt('done'))?.terminalCause, 'spawn_failed');
  assert.equal(
    (await second.recentEvents({ attemptId: 'active' })).at(-1)?.kind,
    'attempt_recovered'
  );
});

test('legacy import is atomic, keeps original bytes, and makes source-less activity explicit', async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, 'turn-attempts.jsonl');
  const event = (kind: string, eventId: string, fields: Record<string, unknown>) => ({
    schemaVersion: 1,
    kind,
    eventId,
    serverBootId: 'old',
    timestamp: '2026-07-29T00:00:00.000Z',
    attemptId: 'legacy',
    conversationId: 'c1',
    ...fields,
  });
  const old = [
    JSON.stringify(event('attempt_created', 'e1', { state: 'queued', queueMessageId: 'q1' })),
    JSON.stringify(
      event('attempt_state_changed', 'e2', { previousState: 'queued', state: 'starting' })
    ),
    JSON.stringify(
      event('attempt_state_changed', 'e3', { previousState: 'starting', state: 'running' })
    ),
    JSON.stringify(event('attempt_activity', 'e4', { state: 'running' })),
    '{"kind":"partial',
  ].join('\n');
  await fs.promises.writeFile(file, old);
  const journal = new TurnAttemptJournal({ directory, serverBootId: 'new', logger: silentLogger });
  await journal.initialize(new Set());
  const imported = await journal.getAttempt('legacy');
  assert.equal(imported?.lastActivity?.source, 'legacy_unknown');
  assert.equal(imported?.queueMessageId, 'q1');
  assert.equal(imported?.terminalCause, 'server_restart');
  assert.equal(await fs.promises.readFile(file, 'utf8'), old);
  assert.equal((await journal.recentEvents({ attemptId: 'legacy' })).length, 5);
  const reopened = new TurnAttemptJournal({
    directory,
    serverBootId: 'newer',
    logger: silentLogger,
  });
  await reopened.initialize(new Set());
  assert.equal((await reopened.recentEvents({ attemptId: 'legacy' })).length, 5);
});

test('unreadable legacy source does not mark an empty import complete', async (t) => {
  const directory = await temporaryDirectory(t);
  const file = path.join(directory, 'turn-attempts.jsonl');
  await fs.promises.writeFile(file, '{"kind":"partial');
  await assert.rejects(
    new TurnAttemptJournal({ directory, logger: silentLogger }).initialize(new Set()),
    /no readable events/
  );
  assert.equal(await fs.promises.readFile(file, 'utf8'), '{"kind":"partial');
  const store = await TurnAttempts.open(path.join(directory, 'turn-attempts.sqlite'));
  assert.deepEqual(
    await store.query(undefined, undefined, undefined, undefined, undefined, 100),
    []
  );
});
