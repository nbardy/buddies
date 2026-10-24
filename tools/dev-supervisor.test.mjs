import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBootRecorder } from './boot-phases.mjs';
import { ensureClientBuild } from './client-build.mjs';
import { assertPortsFree, claimDevRuntime, taskPlan } from './dev-supervisor.mjs';

test('the client bundle is never a serial step in front of the backend', () => {
  // 2026-10-23: an unconditional serial vite build put 38.6 s on every boot and leaked
  // NODE_ENV=production into the dev server. It is a concurrent service now.
  for (const task of ['dev', 'dev-server']) {
    const { steps, services } = taskPlan(task);
    assert.ok(services.includes('client-build'), task);
    assert.ok(
      !steps.some(({ args }) => args.includes('@unleashd/client') && args.includes('build')),
      task
    );
  }
  assert.ok(
    !taskPlan('dev-server', { UNLEASHD_DEV_PREBUILT: '1' }).services.includes('client-build')
  );
});

function clientFixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'client-build-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries({
    'client/src/main.ts': 'export {};',
    'client/index.html': '<html></html>',
    'client/package.json': '{}',
    'client/vite.config.ts': 'export default {};',
    'shared/src/index.ts': 'export const a = 1;',
    'shared/package.json': '{}',
    'pnpm-lock.yaml': 'lock',
  })) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  }
  return { root, cache: path.join(root, 'cache'), dist: path.join(root, 'client/dist') };
}

// A stand-in for `vite build`: records its pid, its NODE_ENV and whether the previous dist was
// still being served while it ran.
const fakeBuild =
  (fail = false) =>
  (clientRoot, outDirectory) => ({
    command: process.execPath,
    cwd: clientRoot,
    env: { NODE_ENV: 'production' },
    args: [
      '-e',
      `const fs = require('fs'), path = require('path');
     if (${fail}) process.exit(3);
     fs.mkdirSync(${JSON.stringify(outDirectory)}, { recursive: true });
     fs.writeFileSync(path.join(${JSON.stringify(outDirectory)}, 'index.html'), JSON.stringify({
       pid: process.pid, env: process.env.NODE_ENV,
       oldDistServing: fs.existsSync(${JSON.stringify(path.join(clientRoot, 'dist', 'index.html'))}),
     }));`,
    ],
  });

test('client bundle: built in a child, skipped while fresh, rebuilt when an input changes', async (t) => {
  const { root, cache, dist } = clientFixture(t);
  const envBefore = process.env.NODE_ENV;
  const options = { repositoryRoot: root, cacheDirectory: cache, buildCommand: fakeBuild() };
  const read = () => JSON.parse(readFileSync(path.join(dist, 'index.html'), 'utf8'));

  assert.equal((await ensureClientBuild(options)).kind, 'built');
  assert.notEqual(read().pid, process.pid);
  assert.equal(read().env, 'production');
  assert.equal(process.env.NODE_ENV, envBefore, 'a build must not change the supervisor NODE_ENV');

  const stamp = readFileSync(path.join(cache, 'client-dist.stamp.json'), 'utf8');
  const builtPid = read().pid;
  assert.equal((await ensureClientBuild(options)).kind, 'skipped');
  assert.equal(read().pid, builtPid);

  // shared/src is aliased into the bundle, so it is an input as much as client/src.
  writeFileSync(path.join(root, 'shared/src/index.ts'), 'export const a = 2;');
  assert.equal((await ensureClientBuild(options)).kind, 'built');
  assert.equal(read().oldDistServing, true, 'the previous dist keeps serving during a rebuild');
  assert.notEqual(readFileSync(path.join(cache, 'client-dist.stamp.json'), 'utf8'), stamp);

  // A deleted dist is stale even though the stamp matches.
  rmSync(dist, { recursive: true });
  assert.equal((await ensureClientBuild(options)).kind, 'built');
});

