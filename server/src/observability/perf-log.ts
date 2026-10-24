import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Performance telemetry storage: small append-only JSONL files under
 * `<data-dir>/observability/perf/` (boot.jsonl, routes.jsonl, stalls.jsonl,
 * profiles/). Same data-dir resolution as the error journal
 * (`UNLEASHD_DATA_DIR`, else `~/.agent-viewer`) and the same rotation scheme
 * (5 MiB x 4 rotated files, mode 0600).
 *
 * Why it exists: errors.jsonl only holds one stall record per label per minute and
 * blames "the last noted activity", so boot cost, route latency and CPU hot spots
 * were reconstructed by hand from it (2026-10-22). `pnpm perf:audit` reads these files.
 *
 * Writes are fire-and-forget on one queue: telemetry must never block or fail the
 * thing it measures. A failed write goes to stderr (NOT console.error, which is
 * journaled and would feed back into the journal).
 */

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROTATED_FILES = 4;

export type PerfFile = 'boot.jsonl' | 'routes.jsonl' | 'stalls.jsonl';

export function dataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.UNLEASHD_DATA_DIR?.trim() || path.join(os.homedir(), '.agent-viewer'));
}

export function perfDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(dataDirectory(env), 'observability', 'perf');
}

export function profilesDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(perfDirectory(env), 'profiles');
}

let generatedBootId: string | undefined;
/** The supervisor's UNLEASHD_BOOT_ID, so backend and supervisor phases share one boot; else one per process. */
export function perfBootId(env: NodeJS.ProcessEnv = process.env): string {
  const inherited = env.UNLEASHD_BOOT_ID?.trim();
  if (inherited) return inherited;
  generatedBootId ??= crypto.randomUUID();
  return generatedBootId;
}

let queue: Promise<void> = Promise.resolve();

/** Append one JSON line to a perf file (rotating at 5 MiB). Never throws, never blocks the caller. */
export function appendPerf(
  file: PerfFile,
  record: Record<string, unknown>,
  directory: string = perfDirectory()
): Promise<void> {
  const line = `${JSON.stringify(record)}\n`;
  queue = queue.then(() => writeLine(path.join(directory, file), line)).catch(reportWriteFailure);
  return queue;
}

/** Resolves when every append queued so far has reached disk (tests, shutdown). */
export function flushPerf(): Promise<void> {
  return queue;
}

function reportWriteFailure(error: unknown): void {
  process.stderr.write(`[perf] Failed to write telemetry: ${String(error)}\n`);
}

async function writeLine(filePath: string, line: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await rotateIfNeeded(filePath, Buffer.byteLength(line));
  await fs.promises.appendFile(filePath, line, { encoding: 'utf8', mode: 0o600 });
}

async function rotateIfNeeded(filePath: string, incomingBytes: number): Promise<void> {
  const size = await fs.promises
    .stat(filePath)
    .then((stat) => stat.size)
    .catch(() => 0);
  if (size === 0 || size + incomingBytes <= MAX_BYTES) return;
  await fs.promises.rm(`${filePath}.${MAX_ROTATED_FILES}`, { force: true });
  for (let index = MAX_ROTATED_FILES - 1; index >= 1; index -= 1) {
    await fs.promises
      .rename(`${filePath}.${index}`, `${filePath}.${index + 1}`)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
  }
  await fs.promises.rename(filePath, `${filePath}.1`);
}
