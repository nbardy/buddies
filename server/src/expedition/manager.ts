import type { BuddiesCore } from '@unleashd/buddies-core';
import { OWNER, buddyActor } from '../buddies/core';
import { type BuddyEvents, announcePost } from '../buddies/events';

export function manager(core: BuddiesCore, events: BuddyEvents) {
  return async (id: string, buddyId: string, question: string, folder: string, key: string) => {
    const self = buddyActor(buddyId);
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
