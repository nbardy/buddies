import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const script = path.resolve('tools/ensure-agent-cli.mjs');
test('bootstrap initializes an empty submodule and preserves a populated checkout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-submodule-'));
  const module = path.join(root, 'module');
  const repo = path.join(root, 'repo');
  const lane = path.join(root, 'lane');
  const git = (cwd, ...args) =>
    execFileSync('git', args, {
      cwd,
      stdio: 'pipe',
      env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file' },
    });
  try {
    for (const dir of [module, repo]) {
      fs.mkdirSync(dir);
      git(dir, 'init', '-q');
      git(dir, 'config', 'user.name', 'Bootstrap test');
      git(dir, 'config', 'user.email', 'test@example.invalid');
    }
    fs.writeFileSync(path.join(module, 'package.json'), '{"name":"fixture"}\n');
    git(module, 'add', 'package.json');
    git(module, 'commit', '-qm', 'module');
    git(repo, 'submodule', 'add', module, 'vendor/agent-cli-tool');
    git(repo, 'commit', '-qam', 'outer');
    git(repo, 'worktree', 'add', '-b', 'lane', lane);
    const checkout = path.join(lane, 'vendor/agent-cli-tool');
    assert.deepEqual(fs.readdirSync(checkout), []);
    const bootstrap = () =>
      execFileSync(process.execPath, [script], {
        cwd: lane,
        stdio: 'pipe',
        env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file' },
      });
    bootstrap();
    const file = path.join(checkout, 'package.json');
    assert.equal(fs.readFileSync(file, 'utf8'), '{"name":"fixture"}\n');
    fs.writeFileSync(file, 'local unfinished work\n');
    bootstrap();
    assert.equal(fs.readFileSync(file, 'utf8'), 'local unfinished work\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
