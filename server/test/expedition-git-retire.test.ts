import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { killCheck, pidfileOf, runCommand } from '../src/expeditions/command';
import { archiveBranch, expeditionRefs, snapshotDirty } from '../src/expeditions/git';
import {
  dirtyRefOf,
  releaseDetachedTree,
  releaseIntegrationTree,
  releaseWorktree,
} from '../src/expeditions/release';
import { tempDir } from './fixtures/temp';

// The git primitives retire stands on (plan A3), on real repositories, a real bare remote and
// the real Cambium; nothing is mocked. Each case is a failure the owner's machine produced or a
// step whose order is the safety: a remove refused by a submodule, a remove killed mid-delete
// that stranded 2582 ` D` lines (emergent-beach), a branch deleted while its only copy was
// local, and a check orphaned by a crash.

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const cambiumCli = (cwd: string, ...args: string[]) =>
  execFileSync('git-cambium', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const fileAllowed = ['-c', 'protocol.file.allow=always'];

function repoWithSubmodule(scratch: string) {
  const sub = path.join(scratch, 'sub');
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, 'lib.txt'), 'lib\n');
  git(sub, 'init', '-q', '-b', 'main');
  git(sub, 'config', 'user.email', 'test@example.com');
  git(sub, 'config', 'user.name', 'Test');
  git(sub, 'add', '.');
  git(sub, 'commit', '-q', '-m', 'lib');
  const repo = path.join(scratch, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  git(repo, ...fileAllowed, 'submodule', 'add', '-q', sub, 'sub');
  git(repo, 'commit', '-q', '-m', 'submodule');
  return { repo, base: git(repo, 'rev-parse', 'HEAD') };
}

const keepIn = (scratch: string, tree: string) => ({
  salvageRef: `refs/salvage/expeditions/e1/${tree}`,
  harvestDir: path.join(scratch, 'harvest', tree),
});

test('a forced remove takes a tree holding an initialized submodule; the branch stays', async () => {
  const scratch = tempDir('exp-git-retire-');
  const { repo, base } = repoWithSubmodule(scratch);
  const dir = path.join(scratch, 'integration');
  cambiumCli(repo, 'add', '-b', 'expedition/e1', '-name', 'e1-integration', dir, base);
  git(dir, ...fileAllowed, 'submodule', 'update', '--init', '-q');
  assert.ok(fs.existsSync(path.join(dir, 'sub', 'lib.txt')), 'the submodule is initialized');

  const released = await releaseIntegrationTree(
    repo,
    { path: dir, branch: 'expedition/e1' },
    keepIn(scratch, 'integration'),
    { t: 'finish' }
  );
  assert.deepEqual(released.release, { t: 'removed', branchDeleted: false });
  assert.equal(fs.existsSync(dir), false);
  assert.equal(git(repo, 'rev-parse', 'refs/heads/expedition/e1'), base);
});

test('retire removes a deletions-only tree and snapshots a modified one; finish refuses it', async () => {
  const scratch = tempDir('exp-git-retire-');
  const { repo, base } = repoWithSubmodule(scratch);
  const into = 'expedition/e1';
  git(repo, 'branch', into, base);
  const tree = (id: string) => {
    const at = { path: path.join(scratch, id), branch: `exp/e1/${id}`, baseSha: base };
    cambiumCli(repo, 'add', '-b', at.branch, '-name', `e1-${id}`, '-ephemeral', at.path, base);
    return at;
  };

  // A killed remove leaves tracked files deleted: HEAD holds them, so retire loses nothing.
  const deleted = tree('a1');
  fs.rmSync(path.join(deleted.path, 'a.txt'));
  fs.rmSync(path.join(deleted.path, 'b.txt'));
  const gone = await releaseWorktree(repo, deleted, false, into, keepIn(scratch, 'a1'), {
    t: 'retire',
  });
  assert.deepEqual(gone, { release: { t: 'removed', branchDeleted: true }, preserved: [] });
  assert.equal(fs.existsSync(deleted.path), false);

  const edited = tree('a2');
  fs.writeFileSync(path.join(edited.path, 'a.txt'), 'edited by a worker\n');
  fs.writeFileSync(path.join(edited.path, 'new.txt'), 'untracked\n');
  const keep = keepIn(scratch, 'a2');
  const refused = await releaseWorktree(repo, edited, false, into, keep, { t: 'finish' });
  assert.equal(refused.release.t, 'left', 'finish never removes uncommitted work');
  assert.ok(fs.existsSync(edited.path));

  const retired = await releaseWorktree(repo, edited, false, into, keep, { t: 'retire' });
  assert.equal(retired.release.t, 'removed');
  assert.equal(fs.existsSync(edited.path), false);
  const ref = dirtyRefOf(keep);
  const sha = git(repo, 'rev-parse', ref);
  assert.deepEqual(retired.preserved, [{ t: 'salvaged', ref, sha }]);
  assert.equal(git(repo, 'show', `${sha}:a.txt`), 'edited by a worker');
  assert.equal(git(repo, 'show', `${sha}:new.txt`), 'untracked');
  assert.equal(git(repo, 'rev-parse', `${sha}^`), base, 'the snapshot sits on the tree HEAD');
});

