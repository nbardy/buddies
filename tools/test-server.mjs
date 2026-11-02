// Pattern: fix-guards (docs/patterns.md#fix-guards)
// The server suite: every test file (and every shard of a long file) is its own process, run from
// a pool. 2026-11-02: files ran whole, four at a time, so expeditions (418 s) and oompa-mcp (184 s)
// alone set the wall clock. Long files now split into shards (server/test/fixtures/shard.ts) that
// run side by side; each unit gets its own TMPDIR, removed when it exits, so no two units share a
// temp store. --fast is an explicitly smaller development gate, never the complete release proof.
// --slow adds the opt-in end-to-end files (SLOW below); release checks run with it.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);

const fast = [
  'wire-v3',
  'execution-crash-checker',
  'config-service',
  'tool-contract',
  'buddy-conversation-contract',
  'buddy-creation-service',
  'startup',
];
/**
 * Files run as `shards` processes, at most `live` of them at once. Every test in them builds its
 * own fixture (the shard wrapper's contract). `live` is measured, not a guess: nine oompa-mcp
 * shards at once failed nearly every shard on a loaded machine (each test passed alone; three at
 * once passed), and sixteen expeditions shards at once took 4x the CPU-seconds of eight.
 */
const SHARDS = {
  expeditions: { shards: 12, live: 6 },
  'oompa-mcp': { shards: 6, live: 3 },
  'buddies-v2': { shards: 4, live: 4 },
  'execution-adoption': { shards: 6, live: 6 },
  'run-lease': { shards: 4, live: 4 },
  'idle-background-delivery': { shards: 3, live: 3 },
  'ctrl-c-adoption': { shards: 3, live: 3 },
};
/** Opt-in (--slow) files; none today. A file belongs here only when it is slow by nature (a real
 * agent CLI end to end), never because a wait in it could be awaited or injected instead. */
const SLOW = [];

const args = process.argv.slice(2);
const mode = args.includes('--fast') ? 'fast' : args.includes('--slow') ? 'slow' : 'full';
// Bare words pick files by name (`node tools/test-server.mjs expeditions run-lease`); other
// flags go to every `node --test` (e.g. --test-name-pattern).
const picked = args.filter((arg) => !arg.startsWith('-'));
const forwarded = args.filter((arg) => arg.startsWith('-') && arg !== '--fast' && arg !== '--slow');
const concurrency = Number(process.env.UNLEASHD_TEST_CONCURRENCY ?? os.availableParallelism());
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) {
  throw new Error('UNLEASHD_TEST_CONCURRENCY must be an integer from 1 to 64');
}

const included = {
  fast: (name) => fast.includes(name),
  full: (name) => !SLOW.includes(name),
  slow: () => true,
}[mode];
const names = readdirSync(new URL('../server/test/', import.meta.url))
  .filter((file) => file.endsWith('.test.ts'))
  .map((file) => file.replace('.test.ts', ''))
  .filter(included)
  .filter((name) => picked.length === 0 || picked.includes(name))
  .sort();
// Longest first: the sharded files, then the rest; a long unit started last would set the wall.
const units = [
  ...names
    .filter((name) => name in SHARDS)
    .flatMap((name) =>
      Array.from({ length: SHARDS[name].shards }, (_, i) => ({
        name,
        shard: `${i + 1}/${SHARDS[name].shards}`,
      }))
    ),
  ...names.filter((name) => !(name in SHARDS)).map((name) => ({ name, shard: '' })),
];
console.log(
  `[server tests] ${mode}: ${names.length} files as ${units.length} processes, concurrency ${concurrency}`
);

const tsx = require.resolve('tsx/cli');
const UNIT_TIMEOUT_MS = Number(process.env.UNLEASHD_TEST_UNIT_TIMEOUT_MS ?? 600_000);
const TSX_CACHE = path.join(os.tmpdir(), `tsx-${os.userInfo().uid}`);
mkdirSync(TSX_CACHE, { recursive: true, mode: 0o700 });
const started = performance.now();
// Units lead their own process groups (so a hung one can be killed whole); a Ctrl+C of the run
// must still end them.
const live = new Set();
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    for (const child of live)
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    process.exit(130);
  });
const results = [];

function run(unit) {
  const label = unit.shard ? `${unit.name} [${unit.shard}]` : unit.name;
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'ut-'));
  // tsx keeps its transform cache at $TMPDIR/tsx-<uid>. A private TMPDIR without this link made
  // every unit, and every backend a unit boots, compile the whole server cold (a full run spent
  // most of its CPU in esbuild). The cache is content-keyed and shared safely across processes.
  symlinkSync(TSX_CACHE, path.join(tmp, path.basename(TSX_CACHE)));
  const begun = performance.now();
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [tsx, '--test', ...forwarded, `server/test/${unit.name}.test.ts`],
      {
        env: { ...process.env, UNLEASHD_TEST_SHARD: unit.shard, TMPDIR: tmp },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      }
    );
    live.add(child);
    // A unit whose test left a handle open (a fixture that threw before returning its close)
    // never exits, and one hung unit held a whole run (2026-11-03). Kill its group, report it.
    const hung = setTimeout(() => {
      output.push(Buffer.from(`\n[server tests] ${label}: killed after ${UNIT_TIMEOUT_MS} ms\n`));
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }, UNIT_TIMEOUT_MS);
    const output = [];
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => output.push(chunk));
    child.on('error', (error) => output.push(Buffer.from(String(error.stack))));
    child.on('close', (code, signal) => {
      clearTimeout(hung);
      live.delete(child);
      rmSync(tmp, { recursive: true, force: true });
      const seconds = (performance.now() - begun) / 1000;
      const ok = code === 0;
      results.push({ label, seconds, ok });
      if (!ok) {
        process.stdout.write(`\n----- ${label} (exit ${code ?? signal}) -----\n`);
        process.stdout.write(Buffer.concat(output));
      }
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${seconds.toFixed(1).padStart(6)} s  ${label}`);
      resolve();
    });
  });
}

// Start the first queued unit whose file is under its `live` cap whenever a slot frees.
const queue = [...units];
const running = new Map();
const cap = (name) => (name in SHARDS ? SHARDS[name].live : 1);
await new Promise((done) => {
  const fill = () => {
    for (
      let i = 0;
      i < queue.length && [...running.values()].reduce((a, b) => a + b, 0) < concurrency;
    ) {
      const unit = queue[i];
      if ((running.get(unit.name) ?? 0) >= cap(unit.name)) {
        i++;
        continue;
      }
      queue.splice(i, 1);
      running.set(unit.name, (running.get(unit.name) ?? 0) + 1);
      run(unit).then(() => {
        running.set(unit.name, running.get(unit.name) - 1);
        fill();
      });
    }
    if (queue.length === 0 && [...running.values()].every((n) => n === 0)) done();
  };
  fill();
});

const failed = results.filter((r) => !r.ok);
const slowest = [...results].sort((a, b) => b.seconds - a.seconds).slice(0, 8);
console.log(
  `[server tests] slowest: ${slowest.map((r) => `${r.label} ${r.seconds.toFixed(1)}s`).join(', ')}`
);
console.log(
  `[server tests] ${mode} wall ${((performance.now() - started) / 1000).toFixed(1)} s, ` +
    `${results.length - failed.length}/${results.length} processes passed`
);
if (failed.length) console.log(`[server tests] FAILED: ${failed.map((r) => r.label).join(', ')}`);
process.exitCode = failed.length ? 1 : 0;
