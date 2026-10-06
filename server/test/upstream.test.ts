import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { BuddiesCore } from '@unleashd/buddies-core';
import { UpstreamStatusSchema, UpstreamUpdateResultSchema } from '@unleashd/shared';
import express from 'express';
import { mentionedBuddyIds } from '../src/buddies/channels';
import { OWNER, managerRef } from '../src/buddies/core';
import { createBuddyEvents } from '../src/buddies/events';
import { checkUpstream, resolveCheckout } from '../src/upstream/git-upstream';
import { createUpstreamService } from '../src/upstream/routes';
import { BOOTSTRAP_KEY, bootstrapUnleashdHome } from '../src/upstream/unleashd-home';

// Real git repositories and a real Buddies core (the crate). The only stand-in
// is the owner-mention responder, whose job is starting a provider turn.

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

function commit(repo: string, file: string): string {
  writeFileSync(join(repo, file), file);
  git(repo, 'add', file);
  git(repo, 'commit', '--quiet', '-m', file);
  return git(repo, 'rev-parse', 'HEAD');
}

/** A bare `origin`, an install cloned from it, and a second clone that publishes to it. */
function repositories() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'unleashd-upstream-')));
  const origin = join(root, 'origin.git');
  git(root, 'init', '--quiet', '--bare', '-b', 'main', origin);
  const publisher = join(root, 'publisher');
  mkdirSync(publisher);
  git(publisher, 'init', '--quiet', '-b', 'main');
  git(publisher, 'remote', 'add', 'origin', origin);
  commit(publisher, 'first.txt');
  git(publisher, 'push', '--quiet', 'origin', 'main');
  const install = join(root, 'install');
  git(root, 'clone', '--quiet', origin, install);
  return { root, origin, publisher, install };
}

test('the check fetches without moving the checkout and prefers an `upstream` remote', async (t) => {
  const { root, publisher, install } = repositories();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installHead = git(install, 'rev-parse', 'HEAD');

  const published = commit(publisher, 'second.txt');
  git(publisher, 'push', '--quiet', 'origin', 'main');
  const behind = await checkUpstream(await resolveCheckout(install));
  assert.equal(behind.kind, 'behind');
  assert.deepEqual(
    behind.kind === 'behind' && { remote: behind.remote, sha: behind.sha, behind: behind.behind },
    { remote: 'origin', sha: published, behind: 1 }
  );
  // Fetch-only: the install's HEAD did not move.
  assert.equal(git(install, 'rev-parse', 'HEAD'), installHead);

  // A fork's source is `upstream`; it wins over `origin` when both exist.
  const upstream = join(root, 'upstream.git');
  git(root, 'clone', '--quiet', '--bare', join(root, 'origin.git'), upstream);
  const upstreamPublisher = join(root, 'upstream-publisher');
  git(root, 'clone', '--quiet', upstream, upstreamPublisher);
  const upstreamSha = commit(upstreamPublisher, 'third.txt');
  git(upstreamPublisher, 'push', '--quiet', 'origin', 'main');
  git(install, 'remote', 'add', 'upstream', upstream);
  const fromUpstream = await checkUpstream(await resolveCheckout(install));
  assert.deepEqual(
    fromUpstream.kind === 'behind' && { remote: fromUpstream.remote, sha: fromUpstream.sha },
    { remote: 'upstream', sha: upstreamSha }
  );

  // A server started from a linked worktree resolves to the main checkout, so
  // agent worktrees never register workspaces of their own.
  const worktree = join(root, 'worktree');
  git(install, 'worktree', 'add', '--quiet', '--detach', worktree);
  assert.deepEqual(await resolveCheckout(worktree), { kind: 'checkout', root: install });
});

test('no remote and no checkout are typed as unavailable, not as up to date', async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'unleashd-upstream-bare-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const lonely = join(root, 'lonely');
  mkdirSync(lonely);
  git(lonely, 'init', '--quiet', '-b', 'main');
  commit(lonely, 'only.txt');
  const noRemote = await checkUpstream(await resolveCheckout(lonely));
  assert.equal(noRemote.kind === 'unavailable' && noRemote.reason, 'no_remote');

  const plain = join(root, 'plain');
  mkdirSync(plain);
  const notCheckout = await checkUpstream(await resolveCheckout(plain));
  assert.equal(notCheckout.kind === 'unavailable' && notCheckout.reason, 'not_git_checkout');
});

async function openCore(root: string): Promise<BuddiesCore> {
  return BuddiesCore.open(join(root, 'buddies-v3.sqlite'));
}

async function namedInWorkspace(core: BuddiesCore, workspaceId: string, name: string) {
  return (await core.listBuddies(workspaceId))
    .filter((buddy) => buddy.name === name)
    .map((buddy) => buddy.id);
}

