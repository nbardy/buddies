/**
 * The continuous CPU profiler against the real V8 inspector and a real profiles directory: a busy
 * stall must leave a .cpuprofile whose hottest code IS the function that stalled, indexed in
 * profiles.jsonl under the stall's label; windows without a stall must leave nothing.
 *
 * Regression (2026-11-03): stall profiles began after the stall ended, so every one sampled the
 * idle aftermath (one held 80 samples in 5.7 s, the first 3.7 s after the stall). Would re-break
 * if capture went back to starting after detection, if a stall detected after a rotation were
 * filed with the wrong window (the held-window grace), or if idle windows were kept.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { summarizeProfile } from '../../tools/perf-audit';
import { captureCpuProfile } from '../src/observability/cpu-profiler';
import { ErrorJournal } from '../src/observability/error-journal';
import { labelled, startEventLoopStallMonitor } from '../src/observability/event-loop-stall';
import { flushPerf } from '../src/observability/perf-log';

/** Burns 700 ms of CPU time, not wall time: on a loaded machine a wall-clock loop can get so
 * little CPU that the monitor rightly calls it `descheduled` and never profiles it. */
function busyWaitForTheProfiler(): number {
  const start = process.cpuUsage();
  const cpuMs = () => {
    const used = process.cpuUsage(start);
    return (used.user + used.system) / 1000;
  };
  // The clock is read rarely so the samples land in this function's own code, not in cpuUsage.
  let sink = 0;
  while (cpuMs() < 700) for (let i = 0; i < 200_000; i += 1) sink = (sink + i * i) % 1_000_003;
  return sink;
}

test('a busy stall is saved with the profile window that holds it; idle windows are dropped', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unleashd-profiler-'));
  process.env.UNLEASHD_DATA_DIR = directory;
  const profiles = path.join(directory, 'observability', 'perf', 'profiles');
  const journal = new ErrorJournal({ directory });
  await journal.initialize();
  const stop = startEventLoopStallMonitor(journal, {
    kind: 'continuous',
    directory: profiles,
    thresholdMs: 500,
    rotateMs: 1_000,
  });
  try {
    await delay(1_500); // at least one idle window rotates out
    assert.equal(fs.existsSync(profiles), false, 'an idle window was saved');

    labelled('timer profiled-tick', busyWaitForTheProfiler)();
    // A manual capture meanwhile must hand off, not collide (one inspector owner).
    await captureCpuProfile(200, 'manual', profiles);
    await delay(2_500); // rotation + grace
  } finally {
    await stop();
    Reflect.deleteProperty(process.env, 'UNLEASHD_DATA_DIR');
  }
  try {
    await flushPerf();
    const stall = fs
      .readFileSync(path.join(directory, 'observability', 'perf', 'stalls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((s) => s.label === 'timer profiled-tick');
    assert.ok(stall, 'the busy wait was not seen as a stall');
    // At load ~250 on 10 cores the loop got under 10% of a core: the monitor rightly calls that
    // descheduled and does not profile it. That is the machine, not this code; say so loudly.
    if (stall.kind === 'descheduled') {
      t.skip(`machine too loaded: ${stall.cpuMs} ms CPU in a ${stall.ms} ms stall`);
      return;
    }
    const index = fs
      .readFileSync(path.join(directory, 'observability', 'perf', 'profiles.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const row = index.find((r) =>
      r.stalls.some((s: { label: string }) => s.label === 'timer profiled-tick')
    );
    assert.ok(row, `no profile indexed for the stall: ${JSON.stringify(index)}`);
    assert.ok(row.stalls[0].ms >= 500);
    const profile = JSON.parse(fs.readFileSync(path.join(profiles, row.file), 'utf8'));
    const top = summarizeProfile(profile).slice(0, 3);
    assert.ok(
      top.some((f) => f.frame.startsWith('busyWaitForTheProfiler ')),
      `stalling function missing from the top self time: ${JSON.stringify(top)}`
    );
    const manualFiles = fs.readdirSync(profiles).filter((f) => f.startsWith('manual-'));
    assert.equal(manualFiles.length, 1, 'the manual capture also lands');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
