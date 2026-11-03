import { AsyncLocalStorage } from 'node:async_hooks';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { promiseHooks } from 'node:v8';
import { type ProfiledStall, startContinuousProfiler } from './cpu-profiler';
import type { ErrorJournal } from './error-journal';
import { appendPerf, profilesDirectory } from './perf-log';

/**
 * Event-loop stall monitor: every pause of the only JS thread longer than
 * Pattern: fix-guards (docs/patterns.md#fix-guards)
 * STALL_THRESHOLD_MS becomes an error-journal occurrence.
 *
 * Why: on 2026-09-25 an authed trivial 404 measured p50 2.5ms but p90 1.16s and
 * max 18.1s on the live dev backend. Nothing recorded those stalls, so each one
 * was found by hand. A stall is invisible from inside the code that causes it;
 * only a timer that fires LATE sees it, after the fact.
 *
 * Detection is `perf_hooks.monitorEventLoopDelay`: a native 10ms timer whose
 * lateness is recorded without entering JS, so a stall's duration is accurate
 * to ~10ms. A plain JS interval measuring its own drift is not enough: a stall
 * that begins partway through the interval reads short by that phase, so with
 * a 50ms interval a 120ms stall could measure under 100ms and be missed. The JS
 * check runs every CHECK_INTERVAL_MS, equal to the threshold, so any stall at
 * or over the threshold makes the check due before the loop resumes.
 *
 * Attribution: HTTP requests, WS commands and the known timers run under a label
 * (`labelled(name, fn)` / `noteActivity(name)`) kept in AsyncLocalStorage, so async
 * work they start carries it too. Each labelled synchronous slice that runs for
 * STALL_THRESHOLD_MS or more is remembered, and a detected stall is attributed to that slice.
 * Code: the continuous CPU profiler (cpu-profiler.ts) saves the window holding the stall.
 *
 * Kind: the histogram counts WALL time, so a process that is not running at all (the machine
 * asleep, or a CPU so oversubscribed the thread is not scheduled) reads as a stall too. The CPU
 * time spent in the window tells them apart: a busy stall burns about its own length.
 */

export const STALL_THRESHOLD_MS = 100;
const CHECK_INTERVAL_MS = STALL_THRESHOLD_MS;
const HISTOGRAM_RESOLUTION_MS = 10;
/** One journal write per activity label per window; repeats are summarized in the next write. */
const REPORT_WINDOW_MS = 60_000;

// ---------- labels that follow async work ----------

// Fix-guard (2026-11-03): one global "last label" blamed every async continuation on whichever
// labelled() timer ran last. In the 2026-10-24..11-03 stall storms most stalls read
// "unlabelled (after timer oompa-poll)" or "(after timer swarm-observer)", which named nothing.
// The label now lives in AsyncLocalStorage, so it follows the work: a stall inside an awaited
// continuation of an Oompa tick reads "timer oompa-poll (async)". Work started under no label
// reads "unlabelled". Guard: the "async continuation" test in event-loop-stall.test.ts.
const activity = new AsyncLocalStorage<string>();

/**
 * A synchronous slice of JS the monitor can name: a labelled() body, the rest of a callback that
 * called noteActivity(), or a promise continuation that runs under a label. A slice of
 * STALL_THRESHOLD_MS or more IS a stall, so only those are kept; the hot path pays two
 * performance.now() calls and nothing else.
 */
interface Run {
  label: string;
  origin: 'sync' | 'async';
  startedAt: number;
  endedAt: number;
}

/** Recent long runs. Detection takes them; each check drops those too old to be its stall. */
let longRuns: Run[] = [];
const MAX_LONG_RUNS = 8;

function endRun(label: string, origin: Run['origin'], startedAt: number): void {
  const endedAt = performance.now();
  if (endedAt - startedAt < STALL_THRESHOLD_MS) return;
  longRuns.push({ label, origin, startedAt, endedAt });
  if (longRuns.length > MAX_LONG_RUNS) longRuns.shift();
}

/**
 * Names the rest of the current callback, and every async continuation it starts, `label`.
 * Call at the top of a request, command or event callback; prefer labelled() for a whole function.
 * The run ends on the next tick, after the callback's synchronous code.
 */
export function noteActivity(label: string): void {
  activity.enterWith(label);
  process.nextTick(endRun, label, 'sync', performance.now());
}

function runLabelled<Args extends unknown[], R>(
  label: string,
  fn: (...args: Args) => R,
  args: Args
): R {
  const startedAt = performance.now();
  try {
    return fn(...args);
  } finally {
    endRun(label, 'sync', startedAt);
  }
}

/**
 * Wraps a timer/event callback so it, and the async work it starts, run under `label`. Use for
 * every recurring timer: `setInterval(labelled('timer foo', tick), ms)`.
 */
export function labelled<Args extends unknown[], R>(
  label: string,
  fn: (...args: Args) => R
): (...args: Args) => R {
  return (...args) => activity.run(label, runLabelled<Args, R>, label, fn, args);
}

