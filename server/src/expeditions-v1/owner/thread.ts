import type { BuddiesCore } from '../../buddies/core';
import { OWNER, buddyActor } from '../../buddies/core';
import type { Thread } from '../../buddies/owner-thread';

// Where a keyed expedition talks to its owner (CONNECT_PLAN §2): ONE thread in the DM between the
// owner and the contract's leader Buddy, rooted at a leader-authored post keyed `xk:<id>:thread`
// (buddies/owner-thread.ts: the key makes the root idempotent, so it is also how it is found).
// Asks are their own roots in the same DM (executor/asks.ts). Every post the host writes there
// carries the evidence `expedition-v1:<id>`.

export const THREAD_PURPOSE = 'expedition_thread';
export const STATUS_PURPOSE = 'expedition_status';
export const ASK_PURPOSE = 'expedition_ask';
export const evidenceOf = (expedition: string) => `expedition-v1:${expedition}`;

const firstLine = (text: string) => (text.trim().split('\n')[0] ?? '').slice(0, 200);

/** The expedition's thread. The root's body is a pure function of the expedition, so the key
 * replays it exactly. */
export function expeditionThread(x: {
  readonly id: string;
  readonly goal: string;
  readonly leader: string;
  readonly channelId: string;
}): Thread {
  return {
    author: buddyActor(x.leader),
    channelId: x.channelId,
    evidence: evidenceOf(x.id),
    root: {
      body: [
        `🧭 Expedition ${x.id}: ${firstLine(x.goal)}`,
        'Reply in this thread to steer it: pause · resume · stop · extend 2h · retry <key> · approve · decline. Anything else is a note the leader reads at its next wake; it wakes nobody.',
      ].join('\n'),
      purpose: THREAD_PURPOSE,
      key: `xk:${x.id}:thread`,
    },
    statusPurpose: STATUS_PURPOSE,
  };
}

/** The owner↔leader DM (opened if it does not exist yet). */
export async function leaderDm(core: BuddiesCore, leader: string): Promise<string> {
  const channel = await core.openChannel(OWNER, {
    kind: 'direct',
    members: [OWNER, buddyActor(leader)],
  });
  return channel.id;
}
