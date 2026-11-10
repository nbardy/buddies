import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startCompiler, tscLauncher } from './dev-runtime.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function until(read, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function filesUnder(directory) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)))
    .sort();
}

// The dev compilers moved from the in-process TS 5 watch API to native `tsc --watch` children
// (TypeScript 7, 2026-11-10). They emit into a stage and publish by rename, which is what keeps
// a backend loading dist/ from reading a truncated module (2026-09-25), and the stage must not
// change a byte of what lands in dist/: maps included, whose `sources` are relative paths.
test('the dev compiler publishes exactly what tsc emits, and replaces files by rename', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dev-compiler-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'src', 'nested'), { recursive: true });
  mkdirSync(path.join(root, 'node_modules'));
  symlinkSync(
    realpathSync(path.join(repositoryRoot, 'shared', 'node_modules', 'typescript')),
    path.join(root, 'node_modules', 'typescript'),
    'dir'
  );
  const configPath = path.join(root, 'tsconfig.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'commonjs',
        moduleResolution: 'bundler',
        rootDir: './src',
        outDir: './dist',
        strict: true,
        declaration: true,
        declarationMap: true,
        sourceMap: true,
      },
      include: ['src'],
    })
  );
  writeFileSync(path.join(root, 'src', 'index.ts'), "export * from './nested/value';\n");
  writeFileSync(path.join(root, 'src', 'nested', 'value.ts'), 'export const value = 1;\n');
  const outDir = path.join(root, 'dist');
  const lines = [];
  const compiler = startCompiler({
    name: 'fixture',
    configPath,
    outDir,
    stateDirectory: path.join(root, 'state'),
    log: (line) => lines.push(line),
  });
  t.after(() => compiler.close());
  await compiler.ready;

  // A one-shot compile of the same sources into a sibling directory at the same depth.
  const direct = spawnSync(
    process.execPath,
    [tscLauncher(configPath), '-p', configPath, '--outDir', path.join(root, 'direct')],
    { encoding: 'utf8' }
  );
  assert.equal(direct.status, 0, direct.stdout);
  const published = filesUnder(outDir);
  assert.deepEqual(published, filesUnder(path.join(root, 'direct')), lines.join('\n'));
  assert.ok(published.includes(path.join('nested', 'value.js.map')));
  for (const file of published) {
    assert.equal(
      readFileSync(path.join(outDir, file), 'utf8'),
      readFileSync(path.join(root, 'direct', file), 'utf8'),
      file
    );
  }

  const output = path.join(outDir, 'nested', 'value.js');
  const before = statSync(output).ino;
  writeFileSync(path.join(root, 'src', 'nested', 'value.ts'), 'export const value = 2;\n');
  await until(() => readFileSync(output, 'utf8').includes('value = 2'));
  // A rename gives the path a new inode; an in-place write (truncate, then fill) keeps it.
  assert.notEqual(statSync(output).ino, before);
  assert.deepEqual(
    readdirSync(path.dirname(output)).filter((name) => name.endsWith('.tmp')),
    []
  );
});
