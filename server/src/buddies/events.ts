import type { Actor, BuddiesCore, Channel, Post, Run, Wake } from '@unleashd/buddies-core';
import type { ConversationConfig } from '@unleashd/shared';

/** The owner's mention-chip picks: the harness each mentioned Buddy answers on. */
export type MentionPicks = ReadonlyMap<string, ConversationConfig>;
export const NO_PICKS: MentionPicks = new Map();
/**
 * The host's half of a post's wakes (channels.ts `planWakes`): must-answer mentions and DM
 * wakes, planned before the write so the crate enqueues them in the post's own transaction.
 */
export type PlanWakes = (
  channel: Channel,
  author: Actor,
  draft: { body: string; replyToId?: string | null; kind: 'inform' | 'request' },
  picks: MentionPicks
) => Promise<Wake[]>;

/**
 * The in-process change bus. Every Buddy write (MCP tool, owner route, runner, responder) now
 * runs in this process, so a listener here sees all of them. B2: the old buses fired inside the
 * per-turn MCP helper process, where nothing listened, so a Buddy's MCP post never pushed
 * `channel_changed` or woke the follow-up gate. Guard: `buddies-v2.test.ts` "an MCP write fires
 * the change bus".
 */
export type BuddyEvent =
  | { kind: 'changed' }
  /** A CREATED post (never a replayed key): channels.ts starts its mentions and follow-ups. */
  | { kind: 'posted'; post: Post; channel: Channel; picks: MentionPicks }
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
  post: T,
  picks: MentionPicks
): Promise<{ post: T; channel: Channel }> {
  const channel = await deps.core.openChannel(reader, { kind: 'id', id: post.channelId });
  deps.events.emit({ kind: 'posted', post, channel, picks });
  return { post, channel };
}
