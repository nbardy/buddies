import type { Actor, BuddiesCore, Channel, Post, Run } from '@unleashd/buddies-core';
import type { ConversationConfig } from '@unleashd/shared';

/** The owner's mention-chip picks: the harness each mentioned Buddy answers on (ride the post's wake). */
export type MentionPicks = ReadonlyMap<string, ConversationConfig>;
export const NO_PICKS: MentionPicks = new Map();

/**
 * The in-process change bus. Every Buddy write (MCP tool, owner route, runner, responder) now
 * runs in this process, so a listener here sees all of them. B2: the old buses fired inside the
 * per-turn MCP helper process, where nothing listened, so a Buddy's MCP post never pushed
 * `channel_changed`. Guard: `buddies-v2.test.ts` "an MCP write fires
 * the change bus".
 */
export type BuddyEvent =
  | { kind: 'changed' }
  /** A CREATED post (never a replayed key): the channel's views refresh. */
  | { kind: 'posted'; post: Post; channel: Channel }
  /** A delivery started or ended: who is replying in this channel changed. */
  | { kind: 'responding'; channelId: string }
  /** A cancel was recorded (owner route or a Buddy's `runs` tool); the runner stops its turn. */
  | { kind: 'cancelled'; run: Run };

export type BuddyEvents = ReturnType<typeof createBuddyEvents>;

// Pattern: one-write-path (docs/patterns.md#one-write-path) — every Buddy write (tool, route,
// runner, responder) announces itself here; the WS feed and the runner's wake read from it.
export function createBuddyEvents() {
  const listeners = new Set<(event: BuddyEvent) => void>();
  return {
    emit(event: BuddyEvent): void {
      for (const listener of [...listeners]) listener(event);
    },
    on(listener: (event: BuddyEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Announce a written post with its channel (opened as `reader`), for every post writer. */
export async function announcePost<T extends Post>(
  deps: { core: BuddiesCore; events: BuddyEvents },
  reader: Actor,
  post: T
): Promise<{ post: T; channel: Channel }> {
  const channel = await deps.core.openChannel(reader, { kind: 'id', id: post.channelId });
  deps.events.emit({ kind: 'posted', post, channel });
  return { post, channel };
}
