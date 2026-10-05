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
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

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

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, dereference: true });
}

async function nodeBinary() {
  const arch = os.arch() === 'arm64' ? 'arm64' : 'x64';
  const name = `node-${NODE_VERSION}-darwin-${arch}`;
  const binary = path.join(CACHE, name, 'bin', 'node');
  if (fs.existsSync(binary)) return binary;
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
  run('tar', ['-xzf', archive, '-C', CACHE, `${name}/bin/node`]);
  fs.rmSync(archive);
  return binary;
}

/** A workspace package reduced to the files its runtime loads. */
function replacePackage(nodeModules, name) {
  const target = path.join(nodeModules, name);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  return target;
}

function addonFiles(crateDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(crateDir, 'package.json'), 'utf8'));
  const binary = `${manifest.napi.binaryName}.node`;
  if (!fs.existsSync(path.join(crateDir, binary))) fail(`${crateDir}/${binary} missing: pnpm addons`);
  return ['package.json', 'index.js', 'index.d.ts', binary];
}

async function stage() {
  step('stage payload');
  fs.rmSync(path.join(DESKTOP, 'stage'), { recursive: true, force: true });
  const serverOut = path.join(STAGE, 'server');
  // Hoisted: real directories, no .pnpm symlink farm to survive the app-bundle copy.
  run('pnpm', [
    '--filter',
    '@unleashd/server',
    'deploy',
    '--prod',
    '--config.node-linker=hoisted',
    serverOut,
  ]);
  // deploy copies the package's git-tracked files (src/test, no dist); swap in the build.
  for (const entry of ['src', 'test', 'tsconfig.json', 'tsconfig.test.json']) {
    fs.rmSync(path.join(serverOut, entry), { recursive: true, force: true });
  }
  copy(path.join(ROOT, 'server', 'dist'), path.join(serverOut, 'dist'));
  copy(path.join(ROOT, 'client', 'dist'), path.join(STAGE, 'client', 'dist'));

  const nodeModules = path.join(serverOut, 'node_modules');
  fs.rmSync(path.join(nodeModules, '.bin'), { recursive: true, force: true });
  for (const [name, source] of [
    ['@unleashd/shared', path.join(ROOT, 'shared')],
    ['@nbardy/agent-cli', path.join(ROOT, 'vendor', 'agent-cli-tool')],
  ]) {
    const target = replacePackage(nodeModules, name);
    copy(path.join(source, 'package.json'), path.join(target, 'package.json'));
    copy(path.join(source, 'dist'), path.join(target, 'dist'));
  }
  const buddies = path.join(ROOT, 'crates', 'unleashd-buddies');
  const buddiesTarget = replacePackage(nodeModules, '@unleashd/buddies-core');
  for (const file of addonFiles(buddies)) copy(path.join(buddies, file), path.join(buddiesTarget, file));

  const ingest = path.join(ROOT, 'crates', 'unleashd-ingest');
  const ingestCopy = path.join(STAGE, 'crates', 'unleashd-ingest');
  for (const file of addonFiles(ingest)) copy(path.join(ingest, file), path.join(ingestCopy, file));
  const ingestShim = replacePackage(nodeModules, '@unleashd/ingest');
  copy(path.join(ingest, 'package.json'), path.join(ingestShim, 'package.json'));
  copy(path.join(ingest, 'index.d.ts'), path.join(ingestShim, 'index.d.ts'));
  fs.writeFileSync(
    path.join(ingestShim, 'index.js'),
    "// One ingest addon per process: config-records.ts loads payload/crates/unleashd-ingest by path.\nmodule.exports = require('../../../../crates/unleashd-ingest/index.js');\n"
  );

  const node = await nodeBinary();
  copy(node, path.join(STAGE, 'node', 'bin', 'node'));
  fs.chmodSync(path.join(STAGE, 'node', 'bin', 'node'), 0o755);
}

function sparePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * The payload must run with nothing from the dev machine: bundled node, PATH stripped to
 * /usr/bin:/bin, HOME and every store in a temp dir. Same checks as test/package-smoke.js.
 */
async function smoke() {
  step('smoke payload (bundled node, PATH=/usr/bin:/bin, temp state)');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'buddies-desktop-smoke-'));
  const port = await sparePort();
  const nodeBin = path.join(STAGE, 'node', 'bin');
  const child = spawn(path.join(nodeBin, 'node'), [path.join(STAGE, 'server', 'dist', 'server.js')], {
    cwd: STAGE,
    env: {
      PATH: `${nodeBin}:/usr/bin:/bin`,
      HOME: temp,
      PORT: String(port),
      UNLEASHD_HOST: '127.0.0.1',
      UNLEASHD_DATA_DIR: path.join(temp, 'agent-viewer'),
      BUDDIES_HOME: path.join(temp, 'buddies'),
      UNLEASHD_BUDDIES_DB: path.join(temp, 'buddies', 'buddies-v3.sqlite'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const base = `http://127.0.0.1:${port}`;
  try {
    const started = Date.now();
    for (;;) {
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}:\n${output}`);
      if (Date.now() - started > 30_000) throw new Error(`no answer in 30s:\n${output}`);
      const ok = await fetch(`${base}/api/provider-catalog`).then((r) => r.ok, () => false);
      if (ok) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    console.log(`ok listening after ${Date.now() - started}ms`);
    if (!(await fetch(base)).ok) throw new Error('client not served at /');
    const created = await fetch(`${base}/api/buddies/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Smoke', rootPath: temp }),
    });
    if (created.status !== 201) throw new Error(`create workspace: HTTP ${created.status}`);
    const overview = await (await fetch(`${base}/api/buddies/overview`)).json();
    if (!overview.some((workspace) => workspace.name === 'Smoke')) throw new Error('workspace not read back');
    console.log('ok payload: catalog, client, Buddies write + read');
  } finally {
    child.kill('SIGTERM');
    await exited;
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function sizeOf(target) {
  return execFileSync('du', ['-sh', target], { encoding: 'utf8' }).split('\t')[0];
}

async function main() {
  if (!args.has('--skip-build')) {
    step('pnpm build');
    run('pnpm', ['build']);
  }
  await stage();
  await smoke();
  step(`electrobun build (${ELECTROBUN})`);
  run('pnpm', ['dlx', ELECTROBUN, 'build', '--env=stable'], { cwd: DESKTOP });
  step('outputs');
  for (const dir of ['build', 'artifacts']) {
    const full = path.join(DESKTOP, dir);
    if (!fs.existsSync(full)) continue;
    for (const entry of fs.readdirSync(full, { recursive: true })) {
      if (/\.(app|dmg)$/.test(entry)) console.log(`${sizeOf(path.join(full, entry))}\t${dir}/${entry}`);
    }
  }
}

main().catch((error) => fail(error.stack ?? String(error)));