// Regression (review of plan A3): a retire whose forced remove was killed partway is asked
// again; the half-deleted tree then snapshots again at the same `-dirty` ref. Overwriting the pin
// lost the first snapshot, the only copy of the edits (refs/salvage keeps no reflog).
test('a second dirty snapshot at the same ref keeps the first as a parent', async () => {
  const scratch = tempDir('exp-git-retire-');
  const { repo, base } = repoWithSubmodule(scratch);
  const dir = path.join(scratch, 'a3');
  git(repo, 'worktree', 'add', '-q', '-b', 'exp/e1/a3', dir, base);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'only copy of this edit\n');
  const ref = 'refs/salvage/expeditions/e1/a3-dirty';
  const first = await snapshotDirty(dir, ref, 'first');
  fs.rmSync(path.join(dir, 'a.txt')); // the killed remove deleted it
  const second = await snapshotDirty(dir, ref, 'second');
  assert.equal(git(repo, 'rev-parse', ref), second);
  assert.equal(git(repo, 'rev-parse', `${second}^2`), first, 'the first snapshot stays reachable');
  assert.equal(git(repo, 'show', `${ref}^2:a.txt`), 'only copy of this edit');
});

test('a plain git registration (no Cambium entry) is removed and pruned', async () => {
  const scratch = tempDir('exp-git-retire-');
  const { repo, base } = repoWithSubmodule(scratch);
  const dir = path.join(scratch, 'manager');
  git(repo, 'worktree', 'add', '-q', '--detach', dir, base);
  git(dir, ...fileAllowed, 'submodule', 'update', '--init', '-q');
  const released = await releaseDetachedTree(repo, dir, keepIn(scratch, 'manager'));
  assert.deepEqual(released.release, { t: 'removed', branchDeleted: false });
  assert.equal(fs.existsSync(dir), false);
  const registered = path.join(fs.realpathSync(scratch), 'manager');
  assert.ok(!git(repo, 'worktree', 'list', '--porcelain').includes(registered));
});

test('archiveBranch deletes a branch only after origin holds its tag at the tip', async () => {
  const scratch = tempDir('exp-git-retire-');
  const { repo, base } = repoWithSubmodule(scratch);
  git(repo, 'branch', 'exp/e1/a1', base);
  git(repo, 'branch', 'exp/e10/a1', base);
  git(repo, 'update-ref', 'refs/salvage/expeditions/e1/a2', base);
  // A prefix match without the trailing slash would sweep in e10's branch.
  assert.deepEqual(await expeditionRefs(repo, 'e1'), [
    'refs/heads/exp/e1/a1',
    'refs/salvage/expeditions/e1/a2',
  ]);

  // No remote: refused, and the branch is still the only copy.
  const refused = await archiveBranch(repo, 'refs/heads/exp/e1/a1', 'archive/expeditions/e1/a1');
  assert.equal(refused.t, 'refused');
  assert.equal(git(repo, 'rev-parse', 'refs/heads/exp/e1/a1'), base);

  const remote = path.join(scratch, 'remote.git');
  git(scratch, 'init', '-q', '--bare', remote);
  git(repo, 'remote', 'add', 'origin', remote);
  const archived = await archiveBranch(repo, 'refs/heads/exp/e1/a1', 'archive/expeditions/e1/a1');
  assert.deepEqual(archived, { t: 'archived', sha: base, tag: 'archive/expeditions/e1/a1' });
  assert.equal(git(remote, 'rev-parse', 'refs/tags/archive/expeditions/e1/a1'), base);
  assert.equal(git(repo, 'for-each-ref', 'refs/heads/exp/e1/'), '');

  // A tag already at another commit is never moved, and its branch stays.
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'later');
  git(repo, 'branch', 'exp/e1/a3', 'HEAD');
  git(repo, 'tag', 'archive/expeditions/e1/a3', base);
  const clash = await archiveBranch(repo, 'refs/heads/exp/e1/a3', 'archive/expeditions/e1/a3');
  assert.equal(clash.t, 'refused');
  assert.ok(git(repo, 'rev-parse', 'refs/heads/exp/e1/a3'));
});

test('killCheck kills an orphaned check only while its pid has the recorded start time', async () => {
  const scratch = tempDir('exp-git-retire-');
  const scratchDir = path.join(scratch, 'v1.scratch');
  const pidfile = pidfileOf(scratchDir);
  // A pid now held by another process (start time differs) is never signalled.
  fs.mkdirSync(scratchDir, { recursive: true });
  fs.writeFileSync(
    pidfile,
    JSON.stringify({ pid: process.pid, lstart: 'Thu Jan  1 00:00:00 1970' })
  );
  assert.deepEqual(await killCheck(pidfile), { t: 'not_running' });

  // A running check (the crash orphan stands in for one whose server died) is killed.
  const running = runCommand({ argv: ['sleep', '60'], timeoutSeconds: 120 }, scratch, scratchDir);
  const deadline = Date.now() + 20_000;
  while (!fs.existsSync(pidfile) || fs.readFileSync(pidfile, 'utf8').includes('1970')) {
    assert.ok(Date.now() < deadline, 'the pidfile is written');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const killed = await killCheck(pidfile);
  assert.equal(killed.t, 'killed');
  const outcome = await running;
  assert.equal(outcome.t, 'failed');
  assert.equal(fs.existsSync(pidfile), false, 'a check that ends removes its pidfile');
  assert.deepEqual(await killCheck(pidfile), { t: 'no_record' });
});
