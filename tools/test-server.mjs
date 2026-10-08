// Pattern: fix-guards (docs/patterns.md#fix-guards)
// Unbounded file fan-out made full feedback take 401 s on d094cf3. Start the real-process
// critical path first, with a bounded pool; --fast is an explicitly smaller development gate.
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const critical = ['ctrl-c-adoption', 'execution-adoption', 'run-lease', 'buddies-v2'];
const fast = [
  'wire-v3',
  'execution-crash-checker',
  'turn-machine',
  'turn-queue',
  'config-service',
  'tool-contract',
  'buddy-conversation-contract',
  'buddy-creation-service',
  'startup',
];
const mode = process.argv.includes('--fast') ? 'fast' : 'full';
const concurrency = Number(process.env.UNLEASHD_TEST_CONCURRENCY ?? 4);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
  throw new Error('UNLEASHD_TEST_CONCURRENCY must be an integer from 1 to 32');
}
const files = readdirSync(new URL('../server/test/', import.meta.url))
  .filter((name) => name.endsWith('.test.ts'))
  .filter((name) => mode === 'full' || fast.includes(name.replace('.test.ts', '')))
  .sort((a, b) => {
    const rank = (name) => {
      const n = critical.indexOf(name.replace('.test.ts', ''));
      return n < 0 ? 4 : n;
    };
    return rank(a) - rank(b) || a.localeCompare(b);
  })
  .map((name) => `server/test/${name}`);
console.log(`[server tests] ${mode}: ${files.length} files, concurrency ${concurrency}`);
const started = performance.now();
const child = spawn(
  process.execPath,
  [
    require.resolve('tsx/cli'),
    '--test',
    `--test-concurrency=${concurrency}`,
    ...process.argv.slice(2).filter((arg) => arg !== '--fast'),
    ...files,
  ],
  { stdio: 'inherit' }
);
child.on('error', (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  console.log(`[server tests] ${mode} wall ${(performance.now() - started).toFixed(0)} ms`);
  process.exitCode = code ?? (signal ? 1 : 0);
});