test('a failed client build keeps the previous dist and stays stale', async (t) => {
  const { root, cache, dist } = clientFixture(t);
  assert.equal(
    (
      await ensureClientBuild({
        repositoryRoot: root,
        cacheDirectory: cache,
        buildCommand: fakeBuild(),
      })
    ).kind,
    'built'
  );
  const before = readFileSync(path.join(dist, 'index.html'), 'utf8');
  writeFileSync(path.join(root, 'client/src/main.ts'), 'export const broken = 1;');
  const failing = { repositoryRoot: root, cacheDirectory: cache, buildCommand: fakeBuild(true) };
  assert.equal((await ensureClientBuild(failing)).kind, 'failed');
  assert.equal(readFileSync(path.join(dist, 'index.html'), 'utf8'), before);
  assert.equal((await ensureClientBuild(failing)).kind, 'failed', 'still stale, so it retries');
});

test('boot phases join on the boot id in <data dir>/observability/perf/boot.jsonl', (t) => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'boot-phases-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const boot = createBootRecorder({ env: { UNLEASHD_DATA_DIR: dataDir }, bootId: 'b1' });
  boot.phase('compilers', 1234.6);
  boot.phase('client-build', 0, { outcome: 'skipped' });
  const lines = readFileSync(path.join(dataDir, 'observability/perf/boot.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    lines.map(({ bootId, source, phase, ms }) => [bootId, source, phase, ms]),
    [
      ['b1', 'supervisor', 'compilers', 1235],
      ['b1', 'supervisor', 'client-build', 0],
    ]
  );
  assert.equal(lines[1].outcome, 'skipped');
});

function lockFile(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'dev-supervisor-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'dev-supervisor.lock.json');
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function idleProcess(t, options = {}) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    ...options,
  });
  t.after(() => {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {}
  });
  return child;
}

test('a live dev runtime is refused, a dead one is reclaimed', async (t) => {
  const file = lockFile(t);
  const live = idleProcess(t);
  writeFileSync(file, JSON.stringify({ pid: live.pid, childPgid: null }));
  await assert.rejects(claimDevRuntime({ file }), new RegExp(`PID ${live.pid}`));

  live.kill('SIGKILL');
  await new Promise((resolve) => live.once('exit', resolve));
  const runtime = await claimDevRuntime({ file });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, process.pid);
  runtime.release();
  assert.equal(existsSync(file), false);
});

test('replacing a runtime also kills the child group it recorded', async (t) => {
  // An owner that dies without forwarding the signal must not leave its
  // children running: an orphaned backend keeps the port and serves stale code
  // (2026-09-23).
  const file = lockFile(t);
  const owner = idleProcess(t);
  const orphanCandidate = idleProcess(t, { detached: true });
  writeFileSync(file, JSON.stringify({ pid: owner.pid, childPgid: orphanCandidate.pid }));

  const runtime = await claimDevRuntime({ file, replace: true });
  t.after(runtime.release);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(isAlive(owner.pid), false);
  assert.equal(isAlive(orphanCandidate.pid), false);
});

test('replacing a runtime kills the backend pid it recorded', async (t) => {
  // Regression (2026-10-23): the lock named only the last one-shot step's group, so --replace
  // waited out its timeout and SIGKILLed the supervisor while the 25 h backend child lived on.
  const file = lockFile(t);
  const owner = idleProcess(t);
  const backend = idleProcess(t);
  writeFileSync(file, JSON.stringify({ pid: owner.pid, childPgid: null, backendPid: backend.pid }));

  const runtime = await claimDevRuntime({ file, replace: true });
  t.after(runtime.release);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(isAlive(backend.pid), false);
});

test('a dev port held outside the runtime is refused with its PID', async (t) => {
  const holder = net.createServer();
  await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
  t.after(() => holder.close());
  const { port } = holder.address();
  await assert.rejects(
    assertPortsFree([port]),
    new RegExp(`port ${port} \\(PID ${process.pid}\\)`)
  );
});
