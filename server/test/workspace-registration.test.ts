import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BuddiesCore } from '@unleashd/buddies-core';
import { OWNER } from '../src/buddies/core';
import { workspaceRegistration } from '../src/buddies/workspace-registration';
import { bootstrapUnleashdHome } from '../src/upstream/unleashd-home';

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function repository(root: string, name: string) {
  const folder = join(root, name);
  mkdirSync(folder);
  git(folder, 'init', '--quiet');
  writeFileSync(join(folder, 'first'), name);
  git(folder, 'add', 'first');
  git(
    folder,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '--quiet',
    '-m',
    name
  );
  return folder;
}

test('bootstrap follows a renamed checkout without duplicating its team', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-rename-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = repository(root, 'original');
  const db = join(root, 'buddies.sqlite');
  let core = await BuddiesCore.open(db);
  // A pre-feature workspace is enriched on its next registration before it moves.
  const legacy = await core.createWorkspace(OWNER, { name: 'Owner name', rootPath: old });
  const before = await bootstrapUnleashdHome(core, old);
  assert.equal(before.workspaceId, legacy.id);
  const team = await core.listBuddies(legacy.id);
  const channels = (await core.inbox(OWNER, legacy.id)).channels;
  const moved = join(root, 'renamed');
  renameSync(old, moved);
  core = await BuddiesCore.open(db); // process restart: identity is durable, not an in-memory map
  const after = await bootstrapUnleashdHome(core, moved);
  assert.deepEqual(after, { ...before, repoRoot: moved });
  assert.deepEqual(await core.listBuddies(legacy.id), team);
  assert.deepEqual((await core.inbox(OWNER, legacy.id)).channels, channels);
  const [workspace] = await core.listWorkspaces();
  assert.equal(workspace.name, 'Owner name');
  assert.deepEqual(workspace.folders, [old, moved]);
  assert.equal((await core.listWorkspaces()).length, 1);

  // Owner registration uses exactly the same path; retry does not add a folder twice.
  const again = await core.createWorkspace(
    OWNER,
    await workspaceRegistration({ name: 'Ignored', rootPath: moved })
  );
  assert.equal(again.id, legacy.id);
  assert.deepEqual(again.folders, [old, moved]);
  // If the most recently registered folder disappears, use the newest surviving folder.
  renameSync(moved, old);
  assert.equal((await core.listWorkspaces())[0].rootPath, old);
});

test('registration keeps active clones and subprojects separate and refuses ambiguous moves', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-clones-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = repository(root, 'source');
  const clone = join(root, 'clone');
  git(root, 'clone', '--quiet', source, clone);
  const core = await BuddiesCore.open(join(root, 'buddies.sqlite'));
  const register = async (folder: string) =>
    core.createWorkspace(OWNER, await workspaceRegistration({ name: folder, rootPath: folder }));
  const first = await register(source);
  const second = await register(clone);
  assert.notEqual(first.id, second.id, 'shared Git roots never merge existing checkouts');
  const subproject = join(source, 'subproject');
  mkdirSync(subproject);
  const third = await register(subproject);
  assert.notEqual(first.id, third.id, 'a repository subfolder is its own workspace');
  const moved = join(root, 'moved');
  renameSync(source, moved);
  rmSync(clone, { recursive: true });
  await assert.rejects(register(moved), /registration is ambiguous/);
  assert.equal((await core.listWorkspaces()).length, 3, 'an ambiguous registration writes nothing');
});

test('plain directories and unborn Git repositories register idempotently by folder', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-plain-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const core = await BuddiesCore.open(join(root, 'buddies.sqlite'));
  const input = { name: 'Plain', rootPath: root };
  const first = await core.createWorkspace(OWNER, await workspaceRegistration(input));
  git(root, 'init', '--quiet');
  const second = await core.createWorkspace(OWNER, await workspaceRegistration(input));
  assert.equal(first.id, second.id);
  assert.equal(second.repositoryIdentity, undefined);
});
