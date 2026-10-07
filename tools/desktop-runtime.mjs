// One payload layout and smoke boundary for DMGs and managed source updates.
// Pattern: one-definition (docs/patterns.md#one-definition)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, dereference: true });
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
  if (!fs.existsSync(path.join(crateDir, binary)))
    throw new Error(`${crateDir}/${binary} missing: pnpm addons`);
  return ['package.json', 'index.js', 'index.d.ts', binary];
}

export async function stageRuntime(ROOT, STAGE, node, run) {
  fs.rmSync(STAGE, { recursive: true, force: true });
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
  for (const file of addonFiles(buddies))
    copy(path.join(buddies, file), path.join(buddiesTarget, file));

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
export async function smokeRuntime(STAGE) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'buddies-desktop-smoke-'));
  const port = await sparePort();
  const nodeBin = path.join(STAGE, 'node', 'bin');
  const child = spawn(
    path.join(nodeBin, 'node'),
    [path.join(STAGE, 'server', 'dist', 'server.js')],
    {
      cwd: STAGE,
      env: {
        PATH: `${nodeBin}:/usr/bin:/bin`,
        HOME: temp,
        UNLEASHD_AUTO_INSTALL: '0',
        UNLEASHD_BUDDY_EXECUTION: '0',
        PORT: String(port),
        UNLEASHD_HOST: '127.0.0.1',
        UNLEASHD_DATA_DIR: path.join(temp, 'agent-viewer'),
        BUDDIES_HOME: path.join(temp, 'buddies'),
        UNLEASHD_BUDDIES_DB: path.join(temp, 'buddies', 'buddies-v3.sqlite'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const base = `http://127.0.0.1:${port}`;
  try {
    const started = Date.now();
    for (;;) {
      if (child.exitCode !== null) throw new Error(`server exited ${child.exitCode}:\n${output}`);
      if (Date.now() - started > 30_000) throw new Error(`no answer in 30s:\n${output}`);
      const ok = await fetch(`${base}/api/provider-catalog`).then(
        (r) => r.ok,
        () => false
      );
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
    if (!overview.some((workspace) => workspace.name === 'Smoke'))
      throw new Error('workspace not read back');
    console.log('ok payload: catalog, client, Buddies write + read');
  } finally {
    child.kill('SIGTERM');
    await exited;
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
