// Pattern: fix-guards (docs/patterns.md#fix-guards)
// The full suite took 401 s on d094cf3 with unbounded file fan-out. Use a bounded pool;
// --fast is an explicitly smaller development gate, never the complete release proof.
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
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
const mode = process.argv.includes('--fast') ? 'fast' : 'full';
const concurrency = Number(process.env.UNLEASHD_TEST_CONCURRENCY ?? 4);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
  throw new Error('UNLEASHD_TEST_CONCURRENCY must be an integer from 1 to 32');
}
const files = readdirSync(new URL('../server/test/', import.meta.url))
  .filter((name) => name.endsWith('.test.ts'))
  .filter((name) => mode === 'full' || fast.includes(name.replace('.test.ts', '')))
  .sort()
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