// Promise continuations are the "async" runs, timed by v8.promiseHooks rather than
// async_hooks.createHook, which adds its own bookkeeping to every await. Measured 2026-11-03
// (node 24.3, load ~200 on 10 cores, modes interleaved in one process, median ns per op):
// `await null` 504 bare / 846 v8 promise hooks / 2034 async_hooks; an await that then parses
// 1 KB of JSON 22.4 / 23.9 / 26.9 us. Non-promise callbacks (stream events, fs callbacks, a
// nested setTimeout) carry the label in AsyncLocalStorage but are not timed: name them with
// labelled() or noteActivity().
let continuationLabel: string | undefined;
let continuationStartedAt = 0;
function continuationBefore(): void {
  continuationLabel = activity.getStore();
  if (continuationLabel !== undefined) continuationStartedAt = performance.now();
}
function continuationAfter(): void {
  if (continuationLabel !== undefined) endRun(continuationLabel, 'async', continuationStartedAt);
}

type Suspect = { kind: 'run'; run: Run } | { kind: 'unlabelled' };

function suspectLabel(suspect: Suspect): string {
  switch (suspect.kind) {
    case 'run':
      return suspect.run.origin === 'async' ? `${suspect.run.label} (async)` : suspect.run.label;
    case 'unlabelled':
      return 'unlabelled';
  }
}

/**
 * The run that was executing during the stall: the longest recent long run, unless runs overlap
 * it (a labelled() call or noteActivity() inside a labelled continuation). Then the one that
 * started last and still covers half of it is the more specific name.
 */
function takeSuspect(): Suspect {
  const runs = longRuns;
  longRuns = [];
  if (runs.length === 0) return { kind: 'unlabelled' };
  const span = (r: Run) => r.endedAt - r.startedAt;
  const longest = runs.reduce((a, b) => (span(b) > span(a) ? b : a));
  const innermost = runs
    .filter(
      (r) =>
        r.startedAt < longest.endedAt &&
        r.endedAt > longest.startedAt &&
        span(r) >= span(longest) / 2
    )
    .reduce((a, b) => (b.startedAt > a.startedAt ? b : a));
  return { kind: 'run', run: innermost };
}

// ---------- continuous CPU profiling ----------

/** What the monitor does with busy stalls' CPU profiles. Read once at boot. */
export type StallProfiling =
  | { kind: 'off' }
  | { kind: 'continuous'; directory: string; thresholdMs: number; rotateMs?: number };

/** UNLEASHD_CONTINUOUS_PROFILE=0 turns it off; UNLEASHD_STALL_PROFILE_MS (default 500) sets the bar. */
export function stallProfilingFromEnv(env: NodeJS.ProcessEnv = process.env): StallProfiling {
  if (env.UNLEASHD_CONTINUOUS_PROFILE === '0') return { kind: 'off' };
  const configured = Number(env.UNLEASHD_STALL_PROFILE_MS);
  return {
    kind: 'continuous',
    directory: profilesDirectory(env),
    thresholdMs: Number.isFinite(configured) && configured > 0 ? configured : 500,
  };
}

interface StallProfiler {
  noteStall: (stall: ProfiledStall) => void;
  tick: (now: number) => void;
  stop: () => Promise<void>;
}

function startStallProfiler(profiling: StallProfiling): StallProfiler {
  switch (profiling.kind) {
    case 'off':
      return { noteStall: () => {}, tick: () => {}, stop: async () => {} };
    case 'continuous': {
      const profiler = startContinuousProfiler(profiling);
      return {
        ...profiler,
        noteStall: (stall) => {
          if (stall.ms >= profiling.thresholdMs) profiler.noteStall(stall);
        },
      };
    }
  }
}

// Fix-guard (2026-10-29): macOS DarkWake cycles (~16 min apart) recorded 11-17 MINUTE "stalls"
// at loop p99 12 ms, each blamed on `timer oompa-poll` (it fires every second, so it is nearly
// always the last label) and each spending the 10-minute profile budget on an idle profile. 129
// of the 145 1-60 s stalls of 2026-10-24..29 had that signature, and the real ~860 ms bursts of
// 10-27 got no profile at all. Guard: "a stopped process records a descheduled stall" test.
type StallKind = 'busy' | 'descheduled';
/**
 * Below this share of the stall spent on CPU, the process did not run. Measured 2026-11-03 at load
 * 32 on 10 cores: a 612 ms busy loop got 141-379 ms of CPU (23-60%); a SIGSTOPped process 0-2 ms.
 */
const DESCHEDULED_CPU_SHARE = 0.1;
/** Checks run every CHECK_INTERVAL_MS; a few back is enough to reach before any stall's start. */
const CPU_SNAPSHOTS = 8;
const stallKind = (stallMs: number, cpuMs: number): StallKind =>
  cpuMs < stallMs * DESCHEDULED_CPU_SHARE ? 'descheduled' : 'busy';

/** The `route` of a stall record: the HTTP request label ("GET /api/x"), else absent. */
const HTTP_LABEL = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \//;

interface ReportedLabel {
  lastReportedAt: number;
  /** Stalls under this label since `lastReportedAt` that were not written. */
  suppressed: number;
  suppressedMaxMs: number;
}

