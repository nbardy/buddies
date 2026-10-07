// Pattern: one-definition (docs/patterns.md#one-definition)
//
// Fix-guard (2026-10-06, 10-08): a Buddy wrote plain `@Wave Simulation Lead` and the owner pasted
// `@Name`; both stored literally: no chip, no wake, and the write still reported success. Every
// post writer (the Buddy MCP `post`, the owner post route, the owner's answer) now stores the body
// that `resolveReferences` (shared/src/body-references.ts, the same code the owner composer shows
// its highlight from) returns for the channel's workspace roster, so the wake and the chip come
// from the one token form. Guards: `plain @Name mentions` in server/test/buddies-v2.test.ts,
// server/test/owner-mentions.test.ts.

import type { Actor, BuddiesCore, Buddy, Channel, Mention, PostKind } from '@unleashd/buddies-core';
import { type Resolution, mentionedIds, resolveReferences } from '@unleashd/shared';
import type { MentionPicks } from './events';
import { runConfigOfPick } from './worker-config';

/** The stored body for `workspaceId`'s roster (archived Buddies cannot be addressed). */
export async function resolveForWorkspace(
  core: Pick<BuddiesCore, 'listBuddies'>,
  workspaceId: string,
  body: string
): Promise<Resolution> {
  const buddies: Buddy[] = await core.listBuddies(workspaceId);
  return resolveReferences(
    body,
    buddies
      .filter((buddy) => buddy.status !== 'archived')
      .map((buddy) => ({ kind: 'buddy', id: buddy.id, name: buddy.name }))
  );
}

// Pattern: route-at-send (docs/patterns.md#route-at-send)
/**
 * The Buddies a post wakes, as the crate's `Mention`s: the @mentions of a public or task post, and
 * the DM's Buddies for the owner's plain DM post (a request or an answer starts its own run; a
 * Buddy's DM inform wakes nobody, so two Buddies cannot wake each other). Every writer passes the
 * result in `PostInput.mentions`; the crate writes one `deliver` run per Buddy in the post's own
 * transaction. The owner's chip pick for a Buddy rides its run.
 */
export function wakes(
  channel: Channel,
  author: Actor,
  kind: PostKind,
  body: string,
  picks: MentionPicks
): Mention[] {
  const ids = (() => {
    switch (channel.kind.type) {
      case 'public':
      case 'task':
        return mentionedIds(body).filter((id) => author.kind !== 'buddy' || author.id !== id);
      case 'direct':
        return author.kind === 'owner' && kind === 'inform'
          ? channel.kind.members.flatMap((member) => (member.kind === 'buddy' ? [member.id] : []))
          : [];
    }
  })();
  return ids.map((buddyId) => {
    const pick = picks.get(buddyId);
    return { buddyId, config: pick && runConfigOfPick(pick) };
  });
}
