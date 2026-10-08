import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readSourceStatus, sourceStatusView, writeSourceStatus } from './desktop-source-status.mjs';
import { prepareSource, publishRuntime, selectedRuntime } from './desktop-source.mjs';

// Real filesystem/git boundary: version A survives failed staging/smoke and source edits;
// successful B is selected atomically, with A retained and no app-store writes.
test('managed runtime publishing keeps the old build until a new build passes smoke', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-update-'));
  const source = path.join(home, 'source');
  const bundle = path.join(home, 'bundle');
  fs.mkdirSync(source);
  const run = (command, args, options = {}) =>
    execFileSync(command, args, { cwd: source, ...options });
  try {
    run('git', ['init', '-q']);
    run('git', ['config', 'user.name', 'Fixture']);
    run('git', ['config', 'user.email', 'fixture@example.test']);
    fs.writeFileSync(path.join(source, 'version'), 'A');
    run('git', ['add', 'version']);
    run('git', ['commit', '-qm', 'A']);
    assert.deepEqual(selectedRuntime(home, bundle), { runtime: bundle, source: null });
    const stage = async (_root, target) => {
      fs.mkdirSync(path.join(target, 'server', 'dist'), { recursive: true });
      fs.copyFileSync(
        path.join(source, 'version'),
        path.join(target, 'server', 'dist', 'server.js')
      );
    };
    const smoke = async (target) =>
      assert.equal(
        fs.readFileSync(path.join(target, 'server', 'dist', 'server.js'), 'utf8'),
        fs.readFileSync(path.join(source, 'version'), 'utf8')
      );
    const options = { home, source, bundle, run, stage, smoke };
    const a = await publishRuntime(options);
    fs.writeFileSync(path.join(source, 'version'), 'B');
    await assert.rejects(publishRuntime(options), /Commit local source changes/);
    assert.equal(selectedRuntime(home, bundle).runtime, a);
    run('git', ['commit', '-qam', 'B']);
    await assert.rejects(
      publishRuntime({
        ...options,
        smoke: async () => {
          throw new Error('bad build');
        },
      }),
      /bad build/
    );
    assert.equal(selectedRuntime(home, bundle).runtime, a);
    assert.equal(fs.readFileSync(path.join(a, 'server', 'dist', 'server.js'), 'utf8'), 'A');
    assert.equal(fs.readdirSync(path.join(home, 'runtimes')).length, 1);
    const b = await publishRuntime(options);
    assert.equal(selectedRuntime(home, bundle).runtime, b);
    assert.equal(selectedRuntime(home, bundle).source, source);
    assert.equal(fs.readFileSync(path.join(a, 'server', 'dist', 'server.js'), 'utf8'), 'A');
    assert.equal(fs.readFileSync(path.join(b, 'server', 'dist', 'server.js'), 'utf8'), 'B');
    assert.ok(!fs.existsSync(path.join(home, 'agent-viewer')));
    assert.ok(!fs.existsSync(path.join(home, 'buddies')));
    fs.mkdirSync(bundle);
    fs.writeFileSync(
      path.join(bundle, 'source.json'),
      JSON.stringify({ revision: 'new-native-release' })
    );
    assert.deepEqual(selectedRuntime(home, bundle), { runtime: bundle, source });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('another live setup holds the source lock; a dead setup is recovered without changing selection', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-source-lock-'));
  const bundle = path.join(home, 'bundle');
  const lock = path.join(home, 'source-update.lock');
  try {
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, 'owner'), String(process.pid));
    await assert.rejects(prepareSource({ home, bundle }), /already running/);
    assert.ok(fs.existsSync(lock));
    fs.writeFileSync(path.join(lock, 'owner'), '2147483647');
    await assert.rejects(prepareSource({ home, bundle }), /source.json/);
    assert.ok(!fs.existsSync(lock));
    assert.equal(readSourceStatus(home).kind, 'failed');
    assert.equal(sourceStatusView(readSourceStatus(home), bundle).action, 'retry');
    assert.deepEqual(selectedRuntime(home, bundle), { runtime: bundle, source: null });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// PM review: silent interrupted setup left no recovery affordance. Progress must
// survive reopening, distinguish a live helper from a dead one, and expose Retry.
test('persisted source progress exposes preparation, interruption recovery and reopen activation', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-source-progress-'));
  try {
    writeSourceStatus(home, { kind: 'preparing', pid: process.pid, phase: 'Building the update' });
    assert.equal(readSourceStatus(home).kind, 'preparing');
    assert.equal(sourceStatusView(readSourceStatus(home), '/bundle').action, null);
    assert.match(
      sourceStatusView(readSourceStatus(home), '/bundle').message,
      /Building the update/
    );
    writeSourceStatus(home, { kind: 'preparing', pid: 2147483647, phase: 'Building the update' });
    const interrupted = readSourceStatus(home);
    assert.equal(interrupted.kind, 'failed');
    assert.equal(sourceStatusView(interrupted, '/bundle').action, 'retry');
    assert.match(sourceStatusView(interrupted, '/bundle').message, /Setup was interrupted.*Retry/s);
    writeSourceStatus(home, {
      kind: 'ready',
      runtime: '/verified-runtime',
      revision: '1234567890',
    });
    const ready = readSourceStatus(home);
    assert.equal(sourceStatusView(ready, '/bundle').action, 'quit');
    assert.match(sourceStatusView(ready, '/bundle').message, /Quit and reopen Buddies/);
    assert.equal(sourceStatusView(ready, '/verified-runtime').action, null);
    assert.equal(
      sourceStatusView({ ...ready, bundleRevision: 'old-native' }, '/new-native', 'new-native')
        .action,
      null
    );
    fs.writeFileSync(path.join(home, 'source-update-status.json'), '{broken');
    assert.equal(sourceStatusView(readSourceStatus(home), '/bundle').action, 'retry');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// A failed N checkout reused after installing N+1 must not bypass native selection.
test('publishing refuses an old checkout under a new bundle until a preserving merge', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop bundle floor '));
  const source = path.join(home, 'source');
  const bundle = path.join(home, 'bundle');
  fs.mkdirSync(source);
  fs.mkdirSync(bundle);
  const run = (command, args, options = {}) =>
    execFileSync(command, args, { cwd: source, ...options });
  const git = (...args) => run('git', args, { encoding: 'utf8', stdio: 'pipe' }).trim();
  const stage = async (_root, target) => {
    fs.mkdirSync(path.join(target, 'server/dist'), { recursive: true });
    fs.copyFileSync(path.join(source, 'version'), path.join(target, 'server/dist/server.js'));
  };
  const smoke = async () => {};
  try {
    git('init', '-q');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@example.test');
    fs.writeFileSync(path.join(source, 'version'), 'A');
    git('add', 'version');
    git('commit', '-qm', 'A');
    const a = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(bundle, 'source.json'), JSON.stringify({ revision: a }));
    const runtimeA = await publishRuntime({ home, source, bundle, run, stage, smoke });
    fs.writeFileSync(path.join(source, 'version'), 'B');
    git('commit', '-qam', 'B');
    const b = git('rev-parse', 'HEAD');
    git('checkout', '-q', a);
    fs.writeFileSync(path.join(bundle, 'source.json'), JSON.stringify({ revision: b }));
    const before = fs.readFileSync(path.join(home, 'active-runtime.json'), 'utf8');
    await assert.rejects(
      publishRuntime({ home, source, bundle, run, stage, smoke }),
      /does not include this bundled release/
    );
    assert.equal(fs.readFileSync(path.join(home, 'active-runtime.json'), 'utf8'), before);
    assert.equal(git('rev-parse', 'HEAD'), a);
    assert.deepEqual(selectedRuntime(home, bundle), { runtime: bundle, source });
    assert.equal(fs.readFileSync(path.join(runtimeA, 'server/dist/server.js'), 'utf8'), 'A');
    // A failed first setup has no manifest at all; retry still cannot label A as B.
    fs.unlinkSync(path.join(home, 'active-runtime.json'));
    await assert.rejects(
      publishRuntime({ home, source, bundle, run, stage, smoke }),
      /does not include this bundled release/
    );
    assert.ok(!fs.existsSync(path.join(home, 'active-runtime.json')));
    assert.deepEqual(selectedRuntime(home, bundle), { runtime: bundle, source: null });
    git('merge', '--ff-only', b);
    await publishRuntime({ home, source, bundle, run, stage, smoke });
    assert.equal(selectedRuntime(home, bundle).revision, b);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
