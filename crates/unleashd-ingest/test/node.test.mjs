// The TS boundary: load the built addon, ingest a temp root, watch an append arrive through
// onChange, page it with `since`, and stop so the process can exit. Run `pnpm run build` first.
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const { Ingest, defaultRoots } = createRequire(import.meta.url)('../index.js');

const line = (type, content, extra = {}) =>
  `${JSON.stringify({ type, timestamp: '2026-09-25T10:00:00.000Z', cwd: '/work', message: { content, model: 'claude-opus-5-5' }, ...extra })}\n`;

test('ingest a root, receive an append through onChange, page by revision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'unleashd-ingest-'));
  const project = join(dir, 'claude', '-work');
  mkdirSync(project, { recursive: true });
  const file = join(project, 'sess-1.jsonl');
  writeFileSync(file, line('user', 'hello'));

  const events = [];
  let wake = () => {};
  const ingest = await Ingest.start(
    [
      { format: 'claude', path: join(dir, 'claude') },
      { format: 'codex', path: join(dir, 'missing') },
    ],
    join(dir, 'ingest.sqlite'),
    (event) => {
      events.push(event);
      wake();
    }
  );
  try {
    assert.equal(ingest.initialScan.full, 1);
    assert.deepEqual(ingest.initialScan.missingRoots, [join(dir, 'missing')]);
    const first = await ingest.listSessions({ since: 0 });
    assert.equal(first.rows.length, 1);
    const row = first.rows[0];
    assert.equal(row.sessionId, 'sess-1');
    assert.equal(row.format, 'claude');
    assert.equal(row.provider, 'claude');
    assert.deepEqual(row.cwd, { t: 'transcript', path: '/work' });
    assert.deepEqual(row.identity, { t: 'general' });
    assert.equal(row.timeFrom, 'transcript');
    assert.equal(row.label, 'hello');

    // FSEvents delivers the append; the watcher thread commits it and calls back.
    const changed = new Promise((resolve) => {
      wake = () => events.some((e) => e.t === 'changes' && e.rev > first.rev) && resolve();
    });
    const usage = { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 };
    appendFileSync(
      file,
      `${JSON.stringify({ type: 'assistant', timestamp: '2026-09-25T10:00:00.000Z', cwd: '/work', message: { id: 'r1', model: 'claude-opus-5-5', usage, content: [{ type: 'text', text: 'hi there' }] } })}\n`
    );
    await Promise.race([
      changed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('no onChange within 5 s')), 5000)
      ),
    ]);

    const next = await ingest.listSessions({ since: first.rev });
    assert.deepEqual(
      next.rows.map((r) => [r.sessionId, r.messageCount]),
      [['sess-1', 2]]
    );
    const tail = await ingest.messages('sess-1', { afterSeq: 0, limit: 10 });
    assert.equal(tail.length, 1);
    assert.equal(tail[0].seq, 1);
    assert.equal(tail[0].role, 'assistant');
    assert.equal(tail[0].content, 'hi there');
    assert.equal(typeof tail[0].completedAt, 'number');
    assert.equal((await ingest.session('nope')) ?? null, null);

    // The aggregates: discriminated group keys and optional fields cross the boundary.
    const report = await ingest.usage({ since: 0, groupBy: 'session' });
    assert.equal(report.groups.length, 1);
    assert.deepEqual(report.groups[0].key, {
      t: 'session',
      sessionId: 'sess-1',
      sourcePath: file,
      provider: 'claude',
      format: 'claude',
      model: 'claude-opus-5-5',
    });
    assert.deepEqual(
      [report.groups[0].turns, report.groups[0].input, report.groups[0].cacheWrite],
      [1, 5, 1]
    );
    const days = await ingest.usage({ since: 0, until: Date.parse('2026-09-26'), groupBy: 'day' });
    assert.deepEqual(days.groups[0].key, { t: 'day', day: '2026-09-25' });
    const context = await ingest.latestContext('sess-1');
    assert.equal(context.contextTokens, 8);
    assert.equal(context.compaction ?? null, null);
    assert.equal((await ingest.latestContext('nope')) ?? null, null);
  } finally {
    await ingest.stop();
    await ingest.stop(); // idempotent
  }
});

test('defaultRoots names every provider format', () => {
  const formats = new Set(defaultRoots('/home/x').map((r) => r.format));
  assert.deepEqual([...formats].sort(), [
    'claude',
    'codex',
    'cursor',
    'gemini',
    'muse',
    'opencode',
    'pi',
  ]);
});
