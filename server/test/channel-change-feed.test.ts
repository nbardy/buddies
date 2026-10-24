import assert from 'node:assert/strict';
import test from 'node:test';
import { createChannelChangeFeed } from '../src/buddies/channel-change-feed';

// Fix-guard (threads request storm, 2026-10-23): `channel_changed` went out un-debounced, one frame
// per post, read mark and "replying" change, and each frame refetched every mounted thread. K
// unread Threads cards each POSTed /read, so K frames meant K waves of 30+ thread GETs.
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('a burst on one channel is ONE frame naming every touched root', async () => {
  const sent: unknown[] = [];
  const push = createChannelChangeFeed((m) => sent.push(m), 20);
  for (const root of ['a', 'b', 'c', 'a']) push('ch1', [root]);
  push('ch1', []); // a read mark: touches no thread
  push('ch2', []);
  await wait(60);
  assert.deepEqual(sent, [
    { type: 'channel_changed', channelId: 'ch1', threads: ['a', 'b', 'c'] },
    { type: 'channel_changed', channelId: 'ch2', threads: [] },
  ]);
});

test("'all' absorbs the burst's named roots, and a later burst starts fresh", async () => {
  const sent: Array<{ threads: unknown }> = [];
  const push = createChannelChangeFeed((m) => sent.push(m as never), 20);
  push('ch', ['a']);
  push('ch', 'all');
  await wait(60);
  push('ch', ['z']);
  await wait(60);
  assert.deepEqual(
    sent.map((m) => m.threads),
    ['all', ['z']]
  );
});
