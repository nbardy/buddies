import fs from 'node:fs';
import type { Buddy } from '@unleashd/buddies-core';
import { type BuddiesCore, OWNER, managerRef } from '../buddies/core';

// First-run home for an install: the checkout itself as a Buddy workspace
// named "Buddies", its #upstream channel, and two Buddies — Product Dev and
// the Upstream Release Manager. Runs on every server start and must converge:
// a second run changes nothing. Every write goes through the crate.
//
// Idempotence, per piece:
//   workspace — createWorkspace is idempotent by root path (real path here).
//   channel   — a public channel named "upstream" is reused, else created
//               under a fixed command key (the crate replays a repeated key).
//   Buddies   — a seat is filled by our own hire (found by its slug, in any
//               status: an archived hire stays archived, the owner retired
//               it), else by a matching active Buddy (e.g. the existing
//               "Product Development Lead"), else hired under a fixed key.

export const BOOTSTRAP_KEY = 'unleashd-bootstrap';
export const UPSTREAM_CHANNEL_NAME = 'upstream';
// Public copy is "Buddies" (the 2026-10 rename); the code identifiers, BOOTSTRAP_KEY and
// the command keys below stay "unleashd" because they are identity, not display.
// Why existing installs keep their old copy: the name/role/purpose/soul below are written
// ONLY when a piece is created. Reuse is keyed on the realpath rootPath, the seat slug and
// the public channel name "upstream" — never on these strings — so an install bootstrapped
// before the rename keeps whatever the owner sees and edited, and a retired seat stays
// retired. Do not "rename by name" or rewrite existing rows here; that duplicates the
// workspace or overwrites owner edits. Guard: "bootstrap after the rename leaves a
// pre-rename install untouched" in server/test/upstream.test.ts.
const WORKSPACE_NAME = 'Buddies';

export interface UnleashdHome {
  repoRoot: string;
  workspaceId: string;
  channelId: string;
  productDevId: string;
  releaseManagerId: string;
}

type Seat = {
  slug: string;
  name: string;
  role: string;
  soul: string;
  /** An existing, active workspace Buddy that already fills this seat. */
  fills(buddy: Buddy): boolean;
};

const PRODUCT_DEV: Seat = {
  slug: 'product-dev',
  name: 'Product Dev',
  role: 'Owns the product roadmap and development of this Buddies install',
  soul: [
    'You are Product Dev for this Buddies install.',
    'You own its product roadmap and development: decide what to build next from the owner’s goals and real usage, break it into Tasks, build or delegate it, and verify it works in the running app.',
    'Keep changes small and reviewable. Report what shipped, what is next, and anything you need from the owner.',
  ].join('\n\n'),
  fills: (buddy) => buddy.name.trim().toLowerCase().startsWith('product dev'),
};

const RELEASE_MANAGER: Seat = {
  slug: 'upstream-release-manager',
  name: 'Upstream Release Manager',
  role: 'Keeps this checkout merged with upstream Buddies',
  soul: [
    'You are the Upstream Release Manager for this Buddies install.',
    'You keep this checkout merged with upstream: commit any local edits first, fetch upstream main, and MERGE it in. Never reset, rebase, force-push or discard local work.',
    'Resolve conflicts by keeping both the local changes and upstream’s intent; ask the owner when the two genuinely disagree.',
    'After merging run `pnpm install && pnpm build`, then report in the thread what changed upstream, which conflicts you resolved and how, and whether the build passed.',
  ].join('\n\n'),
  fills: (buddy) => buddy.name.trim() === 'Upstream Release Manager',
};

async function ensureUpstreamChannel(core: BuddiesCore, workspaceId: string): Promise<string> {
  const { channels } = await core.inbox(OWNER, workspaceId);
  const existing = channels.find(
    ({ channel }) =>
      channel.kind.type === 'public' && channel.kind.name.toLowerCase() === UPSTREAM_CHANNEL_NAME
  );
  if (existing) return existing.channel.id;
  const created = await core.createChannel(OWNER, {
    workspaceId,
    name: UPSTREAM_CHANNEL_NAME,
    purpose:
      'Merging upstream Buddies into this install: update requests, conflict reports and build results.',
    key: `${BOOTSTRAP_KEY}:channel:${UPSTREAM_CHANNEL_NAME}`,
  });
  return created.id;
}

async function ensureSeat(core: BuddiesCore, workspaceId: string, seat: Seat): Promise<string> {
  const buddies = await core.listBuddies(workspaceId);
  const ours = buddies.find((buddy) => buddy.slug === seat.slug);
  if (ours) return ours.id;
  const filled = buddies.find((buddy) => buddy.status === 'active' && seat.fills(buddy));
  if (filled) return filled.id;
  const key = `${BOOTSTRAP_KEY}:buddy:${seat.slug}`;
  const hired = await core.createBuddy(OWNER, {
    workspaceId,
    slug: seat.slug,
    name: seat.name,
    role: seat.role,
    manager: managerRef(null),
    key,
  });
  await core.writeDoc(OWNER, {
    doc: { buddyId: hired.id, scope: { kind: 'buddy' }, kind: 'soul', name: '' },
    content: seat.soul,
    baseRevision: 0,
    reason: 'hired',
    key: `${key}:soul`,
  });
  return hired.id;
}

// Pattern: idempotency-keys (docs/patterns.md#idempotency-keys)
export async function bootstrapUnleashdHome(
  core: BuddiesCore,
  repoRoot: string
): Promise<UnleashdHome> {
  const workspace = await core.createWorkspace(OWNER, {
    name: WORKSPACE_NAME,
    // The crate's reuse key is the stored root path string: resolve it like the
    // "New workspace" route does (routes.ts workspaceInput).
    rootPath: fs.realpathSync(repoRoot),
  });
  return {
    repoRoot: workspace.rootPath,
    workspaceId: workspace.id,
    channelId: await ensureUpstreamChannel(core, workspace.id),
    productDevId: await ensureSeat(core, workspace.id, PRODUCT_DEV),
    releaseManagerId: await ensureSeat(core, workspace.id, RELEASE_MANAGER),
  };
}
