import type { BuddiesCore } from '@unleashd/buddies-core';
import type { ExpeditionDiscussion } from '@unleashd/shared';
import { OWNER, buddyActor } from '../buddies/core';
import { type BuddyEvents, announcePost } from '../buddies/events';

export function managerDiscussion(core: BuddiesCore, events: BuddyEvents) {
  return async (
    id: string,
    workspaceId: string,
    buddyId: string,
    folder: string
  ): Promise<ExpeditionDiscussion> => {
    const buddy = await core.getBuddy(buddyId);
    if (buddy.workspaceId !== workspaceId || buddy.status !== 'active')
      throw new Error('The expedition manager is unavailable in this workspace');
    // Pattern: idempotency-keys (docs/patterns.md#idempotency-keys)
    // The root carries context on the first reply without starting a delivery by itself.
    // A retry or restart after the post commits must recover the same thread. Guard: expedition-backend.
    const { post, created } = await core.post(
      OWNER,
      { kind: 'direct', members: [OWNER, buddyActor(buddyId)] },
      {
        kind: 'inform',
        purpose: 'expedition_chat',
        body: `Discussion for expedition ${id}. You are its manager. For the current status, use the expedition tool with {action:{do:"status",id:"${id}"}}. Read ${folder}/log.jsonl and ${folder}/plan.expedition.ts for evidence. Reply in this thread.`,
        mentions: [],
        evidence: [],
        broadcast: false,
        key: `expedition:${id}:discussion`,
      }
    );
    if (created) await announcePost({ core, events }, OWNER, post);
    return { channelId: post.channelId, rootId: post.id };
  };
}

export function manager(core: BuddiesCore, events: BuddyEvents) {
  return async (id: string, buddyId: string, question: string, folder: string, key: string) => {
    const self = buddyActor(buddyId);
    // Recovery resends this key and payload. Changing either string needs a version saved with the wake.
    const result = await core.post(
      self,
      { kind: 'direct', members: [self] },
      {
        kind: 'request',
        purpose: 'expedition_manager',
        mentions: [],
        evidence: [],
        broadcast: false,
        key: `expedition:${id}:${key}`,
        body: `Expedition ${id} needs your decision: ${question}\nRead ${folder}/log.jsonl and ${folder}/plan.expedition.ts. Act through expedition {action:{do:"continue"|"stop"|"rewrite",id:"${id}",why}}. For rewrite, edit that plan file first, preserve its owner contract, then call the tool. Rejections return issues immediately; fix them and call again in this turn. Record what you learned in your Buddy memory.`,
      }
    );
    if (result.created) await announcePost({ core, events }, OWNER, result.post);
  };
}
