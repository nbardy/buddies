import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareSource, selectedRuntime } from './desktop-source.mjs';

// Real Git merge and managed publish boundary: A→B must reconcile before install/build.
// Local nested edits and divergent commits must survive refusal with A still selected.
test('managed source gitlink update builds B and preserves nested edits on refusal', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop gitlink '));
  const source = path.join(home, 'source');
  const upstream = path.join(home, 'upstream');
  const harness = path.join(home, 'harness');
  const bundle = path.join(home, 'bundle');
  const env = { ...process.env, GIT_ALLOW_PROTOCOL: 'file' };
  const git = (cwd, ...args) =>
    execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  const init = (cwd) => {
    fs.mkdirSync(cwd);
    git(cwd, 'init', '-q');
    git(cwd, 'config', 'user.name', 'Fixture');
    git(cwd, 'config', 'user.email', 'fixture@example.test');
  };
  const calls = [];
  let built;
  const run = (command, args, options = {}) => {
    if (command === 'git') return execFileSync(command, args, { cwd: source, env, ...options });
    assert.equal(command, 'pnpm');
    calls.push(args[0]);
    // The compile/install adapter sees actual on-disk Git state, not a mocked gitlink.
    assert.equal(git(source, 'status', '--porcelain'), '');
    built = fs.readFileSync(path.join(source, 'vendor/agent-cli-tool/version'), 'utf8');
  };
  const stage = async (_source, target) => {
    fs.mkdirSync(path.join(target, 'server/dist'), { recursive: true });
    fs.writeFileSync(path.join(target, 'server/dist/server.js'), built);
  };
  const smoke = async (target) =>
    assert.equal(fs.readFileSync(path.join(target, 'server/dist/server.js'), 'utf8'), built);
  try {
    init(harness);
    fs.writeFileSync(path.join(harness, 'version'), 'A');
    git(harness, 'add', 'version');
    git(harness, 'commit', '-qm', 'harness A');
    const nestedA = git(harness, 'rev-parse', 'HEAD');
    init(upstream);
    fs.writeFileSync(path.join(upstream, '.gitignore'), 'build-output\n');
    git(upstream, 'submodule', 'add', '-q', harness, 'vendor/agent-cli-tool');
    git(upstream, 'add', '.');
    git(upstream, 'commit', '-qm', 'outer A');
    const outerA = git(upstream, 'rev-parse', 'HEAD');
    git(home, 'clone', '-q', '--recursive', upstream, source);
    fs.mkdirSync(bundle);
    fs.writeFileSync(path.join(bundle, 'source.json'), JSON.stringify({ revision: outerA }));
    const pnpm = path.join(home, 'toolchain/node_modules/pnpm/bin/pnpm.cjs');
    fs.mkdirSync(path.dirname(pnpm), { recursive: true });
    fs.writeFileSync(pnpm, 'fixture');
    const options = { home, bundle, publishOnly: true, run, stage, smoke };
    const runtimeA = await prepareSource(options);
    assert.deepEqual(calls.splice(0), ['install', 'build', 'typecheck']);
    fs.writeFileSync(path.join(harness, 'version'), 'B');
    git(harness, 'commit', '-qam', 'harness B');
    const nestedB = git(harness, 'rev-parse', 'HEAD');
    git(path.join(upstream, 'vendor/agent-cli-tool'), 'fetch', 'origin');
    git(path.join(upstream, 'vendor/agent-cli-tool'), 'checkout', '-q', nestedB);
    git(upstream, 'commit', '-qam', 'outer B');
    const outerB = git(upstream, 'rev-parse', 'HEAD');
    git(source, 'fetch', 'origin');
    git(source, 'merge', '--ff-only', outerB);
    const nested = path.join(source, 'vendor/agent-cli-tool');
    assert.equal(git(nested, 'rev-parse', 'HEAD'), nestedA);
    assert.match(git(source, 'status', '--porcelain'), /vendor\/agent-cli-tool/);
    for (const edit of ['tracked', 'untracked', 'staged']) {
      const file = path.join(nested, edit === 'untracked' ? 'owner-note' : 'version');
      fs.writeFileSync(file, 'owner edit');
      if (edit === 'staged') git(nested, 'add', 'version');
      await assert.rejects(prepareSource(options), /Refusing local submodule edits/);
      assert.equal(fs.readFileSync(file, 'utf8'), 'owner edit');
      assert.equal(git(nested, 'rev-parse', 'HEAD'), nestedA);
      assert.equal(selectedRuntime(home, bundle).runtime, runtimeA);
      assert.deepEqual(calls, []);
      if (edit === 'untracked') fs.unlinkSync(file);
      else git(nested, 'restore', '--source=HEAD', '--staged', '--worktree', 'version');
    }
    git(nested, 'config', 'user.name', 'Fixture');
    git(nested, 'config', 'user.email', 'fixture@example.test');
    git(nested, 'switch', '-qc', 'owner-work');
    fs.writeFileSync(path.join(nested, 'version'), 'local commit');
    git(nested, 'commit', '-qam', 'owner work');
    const ownerCommit = git(nested, 'rev-parse', 'HEAD');
    await assert.rejects(prepareSource(options), /Refusing divergent submodule commits/);
    assert.equal(git(nested, 'rev-parse', 'HEAD'), ownerCommit);
    assert.equal(selectedRuntime(home, bundle).runtime, runtimeA);
    assert.deepEqual(calls, []);
    git(nested, 'checkout', '-q', nestedA);
    const runtimeB = await prepareSource(options);
    assert.deepEqual(calls, ['install', 'build', 'typecheck']);
    assert.equal(git(nested, 'rev-parse', 'HEAD'), nestedB);
    assert.equal(git(nested, 'rev-parse', 'owner-work'), ownerCommit);
    assert.equal(git(source, 'status', '--porcelain'), '');
    assert.equal(selectedRuntime(home, bundle).revision, outerB);
    assert.equal(fs.readFileSync(path.join(runtimeA, 'server/dist/server.js'), 'utf8'), 'A');
    assert.equal(fs.readFileSync(path.join(runtimeB, 'server/dist/server.js'), 'utf8'), 'B');
    console.log(JSON.stringify({ outerA, nestedA, outerB, nestedB, ownerCommit }));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
