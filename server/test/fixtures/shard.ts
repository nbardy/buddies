import nodeTest from 'node:test';

/**
 * `test` from node:test, restricted to one shard of this file's top-level tests.
 *
 * Why: the long integration files (expeditions, oompa-mcp, buddies-v2, the real-backend files)
 * ran their tests one after another in one process, so a single file set the suite's wall clock
 * (expeditions alone took 418 s). `tools/test-server.mjs` runs such a file as N processes, each
 * with `UNLEASHD_TEST_SHARD=i/N` (1-based), and this wrapper registers only every N-th test,
 * starting at the i-th. Each shard is its own process with its own module state, temp dirs and
 * ports, exactly as when the whole file ran alone, so a test must never depend on an earlier
 * top-level test of the same file (each one already builds its own fixture).
 *
 * Unset (a plain `tsx --test file`), every test registers: the file still runs whole.
 */
export type Shard = { t: 'whole' } | { t: 'part'; index: number; count: number };

/** κ: the environment's shard, or a typed error. Never a silent "run everything" on garbage. */
export function parseShard(raw: string | undefined): Shard {
  if (raw === undefined || raw === '') return { t: 'whole' };
  const match = /^(\d+)\/(\d+)$/.exec(raw);
  const index = match ? Number(match[1]) : Number.NaN;
  const count = match ? Number(match[2]) : Number.NaN;
  if (!(Number.isInteger(index) && Number.isInteger(count) && index >= 1 && index <= count))
    throw new Error(`UNLEASHD_TEST_SHARD must be i/N with 1 <= i <= N, got ${JSON.stringify(raw)}`);
  return { t: 'part', index, count };
}

/** Whether the next top-level registration belongs to this process: one predicate per shard kind. */
function membership(shard: Shard): () => boolean {
  if (shard.t === 'whole') return () => true;
  let position = 0;
  return () => position++ % shard.count === shard.index - 1;
}

const mine = membership(parseShard(process.env.UNLEASHD_TEST_SHARD));

/** Same call shapes as node:test's `test`; a test outside this shard is never registered. */
export const test = ((...args: Parameters<typeof nodeTest>) =>
  mine() ? nodeTest(...args) : undefined) as unknown as typeof nodeTest;

export default test;
