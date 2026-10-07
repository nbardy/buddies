import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
    assert.deepEqual(selectedRuntime(home, bundle), { runtime: bundle, source: null });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
