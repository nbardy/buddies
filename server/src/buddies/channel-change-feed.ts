import type { ChannelThreads, ServerMessageInput } from '@unleashd/shared';
import { labelled } from '../observability/event-loop-stall';

// Pattern: debounced-change-feed (docs/patterns.md#debounced-change-feed)
// One debounced `channel_changed` per channel per burst, naming the thread roots that burst
// touched. Fix-guard (2026-10-23 threads request storm): every post, read mark and "replying"
// change pushed its own un-debounced frame, and each frame refetched every mounted thread in every
// channel, so K unread cards were K waves of 30+ thread GETs. Folding a burst into one frame
// (250 ms, like `buddies_changed`) and naming its roots bounds both factors.
// Guard: server/test/channel-change-feed.test.ts.
type Pending = { timer: NodeJS.Timeout; threads: ChannelThreads };

/** 'all' absorbs everything; lists union; the empty list is the identity. */
export function mergeThreads(a: ChannelThreads, b: ChannelThreads): ChannelThreads {
  if (a === 'all' || b === 'all') return 'all';
  return [...new Set([...a, ...b])];
}

export function createChannelChangeFeed(
  send: (message: ServerMessageInput) => void,
  delayMs = 250
): (channelId: string, threads: ChannelThreads) => void {
  const pending = new Map<string, Pending>();
  return (channelId, threads) => {
    const held = pending.get(channelId);
    if (held) {
      held.threads = mergeThreads(held.threads, threads);
      return;
    }
    const timer = setTimeout(
      labelled('timer channel-change-feed', () => {
        const fired = pending.get(channelId);
        pending.delete(channelId);
        if (fired === undefined) return;
        send({
          type: 'channel_changed',
          channelId,
          threads: fired.threads === 'all' ? 'all' : [...fired.threads],
        });
      }),
      delayMs
    );
    timer.unref();
    pending.set(channelId, { timer, threads });
  };
}
