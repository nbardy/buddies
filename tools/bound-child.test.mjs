import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function until(read, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** PIDs of processes whose command line names `needle` (the fixture's unique temp path). */
function processesNaming(needle) {
  const listed = spawnSync('pgrep', ['-f', needle], { encoding: 'utf8' });
  return listed.stdout.split('\n').filter(Boolean).map(Number);
}

// 2026-11-11: the dev supervisor's TypeScript 7 watch compilers are native `tsc --watch` children.
// A SIGKILLed supervisor left all three running under launchd (TS 5's in-process watch API had
// died with it). The real startCompiler is hosted by a stand-in supervisor that is then
// SIGKILLed; no compiler may survive it.
test('a SIGKILLed host leaves no tsc --watch behind', async (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bound-child-')));
  t.after(() => {
    for (const pid of processesNaming(root)) process.kill(pid, 'SIGKILL');
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(path.join(root, 'src'));
  mkdirSync(path.join(root, 'node_modules'));
  symlinkSync(
    realpathSync(path.join(repositoryRoot, 'shared', 'node_modules', 'typescript')),
    path.join(root, 'node_modules', 'typescript'),
    'dir'
  );
  writeFileSync(
    path.join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { rootDir: './src', outDir: './dist', types: [] },
      include: ['src'],
    })
  );
  writeFileSync(path.join(root, 'src', 'index.ts'), 'export const value = 1;\n');
  const runtime = pathToFileURL(path.join(repositoryRoot, 'tools', 'dev-runtime.mjs')).href;
  const host = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `const { startCompiler } = await import(${JSON.stringify(runtime)});
       const compiler = startCompiler({
         name: 'fixture',
         configPath: ${JSON.stringify(path.join(root, 'tsconfig.json'))},
         outDir: ${JSON.stringify(path.join(root, 'dist'))},
         stateDirectory: ${JSON.stringify(path.join(root, 'state'))},
         log: () => {},
       });
       await compiler.ready;
       process.stdout.write('ready\\n');
       setInterval(() => {}, 1000);`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  );
  t.after(() => host.kill('SIGKILL'));
  await new Promise((resolve, reject) => {
    host.stdout.on('data', (chunk) => String(chunk).includes('ready') && resolve());
    host.once('exit', (code) => reject(new Error(`host exited early (${code})`)));
  });
  const compilers = processesNaming(path.join(root, 'tsconfig.json'));
  assert.ok(compilers.length > 0, 'the compiler is running before the host dies');

  host.kill('SIGKILL');
  await until(() => processesNaming(path.join(root, 'tsconfig.json')).length === 0);
});
