import assert from 'node:assert/strict';
import test from 'node:test';
import { ownerUnreadTotal } from '../src/components/buddies/channel-data';

test('navigation badges read counts for one workspace or the whole team', () => {
  const rows = [
    { workspaceId: 'a', requests: 2, unreadChannels: 3, unreadThreads: 4 },
    { workspaceId: 'b', requests: 5, unreadChannels: 6, unreadThreads: 7 },
  ];
  assert.deepEqual(ownerUnreadTotal(rows, null), {
    requests: 7,
    unreadChannels: 9,
    unreadThreads: 11,
  });
  assert.deepEqual(ownerUnreadTotal(rows, 'a'), {
    requests: 2,
    unreadChannels: 3,
    unreadThreads: 4,
  });
  assert.deepEqual(ownerUnreadTotal(null, null), {
    requests: 0,
    unreadChannels: 0,
    unreadThreads: 0,
  });
});
