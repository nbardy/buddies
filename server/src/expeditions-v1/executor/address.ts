import path from 'node:path';
import { keyed } from '@unleashd/shared';
import { fileNameOf } from './durable';

// Where a run's files live. A run id is derived by the kernel (core/tables.ts `runIdOf`):
// `<expedition>/<key>@<hash>#<attempt>:<role>`. `RunSpec` carries no repo or base, so the
// executor recovers the expedition from the id, and the output's ref (`<key>@<hash>`) with it.

export type RunAddress = {
  readonly runId: string;
  readonly expedition: string;
  readonly ref: keyed.RefId;
  readonly attempt: number;
  readonly role: 'producer' | 'judge';
};

/** The id is the kernel's, so one that does not parse is a bug upstream: thrown, not guessed. */
export class BadRunId extends Error {
  constructor(runId: string) {
    super(`not a run id: ${JSON.stringify(runId)} (expected <expedition>/<key>@<hash>#<n>:<role>)`);
    this.name = 'BadRunId';
  }
}

// The key may hold '@' or '/', so the hash is found from the right: 64 hex digits, then `#`.
const RUN_ID = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/(.+)@([0-9a-f]{64})#([1-9]\d*):(producer|judge)$/;

export function parseRunId(runId: string): RunAddress {
  const m = RUN_ID.exec(runId);
  if (!m) throw new BadRunId(runId);
  const [, expedition, key, hash, attempt, role] = m as unknown as [
    string,
    string,
    string,
    string,
    string,
    'producer' | 'judge',
  ];
  return { runId, expedition, ref: keyed.refOf(key, hash), attempt: Number(attempt), role };
}

/** One expedition's executor files, under the kernel's own directory for it. */
export type RunPaths = {
  /** The run's durable record. */
  readonly record: string;
  /** Its detached checkout, while it runs. */
  readonly tree: string;
  /** HOME and TMPDIR of the process. */
  readonly scratch: string;
  /** A `tree: 'none'` call's working directory (kept after it ends). */
  readonly work: string;
  /** An agent turn's exact request body, kept beside its record (prompts.ts). */
  readonly prompt: string;
};
export function runPaths(expDir: string, runId: string): RunPaths {
  const name = fileNameOf(runId);
  const dir = path.join(expDir, 'runs', name);
  return {
    record: path.join(expDir, 'runs', `${name}.json`),
    prompt: path.join(expDir, 'runs', `${name}.prompt.md`),
    tree: path.join(dir, 'tree'),
    scratch: path.join(dir, 'scratch'),
    work: path.join(dir, 'work'),
  };
}