async function publicChannelNames(core: BuddiesCore, workspaceId: string) {
  return (await core.inbox(OWNER, workspaceId)).channels.flatMap(({ channel }) =>
    channel.kind.type === 'public' ? [channel.kind.name] : []
  );
}

test('bootstrap converges: one workspace, one #upstream, one of each Buddy', async (t) => {
  const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'unleashd-home-')));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const core = await openCore(repoRoot);

  const first = await bootstrapUnleashdHome(core, repoRoot);
  const second = await bootstrapUnleashdHome(core, repoRoot);
  assert.deepEqual(second, first);
  assert.equal((await core.listWorkspaces()).length, 1);
  assert.deepEqual(await publicChannelNames(core, first.workspaceId), ['general', 'upstream']);
  assert.deepEqual(await namedInWorkspace(core, first.workspaceId, 'Product Dev'), [
    first.productDevId,
  ]);
  assert.deepEqual(await namedInWorkspace(core, first.workspaceId, 'Upstream Release Manager'), [
    first.releaseManagerId,
  ]);
  assert.equal((await core.listBuddies(first.workspaceId)).length, 2);
  // The hire carries its soul, written through the crate.
  const soul = await core.readDoc(OWNER, {
    buddyId: first.releaseManagerId,
    scope: { kind: 'buddy' },
    kind: 'soul',
    name: '',
  });
  assert.match(soul?.content ?? '', /Never reset, rebase/);
});

test('bootstrap reuses an existing "Product Development Lead" as Product Dev', async (t) => {
  const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'unleashd-home-reuse-')));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const core = await openCore(repoRoot);
  const workspace = await core.createWorkspace(OWNER, { name: 'unleashd', rootPath: repoRoot });
  const lead = await core.createBuddy(OWNER, {
    workspaceId: workspace.id,
    slug: 'product-development-lead',
    name: 'Product Development Lead',
    role: 'Lead product development',
    manager: managerRef(null),
    key: 'lead',
  });

  const first = await bootstrapUnleashdHome(core, repoRoot);
  const second = await bootstrapUnleashdHome(core, repoRoot);
  assert.equal(first.workspaceId, workspace.id);
  assert.equal(first.productDevId, lead.id);
  assert.deepEqual(second, first);
  assert.deepEqual(await namedInWorkspace(core, workspace.id, 'Product Dev'), []);
  assert.equal((await core.listBuddies(workspace.id)).length, 2);
});

const soulOf = async (core: BuddiesCore, buddyId: string) =>
  (await core.readDoc(OWNER, { buddyId, scope: { kind: 'buddy' }, kind: 'soul', name: '' }))
    ?.content;

test('bootstrap on a fresh store uses the Buddies copy', async (t) => {
  const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'unleashd-home-fresh-')));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const core = await openCore(repoRoot);
  const home = await bootstrapUnleashdHome(core, repoRoot);
  const [workspace] = await core.listWorkspaces();
  assert.equal(workspace.name, 'Buddies');
  const everyBuddy = await core.listBuddies(home.workspaceId);
  const copy = [
    ...everyBuddy.map((buddy) => buddy.role),
    ...(await Promise.all(everyBuddy.map((buddy) => soulOf(core, buddy.id)))),
    ...(await core.inbox(OWNER, home.workspaceId)).channels.map(({ channel }) =>
      channel.kind.type === 'public' ? channel.kind.purpose : ''
    ),
  ].join('\n');
  assert.match(copy, /Buddies install/);
  assert.doesNotMatch(copy, /Unleashd/);
});