/**
 * Starts the monitor; returns the function that stops it, which resolves once any stall profile
 * still owed is on disk.
 */
export function startEventLoopStallMonitor(
  journal: Pick<ErrorJournal, 'capture'>,
  profiling: StallProfiling
): () => Promise<void> {
  const reported = new Map<string, ReportedLabel>();
  // First: the first profile start rebuilds V8's code map (330 ms in a real backend, once). It is the
  // `stall_monitor` boot phase; enabling the histogram after it keeps it out of stalls.jsonl.
  const profiler = startStallProfiler(profiling);
  const delay = monitorEventLoopDelay({ resolution: HISTOGRAM_RESOLUTION_MS });
  delay.enable();
  const stopBefore = promiseHooks.onBefore(continuationBefore);
  const stopAfter = promiseHooks.onAfter(continuationAfter);

  const recordStall = (
    stallMs: number,
    loopP99Ms: number,
    kind: StallKind,
    cpuMs: number,
    suspect: Suspect,
    sinceStartMs: number
  ) => {
    const label = suspectLabel(suspect);
    void appendPerf('stalls.jsonl', {
      at: new Date().toISOString(),
      ms: Math.round(stallMs),
      kind,
      cpuMs: Math.round(cpuMs),
      label,
      route:
        suspect.kind === 'run' && HTTP_LABEL.test(suspect.run.label) ? suspect.run.label : null,
      sinceActivityMs: Math.round(sinceStartMs),
      loopP99Ms: Math.round(loopP99Ms),
    });
  };

  const report = (stallMs: number, detectedAt: number, label: string, sinceStartMs: number) => {
    const previous = reported.get(label);
    if (previous && detectedAt - previous.lastReportedAt < REPORT_WINDOW_MS) {
      previous.suppressed += 1;
      previous.suppressedMaxMs = Math.max(previous.suppressedMaxMs, stallMs);
      return;
    }
    const repeats = previous?.suppressed
      ? `; ${previous.suppressed} more stall(s) up to ${Math.round(previous.suppressedMaxMs)}ms since the last report`
      : '';
    reported.set(label, { lastReportedAt: detectedAt, suppressed: 0, suppressedMaxMs: 0 });
    const message =
      `[event-loop] Event loop stalled ${Math.round(stallMs)}ms; last activity: ${label} ` +
      `(started ${Math.round(sinceStartMs)}ms before detection)${repeats}`;
    // console.log, not warn: console.warn is itself journaled and would double-count.
    console.log(message);
    void journal
      .capture({ severity: 'warn', component: 'event-loop', message, context: { route: label } })
      .catch((error) => {
        console.error('[event-loop] Failed to journal a stall:', error);
      });
  };

  // CPU snapshots of recent checks. The histogram's native timer can record a stall after this
  // check ran in the same loop turn, so a stall is often seen one check late; the CPU window must
  // start at the newest snapshot from before the stall began, not at the previous check. The same
  // lag decides which long runs are still candidates: those that ended after the check before last.
  const snapshots: { at: number; cpu: NodeJS.CpuUsage }[] = [];
  // Labelled so a slow profiler rotation (the check runs it) names itself, not some other work.
  const check = () => {
    const now = performance.now();
    const cpu = process.cpuUsage();
    snapshots.push({ at: now, cpu });
    if (snapshots.length > CPU_SNAPSHOTS) snapshots.shift();
    const stallMs = delay.max / 1e6;
    if (stallMs < STALL_THRESHOLD_MS) {
      const checkBeforeLast = snapshots[snapshots.length - 3]?.at ?? 0;
      longRuns = longRuns.filter((run) => run.endedAt >= checkBeforeLast);
      profiler.tick(now);
      return;
    }
    const loopP99Ms = delay.percentile(99) / 1e6;
    delay.reset();
    let start = snapshots[0];
    for (const snapshot of snapshots) if (snapshot.at <= now - stallMs) start = snapshot;
    const cpuMs = (cpu.user - start.cpu.user + cpu.system - start.cpu.system) / 1000;
    const kind = stallKind(stallMs, cpuMs);
    const suspect = takeSuspect();
    const sinceStartMs = suspect.kind === 'run' ? now - suspect.run.startedAt : stallMs;
    recordStall(stallMs, loopP99Ms, kind, cpuMs, suspect, sinceStartMs);
    switch (kind) {
      case 'busy': {
        const label = suspectLabel(suspect);
        profiler.noteStall({
          at: new Date().toISOString(),
          ms: Math.round(stallMs),
          label,
          detectedAt: now,
        });
        report(stallMs, now, label, sinceStartMs);
        break;
      }
      // The machine's, not this code's: kept in stalls.jsonl, never profiled or journaled.
      case 'descheduled':
        break;
    }
    profiler.tick(now);
  };
  const timer = setInterval(labelled('timer stall-monitor', check), CHECK_INTERVAL_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    delay.disable();
    stopBefore();
    stopAfter();
    return profiler.stop();
  };
}
