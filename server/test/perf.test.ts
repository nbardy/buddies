/**
 * Perf telemetry on real files: route latency aggregation, boot phases, the
 * debug-profile route, and the `pnpm perf:audit` report built from a fixture dir.
 *
 * What would re-break: wrong percentile math (off-by-one nearest rank), volatile
 * ids leaking into route keys (every request a new row), the audit ranking by
 * volume instead of the stall label/route that is actually worst, or the profile
 * route being callable twice at once (the inspector allows one profile).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { type MachineSnapshot, buildReport } from '../../tools/perf-audit';
import { registerDebugProfileRoutes } from '../src/http/debug-profile-routes';
import {
  RouteLatencyRecorder,
  bootPhase,
  captureCpuProfile,
  normalizeRoute,
  timeBootPhaseAsync,
} from '../src/observability/perf';
import { flushPerf } from '../src/observability/perf-log';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'unleashd-perf-'));
const readJsonl = (file: string) =>
  fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

test('route recorder: nearest-rank p50/p90 per minute, ids normalized, current minute held back', () => {
  const written: Record<string, unknown>[] = [];
  const recorder = new RouteLatencyRecorder((record) => written.push(record));
  const minute = 60_000 * 1000;
  for (let ms = 1; ms <= 10; ms += 1)
    recorder.record(
      'GET',
      normalizeRoute('/api/buddies/posts/post_0123456789abcdef/thread'),
      ms,
      minute
    );
  recorder.record('GET', '/api/x', 5, minute + 1_000);
  assert.equal(written.length, 0, 'an open minute must not be written yet');
  recorder.record('GET', '/api/x', 5, minute + 61_000);
  const thread = written.find((r) => r.route === '/api/buddies/posts/:id/thread');
  assert.ok(thread, `ids must collapse to :id, got ${JSON.stringify(written)}`);
  assert.equal(thread.count, 10);
  assert.equal(thread.p50, 5);
  assert.equal(thread.p90, 9);
  assert.equal(thread.max, 10);
});

test('normalizeRoute collapses uuids, prefixed ids and numeric segments', () => {
  assert.equal(
    normalizeRoute('/api/c/123e4567-e89b-12d3-a456-426614174000/messages/42?afterSeq=1'),
    '/api/c/:id/messages/:id'
  );
});

test('boot phases append {bootId, source, phase, ms, at} using the supervisor boot id', async () => {
  const directory = tmp();
  process.env.UNLEASHD_DATA_DIR = directory;
  process.env.UNLEASHD_BOOT_ID = 'boot-test-1';
  try {
    bootPhase('listening', 12.34);
    await timeBootPhaseAsync('warm', async () => 1);
    await flushPerf();
    const [first, second] = readJsonl(path.join(directory, 'observability/perf/boot.jsonl'));
    assert.equal(first.bootId, 'boot-test-1');
    assert.equal(first.source, 'backend');
    assert.equal(first.phase, 'listening');
    assert.equal(first.ms, 12.3);
    assert.equal(second.phase, 'warm');
  } finally {
    Reflect.deleteProperty(process.env, 'UNLEASHD_DATA_DIR');
    Reflect.deleteProperty(process.env, 'UNLEASHD_BOOT_ID');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('POST /api/debug/profile writes a loadable .cpuprofile; a concurrent capture gets 409', async () => {
  const directory = tmp();
  process.env.UNLEASHD_DATA_DIR = directory;
  const app = express();
  registerDebugProfileRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const first = fetch(`${base}/api/debug/profile?ms=600`, { method: 'POST' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await fetch(`${base}/api/debug/profile?ms=600`, { method: 'POST' });
    assert.equal(second.status, 409);
    const body = (await (await first).json()) as { path: string };
    assert.ok(body.path.startsWith(path.join(directory, 'observability/perf/profiles')));
    const profile = JSON.parse(fs.readFileSync(body.path, 'utf8'));
    assert.ok(Array.isArray(profile.nodes) && profile.nodes.length > 0);
  } finally {
    server.close();
    Reflect.deleteProperty(process.env, 'UNLEASHD_DATA_DIR');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('captureCpuProfile releases the profiler after a capture so the next one succeeds', async () => {
  const directory = tmp();
  try {
    await captureCpuProfile(50, 'a', directory);
    await captureCpuProfile(50, 'b', directory);
    assert.equal(fs.readdirSync(directory).length, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const calmMachine: MachineSnapshot = {
  load: [1, 1, 1],
  cpus: 10,
  totalMemBytes: 24 * 1024 ** 3,
  availableMemBytes: 12 * 1024 ** 3,
  swapUsedMb: 0,
  swapTotalMb: 0,
  processes: { node: 3, codex: 0, claude: 1 },
};

test('perf:audit report: latest boot vs median, top stall label, slowest route, overload note', () => {
  const dataDir = tmp();
  const perf = path.join(dataDir, 'observability', 'perf');
  fs.mkdirSync(perf, { recursive: true });
  const nowMs = Date.parse('2026-10-23T12:00:00Z');
  const at = (minutesAgo: number) => new Date(nowMs - minutesAgo * 60_000).toISOString();
  const jsonl = (file: string, rows: object[]) =>
    fs.writeFileSync(path.join(perf, file), rows.map((r) => JSON.stringify(r)).join('\n'));
  jsonl('boot.jsonl', [
    { bootId: 'b1', source: 'backend', phase: 'ingest', ms: 100, at: at(300) },
    { bootId: 'b2', source: 'backend', phase: 'ingest', ms: 300, at: at(200) },
    { bootId: 'b3', source: 'backend', phase: 'ingest', ms: 2000, at: at(10) },
  ]);
  jsonl('stalls.jsonl', [
    { at: at(5), ms: 900, label: 'timer swarm-observer' },
    { at: at(4), ms: 300, label: 'GET /api/buddies/posts/post_0123456789abcdef/thread' },
    { at: at(3), ms: 200, label: 'GET /api/buddies/posts/post_fedcba9876543210/thread' },
    { at: at(2), ms: 70_000, label: 'startup' },
  ]);
  const minute = (route: string, p90: number, count: number) => ({
    at: at(5),
    method: 'GET',
    route,
    count,
    p50: 5,
    p90,
    max: p90 * 2,
  });
  jsonl('routes.jsonl', [minute('/api/fast', 20, 500), minute('/api/slow', 800, 3)]);

  const report = buildReport({
    dataDir,
    buddiesDir: path.join(dataDir, 'none'),
    nowMs,
    days: 7,
    machine: { ...calmMachine, load: [40, 30, 20] },
  });
  assert.match(
    report,
    /\| backend:ingest \| 2000 \| 200 \| \+1800 \|/,
    'median of 100 and 300 is 200'
  );
  assert.match(
    report,
    /\| GET \/api\/buddies\/posts\/post_ID\/thread \| 2 \| 300 \|/,
    'ids fold into one label'
  );
  assert.doesNotMatch(report, /\| startup \|/, 'a 70 s stall is a laptop suspend, not a stall');
  const slow = report.indexOf('GET /api/slow');
  assert.ok(slow > 0 && slow < report.indexOf('GET /api/fast'), 'ranked by p90, not by volume');
  assert.match(report, /\| GET \/api\/slow \| 3 \| 5 \| 800 \| 800 \| 1600 \|/);
  assert.match(report, /Check first: the machine is overloaded/);

  const calm = buildReport({ dataDir, buddiesDir: dataDir, nowMs, days: 7, machine: calmMachine });
  assert.doesNotMatch(calm, /Check first/);
  fs.rmSync(dataDir, { recursive: true, force: true });
});
