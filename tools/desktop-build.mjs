#!/usr/bin/env node
/**
 * `pnpm desktop:build` — the Buddies desktop app: an Electrobun shell with bundled CEF
 * (Chromium) around the UNMODIFIED server. Mac (host arch) only for now.
 *
 *   1. pnpm build                       (skip with --skip-build)
 *   2. stage desktop/stage/payload/     the server's runtime tree, mirroring the repo layout
 *   3. smoke the payload                bundled node, PATH=/usr/bin:/bin, temp state, spare port
 *   4. electrobun build --env=stable    → desktop/build/…/Buddies.app, desktop/artifacts/*.dmg
 *
 * Payload layout (paths the server resolves relative to its own __dirname):
 *   server/dist + server/node_modules   `pnpm deploy --prod`, hoisted (no symlinks in the .app)
 *   client/dist                         server.ts serves `../../client/dist`
 *   crates/unleashd-ingest/             config-records.ts requires `../../../crates/unleashd-ingest`
 *                                       BY PATH; node_modules/@unleashd/ingest re-exports that
 *                                       copy so the addon loads once (two copies of one napi
 *                                       addon in a process is two stores over one SQLite file)
 *   node/bin/node                       official node tarball, sha256-checked against SHASUMS256
 *
 * Electrobun only builds for its host OS, so Windows needs a Windows runner (see --win).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { smokeRuntime, stageRuntime } from './desktop-runtime.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DESKTOP = path.join(ROOT, 'desktop');
const STAGE = path.join(DESKTOP, 'stage', 'payload');
const CACHE = path.join(DESKTOP, 'cache');
const NODE_VERSION = 'v22.23.3';
const ELECTROBUN = 'electrobun@2.0.2';

const args = new Set(process.argv.slice(2));

function fail(message) {
  console.error(`desktop-build: ${message}`);
  process.exit(1);
}

if (args.has('--win')) {
  // TODO(desktop): Windows. Electrobun cross-builds nothing: run this script on a
  // Windows runner/VM with node-${NODE_VERSION}-win-x64.zip, `win.bundleCEF`, the
  // addons built for x86_64-pc-windows-msvc, and node.exe in place of node/bin/node.
  fail('--win is not implemented: Electrobun builds only on its host OS (needs a Windows runner)');
}
if (process.platform !== 'darwin') fail(`mac only for now (host is ${process.platform})`);

const run = (command, argv, options = {}) =>
  execFileSync(command, argv, { stdio: 'inherit', cwd: ROOT, ...options });

function step(label) {
  console.log(`\n== ${label}`);
}

async function nodeBinary() {
  const arch = os.arch() === 'arm64' ? 'arm64' : 'x64';
  const name = `node-${NODE_VERSION}-darwin-${arch}`;
  const binary = path.join(CACHE, name, 'bin', 'node');
  if (
    fs.existsSync(binary) &&
    fs.existsSync(path.join(CACHE, name, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'))
  )
    return binary;
  fs.mkdirSync(CACHE, { recursive: true });
  const base = `https://nodejs.org/dist/${NODE_VERSION}`;
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const expected = sums
    .split('\n')
    .find((line) => line.endsWith(`  ${name}.tar.gz`))
    ?.split(' ')[0];
  if (!expected) fail(`${name}.tar.gz is not in ${base}/SHASUMS256.txt`);
  const response = await fetch(`${base}/${name}.tar.gz`);
  if (!response.ok) fail(`download ${name}: HTTP ${response.status}`);
  const tarball = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(tarball).digest('hex');
  if (actual !== expected) fail(`${name}.tar.gz sha256 ${actual} != ${expected}`);
  const archive = path.join(CACHE, `${name}.tar.gz`);
  fs.writeFileSync(archive, tarball);
  run('tar', ['-xzf', archive, '-C', CACHE]);
  fs.rmSync(archive);
  return binary;
}

function sizeOf(target) {
  return execFileSync('du', ['-sh', target], { encoding: 'utf8' }).split('\t')[0];
}

async function main() {
  if (!args.has('--skip-build')) {
    step('pnpm build');
    run('pnpm', ['build']);
  }
  const node = await nodeBinary();
  await stageRuntime(ROOT, STAGE, node, run);
  // Ship npm alongside Node so clean Macs can install the pinned pnpm without system Node.
  fs.cpSync(path.join(path.dirname(node), '..', 'lib'), path.join(STAGE, 'node', 'lib'), {
    recursive: true,
  });
  for (const file of [
    'desktop-source.mjs',
    'desktop-source-git.mjs',
    'desktop-runtime.mjs',
    'desktop-selection.mjs',
    'desktop-source-status.mjs',
  ]) {
    fs.mkdirSync(path.join(STAGE, 'tools'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'tools', file), path.join(STAGE, 'tools', file));
  }
  fs.writeFileSync(
    path.join(STAGE, 'source.json'),
    JSON.stringify({
      revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
      repository: 'https://github.com/nbardy/buddies.git',
    })
  );
  await smokeRuntime(STAGE);
  if (args.has('--stage-only')) return;
  step(`electrobun build (${ELECTROBUN})`);
  run('pnpm', ['dlx', ELECTROBUN, 'build', '--env=stable'], { cwd: DESKTOP });
  step('outputs');
  for (const dir of ['build', 'artifacts']) {
    const full = path.join(DESKTOP, dir);
    if (!fs.existsSync(full)) continue;
    for (const entry of fs.readdirSync(full, { recursive: true })) {
      if (/\.(app|dmg)$/.test(entry))
        console.log(`${sizeOf(path.join(full, entry))}\t${dir}/${entry}`);
    }
  }
}

main().catch((error) => fail(error.stack ?? String(error)));