// Regression guard for the 2026-10 public rename: the bootstrap runs on every start, so
// changing the copy constants must not rewrite or duplicate what a pre-rename install has.
// A "find the workspace/seat by its new display name" implementation fails every assertion.
test('bootstrap after the rename leaves a pre-rename install untouched', async (t) => {
  const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), 'unleashd-home-prerename-')));
  t.after(() => rmSync(repoRoot, { recursive: true, force: true }));
  const core = await openCore(repoRoot);

  // The OLD bootstrap's output, byte for byte: old copy under the old keys.
  const oldSoul = 'You are Product Dev for this Unleashd install.';
  const workspace = await core.createWorkspace(OWNER, { name: 'unleashd', rootPath: repoRoot });
  const channel = await core.createChannel(OWNER, {
    workspaceId: workspace.id,
    name: 'upstream',
    purpose:
      'Merging upstream Unleashd into this install: update requests, conflict reports and build results.',
    key: `${BOOTSTRAP_KEY}:channel:upstream`,
  });
  const hire = async (slug: string, name: string) => {
    const key = `${BOOTSTRAP_KEY}:buddy:${slug}`;
    const buddy = await core.createBuddy(OWNER, {
      workspaceId: workspace.id,
      slug,
      name,
      role: 'Owns the product roadmap of this Unleashd install',
      manager: managerRef(null),
      key,
    });
    await core.writeDoc(OWNER, {
      doc: { buddyId: buddy.id, scope: { kind: 'buddy' }, kind: 'soul', name: '' },
      content: oldSoul,
      baseRevision: 0,
      reason: 'hired',
      key: `${key}:soul`,
    });
    return buddy;
  };
  const productDev = await hire('product-dev', 'Product Dev');
  const releaseManager = await hire('upstream-release-manager', 'Upstream Release Manager');
  // Owner edits: a renamed Buddy with a rewritten soul, and a retired seat.
  await core.updateBuddy(OWNER, {
    buddyId: productDev.id,
    changes: { name: 'Rowan' },
    key: 'owner-rename',
  });
  await core.writeDoc(OWNER, {
    doc: { buddyId: productDev.id, scope: { kind: 'buddy' }, kind: 'soul', name: '' },
    content: 'Owner-written soul.',
    baseRevision: 1,
    reason: 'owner edit',
    key: 'owner-soul',
  });
  await core.updateBuddy(OWNER, {
    buddyId: releaseManager.id,
    changes: { status: 'archived' },
    key: 'owner-retire',
  });
  const before = JSON.stringify([
    await core.listWorkspaces(),
    await core.listBuddies(workspace.id),
    (await core.inbox(OWNER, workspace.id)).channels,
  ]);

  const home = await bootstrapUnleashdHome(core, repoRoot);
  const again = await bootstrapUnleashdHome(core, repoRoot);

  assert.deepEqual(again, home);
  assert.equal(home.workspaceId, workspace.id);
  assert.equal(home.channelId, channel.id);
  assert.equal(home.productDevId, productDev.id);
  assert.equal(home.releaseManagerId, releaseManager.id);
  assert.equal(
    JSON.stringify([
      await core.listWorkspaces(),
      await core.listBuddies(workspace.id),
      (await core.inbox(OWNER, workspace.id)).channels,
    ]),
    before,
    'workspace, Buddy and channel rows are byte-identical (no rename, no rehire, no new channel)'
  );
  assert.equal((await core.listWorkspaces())[0].name, 'unleashd');
  assert.equal((await core.getBuddy(releaseManager.id)).status, 'archived');
  assert.equal(await soulOf(core, productDev.id), 'Owner-written soul.');
  assert.equal(await soulOf(core, releaseManager.id), oldSoul);
});

test('update posts one @mention of the Release Manager per upstream sha', async (t) => {
  const { root, publisher, install } = repositories();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sha = commit(publisher, 'second.txt');
  git(publisher, 'push', '--quiet', 'origin', 'main');

  const core = await openCore(root);
  // The mentions each announced post would start (channels.ts dispatches from this event).
  const turns: string[] = [];
  const events = createBuddyEvents();
  events.on((event) => {
    if (event.kind === 'posted') turns.push(...mentionedBuddyIds(event.post.body));
  });
  const service = createUpstreamService({
    serverDirectory: install,
    core,
    events,
    uploadsRoot: () => join(root, 'uploads'),
  });
  const app = express();
  service.registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  );
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = () => fetch(`${base}/api/upstream/update`, { method: 'POST' });
  assert.equal((await request()).status, 409, 'bootstrap and check must be ready');
  const update = async () => {
    const response = await request();
    assert.equal(response.status, 201);
    return UpstreamUpdateResultSchema.parse(await response.json());
  };
  await Promise.all([service.bootstrap(), service.refresh()]);
  const { home } = UpstreamStatusSchema.parse(
    await (await fetch(`${base}/api/upstream/status`)).json()
  );
  assert.equal(home.kind, 'ready');
  if (home.kind !== 'ready') return;

  // A double click: two requests race, and both land on one post and one turn.
  const [a, b] = await Promise.all([update(), update()]);
  const again = await update();
  assert.deepEqual(b, a);
  assert.deepEqual(again, a);
  assert.deepEqual(turns, [home.releaseManagerId]);

  const { posts } = await core.listPosts(
    OWNER,
    { kind: 'channel', channelId: home.channelId },
    null,
    50
  );
  assert.equal(posts.length, 1);
  assert.deepEqual(mentionedBuddyIds(posts[0].body), [home.releaseManagerId]);
  assert.match(posts[0].body, new RegExp(`For folder ${install}: fetch upstream origin/main`));
  assert.deepEqual(posts[0].evidence, [`upstream origin/main ${sha}`]);

  // The original request may age beyond the newest page before another device answers.
  for (let index = 0; index < 101; index++) {
    await core.post(
      OWNER,
      { kind: 'id', id: home.channelId },
      {
        kind: 'inform',
        body: `Later channel activity ${index}`,
        evidence: [],
        mentions: [], broadcast: false,
        key: `activity:${index}`,
      }
    );
  }
  assert.deepEqual(await update(), a);
  assert.deepEqual(turns, [home.releaseManagerId], 'an older request never starts a second turn');
});
