import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sharedRoot = path.join(repositoryRoot, 'shared');

test('shared build keeps the prior dist on compile failure and publishes complete replacements', (t) => {
  const checkoutRoot = mkdtempSync(path.join(os.tmpdir(), 'unleashd-shared-build-'));
  t.after(() => rmSync(checkoutRoot, { recursive: true, force: true }));
  // Shaped like the checkout: the build imports its stamp and compiler lookup from tools/lib.
  const fixture = path.join(checkoutRoot, 'shared');
  mkdirSync(path.join(checkoutRoot, 'tools', 'lib'), { recursive: true });
  for (const file of ['tsc.mjs', 'shared-build-stamp.mjs']) {
    copyFileSync(
      path.join(repositoryRoot, 'tools', 'lib', file),
      path.join(checkoutRoot, 'tools', 'lib', file)
    );
  }
  for (const directory of ['scripts', 'src', 'dist/cjs', 'node_modules']) {
    mkdirSync(path.join(fixture, directory), { recursive: true });
  }
  writeFileSync(path.join(fixture, 'package.json'), '{ "name": "fixture-shared" }\n');
  for (const config of ['tsconfig.json', 'tsconfig.cjs.json']) {
    copyFileSync(path.join(sharedRoot, config), path.join(fixture, config));
  }
  copyFileSync(path.join(sharedRoot, 'scripts/build.mjs'), path.join(fixture, 'scripts/build.mjs'));
  symlinkSync(
    realpathSync(path.join(sharedRoot, 'node_modules/typescript')),
    path.join(fixture, 'node_modules/typescript'),
    'dir'
  );
  const source = path.join(fixture, 'src/index.ts');
  const esm = path.join(fixture, 'dist/index.js');
  const cjs = path.join(fixture, 'dist/cjs/index.js');
  writeFileSync(esm, 'export const value = 0;\n');
  writeFileSync(cjs, 'exports.value = 0;\n');

  const build = () =>
    spawnSync(process.execPath, [path.join(fixture, 'scripts/build.mjs')], {
      cwd: fixture,
      encoding: 'utf8',
      timeout: 30_000,
    });

  writeFileSync(source, 'export const value: string = 1;\n');
  const failed = build();
  assert.notEqual(failed.status, 0, failed.stderr);
  assert.equal(readFileSync(esm, 'utf8'), 'export const value = 0;\n');
  assert.equal(readFileSync(cjs, 'utf8'), 'exports.value = 0;\n');

  writeFileSync(source, 'export const value = 1;\n');
  const succeeded = build();
  assert.equal(succeeded.status, 0, succeeded.stderr);
  assert.match(readFileSync(esm, 'utf8'), /export const value = 1/);
  assert.match(readFileSync(cjs, 'utf8'), /exports\.value = 1/);
  assert.equal(
    readFileSync(path.join(fixture, 'dist/cjs/package.json'), 'utf8'),
    '{\n  "type": "commonjs"\n}\n'
  );
});
