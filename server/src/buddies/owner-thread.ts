import type { Actor, BuddiesCore, ChannelRef, Post, PostQuery } from '@unleashd/buddies-core';
import type { Origin } from '@unleashd/shared';
import { OWNER } from './core';
import { type BuddyEvents, announcePost } from './events';

// The owner thread: talking to the owner in ONE thread of a DM. Idempotent thread root, status
// lines posted into it, and the owner's fresh posts read back (channel feed + every thread).
// Shared by the expedition host and the expedition kernel; each passes its own `Thread`.

export type Place = { channel: ChannelRef; replyToId?: string };
/** A new post is announced (notifications, live feeds), or only refreshes the clients. */
export type Notice = 'announce' | 'quiet';
export type Said = { body: string; purpose: string; key: string };

/** Where a post answering `origin` goes: in its thread, or the owner's DM with `launcher`. The
 * expedition cards (old host's draft, the keyed `propose`) are posted here. */
const PLACE: { [K in Origin['t']]: (o: Extract<Origin, { t: K }>, launcher: Actor) => Place } = {
  thread: (o) => ({ channel: { kind: 'id', id: o.channelId }, replyToId: o.rootId }),
  direct: (_o, launcher) => ({ channel: { kind: 'direct', members: [OWNER, launcher] } }),
};
export const placeOf = (origin: Origin, launcher: Actor): Place =>
  PLACE[origin.t](origin as never, launcher);

/** Everything one owner thread closes over. `evidence` tags every post written into it. */
export interface Thread {
  author: Actor;
  channelId: string;
  evidence: string;
  /** The root post; its key makes `threadRoot` idempotent, so it is also how the root is found. */
  root: Said;
  statusPurpose: string;
}

export interface OwnerThreadDeps {
  core: BuddiesCore;
  events: BuddyEvents;
}

// Pattern: idempotency-keys (docs/patterns.md#idempotency-keys)
export function createOwnerThread({ core, events }: OwnerThreadDeps) {
  const NOTICE: Record<Notice, (post: Post) => Promise<void>> = {
    announce: async (post) => {
      await announcePost({ core, events }, OWNER, post);
    },
    quiet: async () => events.emit({ kind: 'changed' }),
  };

  async function inform(
    by: Actor,
    at: Place,
    p: Said,
    evidence: string,
    notice: Notice,
    beforeNotice?: (post: Post) => Promise<unknown>
  ): Promise<string> {
    const input = { ...p, kind: 'inform' as const, evidence: [evidence], mentions: [] };
    const write = await core.post(by, at.channel, {
      ...input,
      replyToId: at.replyToId,
      broadcast: false,
    });
    // A host can register reply ownership before a notification exposes this root. Replayed
    // posts register too, so recovery cannot announce a question with no reply consumer.
    if (beforeNotice) await beforeNotice(write.post);
    if (write.created) await NOTICE[notice](write.post);
    return write.post.id;
  }

  /** The thread's root post id. Quiet: review 2026-11-03, boot announced one root per
   * expedition, a notification each. */
  function threadRoot(t: Thread, beforeNotice?: (post: Post) => Promise<unknown>): Promise<string> {
    const at = { channel: { kind: 'id' as const, id: t.channelId } };
    return inform(t.author, at, t.root, t.evidence, 'quiet', beforeNotice);
  }

  /** Author-written, in the thread; the key makes a repeat a no-op. */
  async function postStatus(t: Thread, key: string, body: string): Promise<void> {
    const place = {
      channel: { kind: 'id' as const, id: t.channelId },
      replyToId: await threadRoot(t),
    };
    await inform(t.author, place, { body, purpose: t.statusPurpose, key }, t.evidence, 'announce');
  }

  async function pageAfter(query: PostQuery, after: string): Promise<Post[]> {
    const out: Post[] = [];
    let before: { ord: string } | undefined;
    for (;;) {
      const page = await core.listPosts(OWNER, query, before, 100);
      const newer = page.posts.filter((p) => p.ord > after);
      out.push(...newer);
      if (!page.next || newer.length < page.posts.length) return out;
      before = page.next;
    }
  }

  /** The channel feed and every thread's replies after `seen`, oldest first. Review 2026-11-03:
   * the channel feed leaves thread replies out, so a "pass" answered in the thread of the "Reply
   * pass or fail" line was never read. */
  async function freshPosts(channelId: string, seen: string): Promise<Post[]> {
    const roots = await pageAfter({ kind: 'channel', channelId }, '');
    const stats = await core.threadStats(
      OWNER,
      channelId,
      roots.map((p) => p.id)
    );
    const threads = stats.filter((t) => t.lastReplyOrd > seen);
    const replies = await Promise.all(
      threads.map((t) => pageAfter({ kind: 'thread', rootId: t.rootId }, seen))
    );
    const all = new Map([...roots, ...replies.flat()].map((p) => [p.id, p]));
    return [...all.values()].filter((p) => p.ord > seen).sort((a, b) => (a.ord < b.ord ? -1 : 1));
  }

  return { threadRoot, postStatus, inform, freshPosts, pageAfter };
}
export type OwnerThread = ReturnType<typeof createOwnerThread>;
