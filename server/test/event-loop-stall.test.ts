/**
 * The stall monitor against a REAL error journal on disk: a genuine synchronous
 * block of the event loop must land as one grouped `event-loop` occurrence that
 * names the activity noted before it, and an idle loop must record nothing.
 *
 * What would re-break: computing drift from the wrong baseline (every tick then
 * reads as a stall, or none does), losing the activity label, or journaling
 * every repeat of the same stall instead of summarizing within the window.
 * The continuous profiler's own test is continuous-profiler.test.ts.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ErrorJournal } from '../src/observability/error-journal';
import {
  labelled,
  noteActivity,
  startEventLoopStallMonitor,
} from '../src/observability/event-loop-stall';
import { flushPerf } from '../src/observability/perf-log';

function blockEventLoop(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    /* a synchronous stall, like a readFileSync of a large transcript */
  }
}

test('a blocked event loop is journaled once per activity; an idle loop is not', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unleashd-stall-'));
  // Stalls also append to perf/stalls.jsonl under the data dir: never the owner's real one.
  process.env.UNLEASHD_DATA_DIR = directory;
  const journal = new ErrorJournal({ directory });
  await journal.initialize();
  const stop = startEventLoopStallMonitor(journal, { kind: 'off' });
  try {
    await delay(300);
    await journal.flush();
    assert.deepEqual(await journal.queryGroups({ status: 'all' }), [], 'idle loop reported');

    noteActivity('GET /api/usage');
    blockEventLoop(250);
    // 400 ms, not 120: at load ~250 the 100 ms check ran late and both stalls merged into one
    // detection (2026-11-03). Two checks must fit between them for two stalls.jsonl rows.
    await delay(400);
    noteActivity('GET /api/usage');
    blockEventLoop(180);
    await delay(400);
    await journal.flush();

    const groups = await journal.queryGroups({ status: 'all' });
    assert.equal(groups.length, 1);
    const [group] = groups;
    assert.equal(group.component, 'event-loop');
    assert.equal(group.count, 1, 'the second stall in the window must be summarized, not written');
    assert.equal(group.context?.route, 'GET /api/usage');
    const stalledMs = Number(/stalled (\d+)ms/.exec(group.message)?.[1]);
    assert.ok(stalledMs >= 150 && stalledMs < 1_000, `stall measured as ${stalledMs}ms`);

    // perf/stalls.jsonl keeps EVERY stall (the journal summarized the second one away).
    await flushPerf();
    const lines = fs
      .readFileSync(path.join(directory, 'observability', 'perf', 'stalls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].label, 'GET /api/usage');
    assert.equal(lines[0].route, 'GET /api/usage');
    assert.ok(lines[1].ms >= 150);
  } finally {
    await stop();
    Reflect.deleteProperty(process.env, 'UNLEASHD_DATA_DIR');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('labelled() names an otherwise anonymous timer, so its stall is not blamed on the previous activity', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unleashd-stall-label-'));
  process.env.UNLEASHD_DATA_DIR = directory;
  const journal = new ErrorJournal({ directory });
  await journal.initialize();
  const stop = startEventLoopStallMonitor(journal, { kind: 'off' });
  try {
    noteActivity('GET /api/innocent');
    setTimeout(
      labelled('timer hot-poller', () => blockEventLoop(200)),
      10
    );
    await delay(400);
    await flushPerf();
    const [record] = fs
      .readFileSync(path.join(directory, 'observability', 'perf', 'stalls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(record.label, 'timer hot-poller');
    assert.equal(record.route, null);
  } finally {
    await stop();
    Reflect.deleteProperty(process.env, 'UNLEASHD_DATA_DIR');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/** Runs `scenario` under a fresh monitor and returns the labels of the stalls it recorded. */
async function stallLabels(scenario: () => void): Promise<string[]> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unleashd-stall-async-'));
  process.env.UNLEASHD_DATA_DIR = directory;
  const journal = new ErrorJournal({ directory });
  await journal.initialize();
  const stop = startEventLoopStallMonitor(journal, { kind: 'off' });
  try {
    scenario();
    await delay(500);
    await flushPerf();
    return fs
      .readFileSync(path.join(directory, 'observability', 'perf', 'stalls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).label);
  } finally {
    await stop();
    Reflect.deleteProperty(process.env, 'UNLEASHD_DATA_DIR');
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// Regression (2026-11-03): stall storms read "unlabelled (after timer oompa-poll)" because a label
// was one global, so a stall in an awaited continuation of a tick named only the last timer. Would
// re-break if the label stopped following async work (no AsyncLocalStorage, or continuations not
// timed), or if an unrelated stall were again blamed on whichever labelled() body ran last.
test('a stall in an async continuation carries the label of the work that started it', async () => {
  const continued = await stallLabels(() => {
    setTimeout(
      labelled('timer oompa-like', () => {
        void (async () => {
          await delay(30); // the tick's own async work, after its synchronous body returned
          blockEventLoop(200);
        })();
      }),
      10
    );
  });
  assert.deepEqual(continued, ['timer oompa-like (async)']);

  const unrelated = await stallLabels(() => {
    setTimeout(
      labelled('timer quick-poller', () => {}),
      10
    );
    setTimeout(() => blockEventLoop(200), 60); // started under no label
  });
  assert.deepEqual(unrelated, ['unlabelled']);
});

/** Runs fixtures/stall-child.ts; `stopped` SIGSTOPs it for 700 ms. Returns its stalls.jsonl rows. */
async function childStalls(mode: 'busy' | 'stopped'): Promise<{ kind: string; ms: number }[]> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `unleashd-stall-${mode}-`));
  try {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', path.join(__dirname, 'fixtures', 'stall-child.ts'), mode],
      { cwd: path.join(__dirname, '..'), env: { ...process.env, UNLEASHD_DATA_DIR: directory } }
    );
    const exited = new Promise((resolve) => child.once('exit', resolve));
    await new Promise<void>((resolve) =>
      child.stdout.on('data', (chunk: Buffer) => chunk.includes('ready') && resolve())
    );
    if (mode === 'stopped') {
      child.kill('SIGSTOP');
      await delay(700);
      child.kill('SIGCONT');
    }
    await exited;
    return fs
      .readFileSync(path.join(directory, 'observability', 'perf', 'stalls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// Regression (2026-10-29): sleep read as 11-17 minute stalls, blamed on oompa-poll and profiled.
test('a stopped process records a descheduled stall; a blocked loop records a busy one', async () => {
  const stopped = await childStalls('stopped');
  assert.ok(
    stopped.some((s) => s.ms >= 500),
    `no stall seen: ${JSON.stringify(stopped)}`
  );
  assert.deepEqual(
    stopped.filter((s) => s.ms >= 500).map((s) => s.kind),
    ['descheduled']
  );
  const busy = await childStalls('busy');
  assert.deepEqual(
    busy.filter((s) => s.ms >= 500).map((s) => s.kind),
    ['busy']
  );
});
