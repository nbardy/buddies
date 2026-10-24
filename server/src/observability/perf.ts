import fs from 'node:fs';
import inspector from 'node:inspector';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { NextFunction, Request, Response } from 'express';
import { appendPerf, flushPerf, perfBootId, profilesDirectory } from './perf-log';

/**
 * Performance telemetry API (boot phases, route latency, CPU profiles).
 * Pattern: fix-guards (docs/patterns.md#fix-guards) -- slowdowns must leave measurements.
 * Storage and rotation: perf-log.ts. Reader: tools/perf-audit.ts (`pnpm perf:audit`).
 *
 * Wiring (done by the boot code, not here):
 *   - server.ts: `app.use(routeLatencyMiddleware())` right after the auth gate;
 *     `await timeBootPhase('<phase>', fn)` / `bootPhase('listening', ms)` around startup steps.
 *   - shutdown: `await flushRouteLatency()`.
 *   - `registerDebugProfileRoutes(app)` (http/debug-profile-routes.ts) after the auth gate.
 */

// ---------- boot phases ----------

/** One line in boot.jsonl; the supervisor writes the same shape with source 'supervisor'. */
export function bootPhase(phase: string, ms: number): void {
  void appendPerf('boot.jsonl', {
    bootId: perfBootId(),
    source: 'backend',
    phase,
    ms: Math.round(ms * 10) / 10,
    at: new Date().toISOString(),
  });
}

export function timeBootPhase<T>(phase: string, fn: () => T): T {
  const started = performance.now();
  try {
    return fn();
  } finally {
    bootPhase(phase, performance.now() - started);
  }
}

export async function timeBootPhaseAsync<T>(phase: string, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await fn();
  } finally {
    bootPhase(phase, performance.now() - started);
  }
}

// ---------- route latency ----------

const SAMPLE_CAP_PER_BUCKET = 2_000;
const MINUTE_MS = 60_000;

/** Nearest-rank percentile of an ascending-sorted array. */
export function percentile(sortedAscending: readonly number[], fraction: number): number {
  return sortedAscending[Math.max(0, Math.ceil(fraction * sortedAscending.length) - 1)];
}

/** Replace volatile ids with `:id` so one route is one key. */
export function normalizeRoute(pathname: string): string {
  return pathname
    .split('?')[0]
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\b[a-z]+_[0-9a-f-]{10,}\b/gi, ':id')
    .replace(/\/[0-9a-f]{16,}(?=\/|$)/gi, '/:id')
    .replace(/\/\d+(?=\/|$)/g, '/:id');
}

interface RouteBucket {
  minute: number;
  method: string;
  route: string;
  samples: number[];
  count: number;
  max: number;
}

export class RouteLatencyRecorder {
  private readonly buckets = new Map<string, RouteBucket>();

  constructor(
    private readonly write: (record: Record<string, unknown>) => void = (record) =>
      void appendPerf('routes.jsonl', record)
  ) {}

  /** Records one request; buckets from earlier minutes are written out first. */
  record(method: string, route: string, ms: number, nowMs: number = Date.now()): void {
    const minute = Math.floor(nowMs / MINUTE_MS);
    this.flushBefore(minute);
    const key = `${minute} ${method} ${route}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { minute, method, route, samples: [], count: 0, max: 0 };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    bucket.max = Math.max(bucket.max, ms);
    if (bucket.samples.length < SAMPLE_CAP_PER_BUCKET) bucket.samples.push(ms);
  }

  /** Writes every open bucket (shutdown, tests). */
  flush(): void {
    this.flushBefore(Number.POSITIVE_INFINITY);
  }

  private flushBefore(minute: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.minute >= minute) continue;
      this.buckets.delete(key);
      const sorted = bucket.samples.sort((a, b) => a - b);
      this.write({
        at: new Date((bucket.minute + 1) * MINUTE_MS).toISOString(),
        method: bucket.method,
        route: bucket.route,
        count: bucket.count,
        p50: round1(percentile(sorted, 0.5)),
        p90: round1(percentile(sorted, 0.9)),
        max: round1(bucket.max),
      });
    }
  }
}

const round1 = (value: number) => Math.round(value * 10) / 10;

const recorder = new RouteLatencyRecorder();

export function recordRoute(method: string, normalizedRoute: string, ms: number): void {
  recorder.record(method, normalizedRoute, ms);
}

export function flushRouteLatency(): Promise<void> {
  recorder.flush();
  return flushPerf();
}

/** Express middleware: times every response; keys by the matched route pattern when express knows it. */
export function routeLatencyMiddleware() {
  return (request: Request, response: Response, next: NextFunction): void => {
    const started = performance.now();
    response.once('finish', () => {
      const pattern = request.route?.path;
      const route =
        typeof pattern === 'string'
          ? normalizeRoute(`${request.baseUrl}${pattern}`)
          : normalizeRoute(`${request.baseUrl}${request.path}`);
      recordRoute(request.method, route, performance.now() - started);
    });
    next();
  };
}

// ---------- CPU profiles ----------

export class ProfilerBusyError extends Error {
  constructor() {
    super('A CPU profile is already being captured');
  }
}

let profiling = false;

export function profilerBusy(): boolean {
  return profiling;
}

/**
 * Samples the main thread for `durationMs` and writes `<profiles>/<label>-<ts>.cpuprofile`.
 * The inspector profiler only sees what runs AFTER it starts, so for a stall it captures
 * the aftermath, not the stall itself; use it to find recurring hot code.
 */
export async function captureCpuProfile(
  durationMs: number,
  label: string,
  directory: string = profilesDirectory()
): Promise<string> {
  if (profiling) throw new ProfilerBusyError();
  profiling = true;
  const session = new inspector.Session();
  try {
    session.connect();
    const post = <T>(method: string, params?: object) =>
      new Promise<T>((resolve, reject) =>
        session.post(method, params, (error, result) =>
          error ? reject(error) : resolve(result as T)
        )
      );
    await post('Profiler.enable');
    await post('Profiler.start');
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    const { profile } = await post<{ profile: unknown }>('Profiler.stop');
    await post('Profiler.disable');
    await fs.promises.mkdir(directory, { recursive: true });
    const safeLabel = label.replace(/[^a-z0-9]+/gi, '-').slice(0, 40) || 'profile';
    const file = path.join(
      directory,
      `${safeLabel}-${new Date().toISOString().replace(/[:.]/g, '-')}.cpuprofile`
    );
    await fs.promises.writeFile(file, JSON.stringify(profile), { mode: 0o600 });
    return file;
  } finally {
    session.disconnect();
    profiling = false;
  }
}
