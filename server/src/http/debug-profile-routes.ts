import type { Application } from 'express';
import { ProfilerBusyError, captureCpuProfile } from '../observability/perf';

const DEFAULT_MS = 10_000;
const MIN_MS = 500;
const MAX_MS = 60_000;

/**
 * POST /api/debug/profile?ms=10000: samples the main thread for `ms` and writes
 * `<data-dir>/observability/perf/profiles/*.cpuprofile`, returning `{path, ms}`.
 * Register AFTER the auth gate (a profile names file paths and costs CPU); the
 * gate is what protects it. One capture at a time (409 otherwise). `pnpm perf:profile`
 * calls it. Open the file in Chrome DevTools > Performance, or speedscope.
 */
export function registerDebugProfileRoutes(app: Application): void {
  app.post('/api/debug/profile', async (request, response) => {
    const requested = Number(request.query.ms ?? DEFAULT_MS);
    const ms = Number.isFinite(requested)
      ? Math.min(MAX_MS, Math.max(MIN_MS, Math.round(requested)))
      : DEFAULT_MS;
    try {
      const path = await captureCpuProfile(ms, 'manual');
      response.json({ path, ms });
    } catch (error) {
      if (error instanceof ProfilerBusyError) {
        response.status(409).json({ error: error.message });
        return;
      }
      console.error('[perf] CPU profile failed:', error);
      if (!response.headersSent) response.status(500).json({ error: 'CPU profile failed' });
    }
  });
}
