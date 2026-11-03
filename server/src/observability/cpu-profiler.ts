import fs from 'node:fs';
import inspector from 'node:inspector';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { appendPerf, profilesDirectory } from './perf-log';

/**
 * The ONE owner of the V8 CPU profiler: continuous stall profiling and on-demand captures
 * (`POST /api/debug/profile`, `pnpm perf:profile`) share this module's single inspector session.
 * Pattern: fix-guards (docs/patterns.md#fix-guards)
 *
 * Why continuous (2026-11-03): stall profiles used to start AFTER a stall ended, so they sampled
 * the idle aftermath. Under load one had 80 samples in 5.7 s, its first 3.7 s after the stall.
 * Every saved profile was noise. Now the profiler always runs at a coarse interval and rotates
 * every ROTATE_MS. A window holding a busy stall >= the profile threshold is saved with the stall
 * in it; any other window is dropped. A stall cannot span a rotation: rotating is JS on the same
 * thread the stall blocks. Detection can lag the stall by a check or two, so the stopped window is
 * held for GRACE_MS before it is dropped.
 *
 * Rotation never lets the profiler stop. Fix-guard: the first build rotated with Profiler.stop +
 * Profiler.start, and in a real backend (temp stores, 300 MB of transcripts) each start cost
 * 55-594 ms. V8 tears its code map down when the last profile stops and rebuilds it from every
 * live function on the next start, so rotation was itself a stall every 30 s. Separate inspector
 * sessions do not help either: each has its own V8 profiler, so an overlapping start still cost
 * 300-500 ms. Titled profiles (inspector.console.profile) in ONE session share one V8 profiler, so
 * the next window starts before the last one ends and the code map stays live. Measured in the
 * same real backend: 0.75-3.2 ms per rotation (30 s windows of ~2,560 samples, 90-310 nodes).
 * Only the first start pays the rebuild: 330 ms once, the `stall_monitor` boot phase. An
 * on-demand capture is one more titled profile, so it needs no handoff; it samples at 10 ms too.
 * Every saved window records its `rotateMs` in profiles.jsonl, so the cost stays visible.
 * Guard: server/test/continuous-profiler.test.ts (a named busy function must appear in the saved
 * profile; a manual capture runs alongside).
 *
 * Sampling overhead (2026-11-03, node 24.3, load average ~240 on 10 cores): process CPU, all
 * threads, of a fixed TypeScript-transpile job, median of 9 interleaved rounds: off 1083 ms,
 * 10 ms sampling 1141 ms, 1 ms sampling 1157 ms (minimums 876 / 847 / 976). The 10 ms cost is
 * inside this machine's noise and at most ~5%.
 */

/** Microseconds between samples. 10 ms still puts ~50 samples in a 500 ms stall. */
const SAMPLING_INTERVAL_US = 10_000;
const ROTATE_MS = 30_000;
/** How long a stopped window waits for a stall detected late (one or two 100 ms checks). */
const GRACE_MS = 1_000;
/** Disk cap over every .cpuprofile in the directory, oldest deleted first. */
const MAX_PROFILES = 50;
const MAX_PROFILE_BYTES = 256 * 1024 * 1024;

export interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
  children?: number[];
}

