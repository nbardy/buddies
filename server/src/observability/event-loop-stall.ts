import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type { ErrorJournal } from './error-journal';
import { captureCpuProfile, profilerBusy } from './perf';
import { appendPerf } from './perf-log';

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
 * or over the threshold makes the check due before the loop resumes; it then
 * runs in the timers phase, before that iteration's I/O callbacks can note a
 * newer activity.
 *
 * Attribution: HTTP requests, WS commands and the known timers call
 * `noteActivity(label)`, which is two variable writes, so the hot path pays for
 * a timestamp and nothing else. When a stall is detected the most recently
 * noted activity is reported with how long before detection it started. It is
 * the prime suspect, not proof: a stall inside an async continuation of an
 * older activity is attributed to whatever was noted last.
 */

export const STALL_THRESHOLD_MS = 100;
const CHECK_INTERVAL_MS = STALL_THRESHOLD_MS;
const HISTOGRAM_RESOLUTION_MS = 10;
/** One journal write per activity label per window; repeats are summarized in the next write. */
const REPORT_WINDOW_MS = 60_000;

const PROFILE_WINDOW_MS = 2_000;
const PROFILE_MIN_GAP_MS = 10 * 60_000;

function profileThresholdMs(): number {
  const configured = Number(process.env.UNLEASHD_STALL_PROFILE_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 500;
}

let activityLabel = 'startup';
let activityAt = performance.now();

/** Record what the event loop is about to do. Call at the top of a request, command or timer. */
export function noteActivity(label: string): void {
  activityLabel = label;
  activityAt = performance.now();
}

/**
 * Wraps a timer/event callback so it notes `label` before running. Use for every
 * recurring timer: `setInterval(labelled('timer foo', tick), ms)`.
 */
export function labelled<Args extends unknown[], R>(
  label: string,
  fn: (...args: Args) => R
): (...args: Args) => R {
  return (...args) => {
    noteActivity(label);
    return fn(...args);
  };
}

/** The `route` of a stall record: the label when it is an HTTP request ("GET /api/x"), else absent. */
const HTTP_LABEL = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \//;

interface ReportedLabel {
  lastReportedAt: number;
  /** Stalls under this label since `lastReportedAt` that were not written. */
  suppressed: number;
  suppressedMaxMs: number;
}

/** Starts the monitor; returns the function that stops it. */
export function startEventLoopStallMonitor(journal: Pick<ErrorJournal, 'capture'>): () => void {
  const reported = new Map<string, ReportedLabel>();
  const delay = monitorEventLoopDelay({ resolution: HISTOGRAM_RESOLUTION_MS });
  delay.enable();

  let lastProfileAt = Number.NEGATIVE_INFINITY;

  const recordStall = (stallMs: number, detectedAt: number, loopP99Ms: number) => {
    const label = activityLabel;
    void appendPerf('stalls.jsonl', {
      at: new Date().toISOString(),
      ms: Math.round(stallMs),
      label,
      route: HTTP_LABEL.test(label) ? label : null,
      sinceActivityMs: Math.round(detectedAt - activityAt),
      loopP99Ms: Math.round(loopP99Ms),
    });
    if (
      stallMs >= profileThresholdMs() &&
      detectedAt - lastProfileAt >= PROFILE_MIN_GAP_MS &&
      !profilerBusy()
    ) {
      lastProfileAt = detectedAt;
      captureCpuProfile(PROFILE_WINDOW_MS, `stall-${Math.round(stallMs)}ms-${label}`).catch(
        (error) => {
          console.log('[event-loop] CPU profile failed:', error);
        }
      );
    }
  };

  const report = (stallMs: number, detectedAt: number) => {
    const label = activityLabel;
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
      `(started ${Math.round(detectedAt - activityAt)}ms before detection)${repeats}`;
    // console.log, not warn: console.warn is itself journaled and would double-count.
    console.log(message);
    void journal
      .capture({ severity: 'warn', component: 'event-loop', message, context: { route: label } })
      .catch((error) => {
        console.error('[event-loop] Failed to journal a stall:', error);
      });
  };

  const timer = setInterval(() => {
    const stallMs = delay.max / 1e6;
    if (stallMs < STALL_THRESHOLD_MS) return;
    const loopP99Ms = delay.percentile(99) / 1e6;
    delay.reset();
    const detectedAt = performance.now();
    recordStall(stallMs, detectedAt, loopP99Ms);
    report(stallMs, detectedAt);
  }, CHECK_INTERVAL_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    delay.disable();
  };
}
