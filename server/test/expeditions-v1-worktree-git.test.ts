import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { worktreeGit } from '../src/expeditions-v1/executor/calls';

// Regression, second real expedition run (2026-11-11): a Codex checkout call could not commit.
// Its sandbox made only the worktree writable, and a linked worktree's index, HEAD, objects and
// branch ref live in the main repository's `.git` ("Unable to create
// .../.git/worktrees/tree/index.lock: Operation not permitted"); the work stayed uncommitted and
// its judge failed it. Since then a checkout's capability set names those directories
// (agent-cli `TurnGit`), resolved by `worktreeGit`. This holds the set COMPLETE without a sandbox:
// a real `git commit` on the call's branch writes nothing outside the worktree and that set. A git
// that starts writing somewhere new fails here instead of failing every sandboxed commit.

const run = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: os.tmpdir(),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    },
  }).trim();

/** Every file under `dir` with a digest of its bytes. */
function files(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.set(p, createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
    }
  };
  walk(dir);
  return out;
}

test('a commit in a checkout writes only inside its worktree and the git metadata its set names', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xk-worktree-git-')));
  try {
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);
    run(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    run(repo, 'add', '.');
    run(repo, 'commit', '-qm', 'init');
    // As the executor names them: every checkout path ends in `tree`, and a sibling branch of the
    // same expedition already exists.
    const branch = 'expedition/20261111T000000-abcdef/shout-12345678-a1';
    run(repo, 'branch', 'expedition/20261111T000000-abcdef/farewell-87654321-a1');
    const tree = path.join(root, 'runs', 'x', 'tree');
    run(repo, 'worktree', 'add', '-q', '-b', branch, tree, 'main');

    const git = await worktreeGit(tree, branch);
    assert.equal(git.t, 'worktree');
    const dirs = git.t === 'worktree' ? git.dirs : [];
    const inside = (p: string) => [tree, ...dirs].some((d) => p === d || p.startsWith(`${d}/`));
    // The repository's config and hooks are never in the set.
    for (const p of ['config', 'hooks/pre-commit'].map((f) => path.join(repo, '.git', f)))
      assert.ok(!inside(p), `${p} is not writable`);

    const before = files(path.join(repo, '.git'));
    fs.appendFileSync(path.join(tree, 'a.txt'), 'b\n');
    run(tree, 'add', 'a.txt');
    run(tree, 'commit', '-qm', 'b');

    const after = files(path.join(repo, '.git'));
    const touched = [...after].filter(([p, h]) => before.get(p) !== h).map(([p]) => p);
    assert.ok(touched.length > 0, 'the commit wrote git metadata');
    assert.deepEqual(
      touched.filter((p) => !inside(p)),
      [],
      'the commit wrote outside the worktree and its set'
    );
    assert.equal(run(repo, 'log', '-1', '--format=%s', branch), 'b');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
