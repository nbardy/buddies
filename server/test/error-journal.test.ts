import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { registerErrorDiagnosticsRoutes } from '../src/http/error-diagnostics-routes';
import { ErrorJournal, installConsoleErrorCapture } from '../src/observability';

test('error journal groups repeats, keeps stack context, redacts secrets, and reopens recurrence', async (t) => {
  const directory = await temporaryDirectory(t);
  let timestamp = Date.parse('2026-09-15T00:00:00.000Z');
  let sequence = 0;
  const journal = new ErrorJournal({
    directory,
    serverBootId: 'boot-1',
    now: () => new Date(timestamp++),
    createId: () => `event-${sequence++}`,
  });
  await journal.initialize();

  const first = await journal.captureConsole('warn', [
    '[buddies] Failed to update conversation 01a09f69-2b0c-72f2-9c6f-50a28ac72008:',
    Object.assign(new Error('conversation link not found: 01a09f69-2b0c-72f2-9c6f-50a28ac72008'), {
      token: 'must-not-be-serialized',
    }),
  ]);
  const repeated = await journal.captureConsole('warn', [
    '[buddies] Failed to update conversation 1be773df-1f2b-4ce1-b46b-3ee707e27166:',
    new Error('conversation link not found: 1be773df-1f2b-4ce1-b46b-3ee707e27166'),
  ]);

  assert.equal(first.fingerprint, repeated.fingerprint);
  assert.equal(repeated.count, 2);
  assert.equal(repeated.component, 'buddies');
  assert.equal(repeated.context?.conversationId, '1be773df-1f2b-4ce1-b46b-3ee707e27166');
  assert.match(repeated.stack ?? '', /conversation link not found/);

  const acknowledged = await journal.acknowledge(repeated.fingerprint, 'Patched token=private');
  assert.equal(acknowledged.status, 'acknowledged');
  assert.equal(acknowledged.acknowledgementNote, 'Patched token=[REDACTED]');
  assert.equal((await journal.queryGroups()).length, 0);

  const reopened = await journal.captureConsole('warn', [
    '[buddies] Failed to update conversation 01a09f69-2b0c-72f2-9c6f-50a28ac72008:',
    new Error('conversation link not found: 01a09f69-2b0c-72f2-9c6f-50a28ac72008'),
  ]);
  assert.equal(reopened.status, 'unresolved');
  assert.equal(reopened.count, 3);

  const persisted = await fs.promises.readFile(path.join(directory, 'errors.jsonl'), 'utf8');
  assert.doesNotMatch(persisted, /must-not-be-serialized|token=private/);
  assert.match(persisted, /token=\[REDACTED\]/);
});

test('provider failures group across Buddy run ids and keep distinct causes separate after restart', async (t) => {
  const directory = await temporaryDirectory(t);
  const journal = new ErrorJournal({ directory });
  await journal.initialize();
  const ids = [
    'buddy-run-run_01a10b40-64b1-73a1-bdf2-61671350a6c0',
    'buddy-run-run_01a10b2f-2be7-72c4-9db6-ec208cb3c64d',
  ];
  const target = { error: (..._values: unknown[]) => {}, warn: (..._values: unknown[]) => {} };
  const restore = installConsoleErrorCapture(journal, target);
  t.after(restore);
  for (const id of ids) {
    target.error(`[${id}] Provider error: Selected model is at capacity.`);
  }
  target.error(`[${ids[1]}] Provider error: 403 Forbidden`);
  await journal.flush();

  const recovered = new ErrorJournal({ directory });
  await recovered.initialize();
  const groups = await recovered.queryGroups();
  assert.equal(groups.length, 2, 'run identity must not split the same provider failure');
  const capacity = groups.find((group) => group.message.includes('at capacity'));
  assert.equal(capacity?.count, 2);
  assert.match(capacity?.message ?? '', new RegExp(ids[1]));
  assert.match(capacity?.stack ?? '', /Provider error: Selected model is at capacity/);
});