/** The `Profiler.Profile` shape the inspector returns and `.cpuprofile` files hold. */
export interface CpuProfile {
  nodes: ProfileNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

export class ProfilerBusyError extends Error {
  constructor() {
    super('A CPU profile is already being captured');
  }
}

// ---------- the one inspector session ----------

let session: inspector.Session | undefined;
/** Profiles delivered by `Profiler.consoleProfileFinished`, by title, until endProfile takes them. */
const finished = new Map<string, CpuProfile>();
let titles = 0;

function connect(): void {
  if (session) return;
  session = new inspector.Session();
  session.connect();
  session.on('Profiler.consoleProfileFinished', ({ params }) => {
    finished.set(params.title ?? '', params.profile as CpuProfile);
  });
  session.post('Profiler.enable');
  // Applies when the V8 profiler is created, i.e. at the first profile; it is never torn down after.
  session.post('Profiler.setSamplingInterval', { interval: SAMPLING_INTERVAL_US });
}

function beginProfile(kind: 'window' | 'manual'): string {
  connect();
  titles += 1;
  const title = `unleashd-${kind}-${titles}`;
  inspector.console.profile(title);
  return title;
}

/**
 * The in-thread session delivers the finished profile synchronously, inside profileEnd. Relying
 * on that keeps rotation free of async interleaving; if a Node release ever changes it, this
 * throws instead of silently losing windows.
 */
function endProfile(title: string): CpuProfile {
  inspector.console.profileEnd(title);
  const profile = finished.get(title);
  finished.delete(title);
  if (!profile) throw new Error(`CPU profile ${title} was not delivered synchronously`);
  return profile;
}

const fileSafe = (text: string) => text.replace(/[^a-z0-9]+/gi, '-').slice(0, 60) || 'profile';
const stamp = (date: Date) => date.toISOString().replace(/[:.]/g, '-');

async function writeProfile(directory: string, name: string, profile: CpuProfile) {
  await fs.promises.mkdir(directory, { recursive: true });
  const file = path.join(directory, `${name}.cpuprofile`);
  await fs.promises.writeFile(file, JSON.stringify(profile), { mode: 0o600 });
  return file;
}

/** Deletes the oldest profiles until at most MAX_PROFILES files and MAX_PROFILE_BYTES remain. */
async function pruneProfiles(directory: string): Promise<void> {
  const names = (await fs.promises.readdir(directory)).filter((n) => n.endsWith('.cpuprofile'));
  const files = await Promise.all(
    names.map(async (name) => {
      const stat = await fs.promises.stat(path.join(directory, name));
      return { name, bytes: stat.size, mtimeMs: stat.mtimeMs };
    })
  );
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let bytes = 0;
  for (const [index, file] of files.entries()) {
    bytes += file.bytes;
    if (index >= MAX_PROFILES || bytes > MAX_PROFILE_BYTES)
      await fs.promises.rm(path.join(directory, file.name), { force: true });
  }
}

// ---------- continuous stall profiling ----------

/** A busy stall the monitor detected, as it is filed with the window that holds it. */
export interface ProfiledStall {
  at: string;
  ms: number;
  label: string;
  /** performance.now() at detection. */
  detectedAt: number;
}

interface Window {
  title: string;
  startedAt: number;
  startedWall: Date;
  stalls: ProfiledStall[];
}

interface HeldWindow {
  window: Window;
  profile: CpuProfile;
  endedAt: number;
  /** Main-thread cost of ending this window and starting the next. */
  rotateMs: number;
}

export interface ContinuousProfilerOptions {
  directory: string;
  rotateMs?: number;
}

export interface ContinuousProfiler {
  /** Files a stall with the window it happened in (the held one when detection lagged). */
  noteStall: (stall: ProfiledStall) => void;
  /** Called on every stall-monitor check: settles the held window, rotates the live one. */
  tick: (now: number) => void;
  /** Ends profiling; resolves once every profile still owed is on disk. */
  stop: () => Promise<void>;
}

const openWindow = (now: number): Window => ({
  title: beginProfile('window'),
  startedAt: now,
  startedWall: new Date(),
  stalls: [],
});

export function startContinuousProfiler(options: ContinuousProfilerOptions): ContinuousProfiler {
  const directory = options.directory;
  const rotateEveryMs = options.rotateMs ?? ROTATE_MS;
  let live = openWindow(performance.now());
  let held: HeldWindow | undefined;
  let writes: Promise<void> = Promise.resolve();

  const save = (done: HeldWindow) => {
    if (done.window.stalls.length === 0) return;
    const worst = done.window.stalls.reduce((a, b) => (b.ms > a.ms ? b : a));
    const name = `stall-${worst.ms}ms-${fileSafe(worst.label)}-${stamp(done.window.startedWall)}`;
    writes = writes
      .then(async () => {
        const file = await writeProfile(directory, name, done.profile);
        await pruneProfiles(directory);
        await appendPerf('profiles.jsonl', {
          at: new Date().toISOString(),
          file: path.basename(file),
          windowStart: done.window.startedWall.toISOString(),
          windowMs: Math.round(done.endedAt - done.window.startedAt),
          rotateMs: Math.round(done.rotateMs * 100) / 100,
          samples: done.profile.samples.length,
          stalls: done.window.stalls.map(({ at, ms, label }) => ({ at, ms, label })),
        });
      })
      .catch((error) => {
        // stderr, not console.error: that is journaled, and a full disk would feed back into it.
        process.stderr.write(`[cpu-profiler] Failed to save a stall profile: ${String(error)}\n`);
      });
  };

  const settleHeld = () => {
    if (held) save(held);
    held = undefined;
  };

  /** Ends the live window into `held` (settling the previous held one). */
  const endLive = (now: number, rotationStartedAt: number) => {
    const profile = endProfile(live.title);
    settleHeld();
    held = { window: live, profile, endedAt: now, rotateMs: performance.now() - rotationStartedAt };
  };

  return {
    noteStall: (stall) => {
      const startedAt = stall.detectedAt - stall.ms;
      (held && startedAt < held.endedAt ? held.window : live).stalls.push(stall);
    },
    tick: (now) => {
      if (held && now - held.endedAt >= GRACE_MS) settleHeld();
      if (now - live.startedAt < rotateEveryMs) return;
      // The next window starts BEFORE the live one ends, so V8's profiler never stops.
      const started = performance.now();
      const next = openWindow(started);
      endLive(now, started);
      live = next;
    },
    stop: () => {
      endLive(performance.now(), performance.now());
      settleHeld();
      return writes;
    },
  };
}

// ---------- on-demand capture ----------

let manualCapture = false;

/**
 * Samples the main thread for `durationMs` and writes `<directory>/<label>-<ts>.cpuprofile`. It is
 * one more titled profile beside the continuous window, so neither interrupts the other. One
 * capture at a time; a second gets ProfilerBusyError.
 */
export async function captureCpuProfile(
  durationMs: number,
  label: string,
  directory: string = profilesDirectory()
): Promise<string> {
  if (manualCapture) throw new ProfilerBusyError();
  manualCapture = true;
  try {
    const title = beginProfile('manual');
    await delay(durationMs);
    const profile = endProfile(title);
    const file = await writeProfile(directory, `${fileSafe(label)}-${stamp(new Date())}`, profile);
    await pruneProfiles(directory);
    return file;
  } finally {
    manualCapture = false;
  }
}
