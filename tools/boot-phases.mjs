// Boot-phase timing for the dev runtime: one JSONL line per supervisor phase in
// <data dir>/observability/perf/boot.jsonl, `{bootId, source:'supervisor', phase, ms, at}`.
// The backend gets the same id as UNLEASHD_BOOT_ID, so its own phases join on it.
// (Replaces the stale dev-supervisor.boot.json idea: one file, one schema.)
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function dataDirectory(env = process.env) {
  return path.resolve(env.UNLEASHD_DATA_DIR ?? path.join(os.homedir(), '.agent-viewer'));
}

export function perfDirectory(env = process.env) {
  return path.join(dataDirectory(env), 'observability', 'perf');
}

/**
 * `phase(name, ms, extra)` appends one line. Diagnostics only: a write failure is
 * swallowed, a boot must never fail because its timing file is unwritable.
 */
export function createBootRecorder({
  env = process.env,
  bootId = randomUUID(),
  now = Date.now,
} = {}) {
  const directory = perfDirectory(env);
  const file = path.join(directory, 'boot.jsonl');
  const startedAt = now();
  return {
    bootId,
    file,
    /** Milliseconds since the recorder (the supervisor's boot) started. */
    sinceStart: () => now() - startedAt,
    phase(phase, ms, extra = {}) {
      const line = JSON.stringify({
        bootId,
        source: 'supervisor',
        phase,
        ms: Math.round(ms),
        at: new Date(now()).toISOString(),
        ...extra,
      });
      try {
        mkdirSync(directory, { recursive: true });
        appendFileSync(file, `${line}\n`);
      } catch {}
    },
  };
}