test('error journal survives restart and bounds rotated files', async (t) => {
  const directory = await temporaryDirectory(t);
  const first = new ErrorJournal({
    directory,
    serverBootId: 'boot-1',
    maxBytes: 1_024,
    maxRotatedFiles: 2,
  });
  await first.initialize();
  for (let index = 0; index < 12; index += 1) {
    await first.capture({
      severity: 'error',
      component: 'fixture',
      message: `Distinct failure ${index}: ${'x'.repeat(120)}`,
      stack: `Error: failure ${index}\n    at fixture (/tmp/example.ts:${index + 1}:2)`,
    });
  }
  await first.flush();

  const recovered = new ErrorJournal({
    directory,
    serverBootId: 'boot-2',
    maxBytes: 1_024,
    maxRotatedFiles: 2,
  });
  await recovered.initialize();
  assert.ok((await recovered.queryGroups({ status: 'all' })).length > 0);
  assert.ok(
    (await fs.promises.readdir(directory)).filter((name) => name.startsWith('errors.jsonl'))
      .length <= 3
  );
});

test('installed console boundary persists caught operational failures', async (t) => {
  const directory = await temporaryDirectory(t);
  const journal = new ErrorJournal({ directory, serverBootId: 'console-boot' });
  await journal.initialize();
  const forwarded: Array<{ severity: 'error' | 'warn'; values: unknown[] }> = [];
  const target = {
    error: (...values: unknown[]) => forwarded.push({ severity: 'error', values }),
    warn: (...values: unknown[]) => forwarded.push({ severity: 'warn', values }),
  };
  const restore = installConsoleErrorCapture(journal, target);
  t.after(restore);

  const failure = new Error(
    'Database write failed for conversation 01a09f69-2b0c-72f2-9c6f-50a28ac72008'
  );
  target.error('[buddy-run] Caught execution failure:', failure);
  await journal.flush();

  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0]?.severity, 'error');
  const [group] = await journal.queryGroups();
  assert.equal(group?.component, 'buddy-run');
  assert.equal(group?.context?.conversationId, '01a09f69-2b0c-72f2-9c6f-50a28ac72008');
  assert.match(group?.stack ?? '', /Database write failed/);
});

test('error diagnostics API lists and acknowledges an unresolved group', async (t) => {
  const directory = await temporaryDirectory(t);
  const journal = new ErrorJournal({ directory, serverBootId: 'api-boot' });
  await journal.initialize();
  const captured = await journal.capture({
    severity: 'error',
    component: 'api-fixture',
    message: 'Something actionable failed',
    stack: 'Error: Something actionable failed\n    at fixture (/tmp/api.ts:1:2)',
  });
  const app = express();
  app.use(express.json());
  registerErrorDiagnosticsRoutes(app, journal);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const listed = (await fetch(`${baseUrl}/api/diagnostics/errors`).then((response) =>
    response.json()
  )) as { groups: Array<{ fingerprint: string }> };
  assert.deepEqual(
    listed.groups.map((group) => group.fingerprint),
    [captured.fingerprint]
  );

  const acknowledgement = await fetch(
    `${baseUrl}/api/diagnostics/errors/${captured.fingerprint}/acknowledge`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'Verified by focused regression' }),
    }
  );
  assert.equal(acknowledgement.status, 200);
  assert.equal((await journal.queryGroups()).length, 0);
  assert.equal((await journal.queryGroups({ status: 'acknowledged' })).length, 1);
});

test('error diagnostics API bounds and rate-limits client reports into the shared journal', async (t) => {
  const directory = await temporaryDirectory(t);
  const journal = new ErrorJournal({ directory, serverBootId: 'client-api-boot' });
  await journal.initialize();
  const app = express();
  app.use(express.json());
  registerErrorDiagnosticsRoutes(app, journal, { clientReportLimit: 1 });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}/api/diagnostics/errors/client`;

  const invalid = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'console-warn', message: 'Expected noise' }),
  });
  assert.equal(invalid.status, 400);

  const accepted = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      source: 'react-boundary',
      message: 'Render failed token=private',
      stack: 'Error: Render failed\n    at Chat (/client/src/Chat.tsx:10:2)',
      route: '/chat/token=private',
    }),
  });
  assert.equal(accepted.status, 202);

  const limited = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'browser-error', message: 'A second failure' }),
  });
  assert.equal(limited.status, 429);

  const [group] = await journal.queryGroups();
  assert.equal(group?.component, 'client.react-boundary');
  assert.equal(group?.message, 'Render failed token=[REDACTED]');
  assert.equal(group?.context?.origin, 'client');
  assert.equal(group?.context?.route, '/chat/token=[REDACTED]');
});

async function temporaryDirectory(t: test.TestContext): Promise<string> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'unleashd-errors-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  return directory;
}
