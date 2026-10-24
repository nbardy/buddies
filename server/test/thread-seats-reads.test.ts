import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultConversationConfig } from '@unleashd/shared';
import { scanGenerations } from '../src/buddies/buddy-conversation-slots';
import { createChannels, threadConversationId } from '../src/buddies/channels';

// Fix-guard (threads request storm, 2026-10-23): GET /posts/:id/thread scanned every page of the
// thread and each Buddy's generations one serial records await at a time: 0.09-1.7 s cold, and the
// worst stall grew 663 ms -> 6048 ms in five days. The thread route no longer computes seats (the
// composer asks GET /threads/seats on @mention; buddies-v2.test.ts "thread route carries no
// seats"). These tests fail on a slot read repeated within one seat request. The core here counts
// reads; the seat logic is real.
const config = createDefaultConversationConfig('codex');
const post = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  rootId: null,
  channelId: 'ch',
  body: '',
  purpose: 'reply',
  conversationId: null,
  author: { kind: 'owner' },
  ...over,
});

function fixture(replyPages: Array<{ posts: unknown[]; next?: { ord: string } }>) {
  const reads = { getPost: 0, listPosts: [] as unknown[] };
  const slotReads: string[] = [];
  const root = post('root', { body: '[@Lead](buddy:lead) go' });
  const core = {
    getPost: async (_who: unknown, id: string) => {
      reads.getPost += 1;
      if (id === 'bad') throw new Error('no such post');
      return root;
    },
    listPosts: async (_who: unknown, _query: unknown, before: { ord: string } | undefined) => {
      reads.listPosts.push(before?.ord ?? null);
      return replyPages[before === undefined ? 0 : Number(before.ord)];
    },
  };
  const live = new Set(['lead', 'designer'].map((b) => threadConversationId('root', b, 0)));
  const channels = createChannels({
    core: core as never,
    events: { on: () => undefined } as never,
    backgroundWork: {} as never,
    installedAgent: () => ({ kind: 'none' }) as never,
    channelChanged: () => undefined,
    liveHooks: () => null,
    gate: async () => ({ kind: 'pass' }) as never,
    conversations: {
      slot: async (id: string) => {
        slotReads.push(id);
        return live.has(id) ? { kind: 'live', config } : { kind: 'absent' };
      },
    } as never,
  });
  return { channels, reads, slotReads, root };
}

test('seats read the whole thread once: every page, and each slot once per request', async () => {
  const reply = post('r1', {
    author: { kind: 'buddy', id: 'designer' },
    conversationId: threadConversationId('root', 'designer', 0),
  });
  const { channels, reads, slotReads } = fixture([
    { posts: [reply as never], next: { ord: '1' } },
    { posts: [post('old') as never] },
  ]);
  const answers = await channels.threadSeatsBatch(['root']);
  const root = answers.root;
  assert.equal(root.kind, 'seats');
  assert.deepEqual(root.kind === 'seats' ? root.seats.map((s) => s.buddyId).sort() : [], [
    'designer',
    'lead',
  ]);
  assert.deepEqual(reads.listPosts, [null, '1']);
  assert.equal(new Set(slotReads).size, slotReads.length, 'a slot is read once per request');
});

test('one unreadable root fails alone, not the batch', async () => {
  const { channels } = fixture([{ posts: [] }]);
  const answers = await channels.threadSeatsBatch(['root', 'bad']);
  assert.equal(answers.root.kind, 'seats');
  assert.deepEqual(answers.bad, { kind: 'failed', message: 'no such post' });
});

test('scanGenerations still ends at the first absent generation and reports live ones in order', async () => {
  const state = ['live', 'deleted', 'live', 'absent', 'live'];
  const found = await scanGenerations(
    { slot: async (id) => ({ kind: state[Number(id)] as 'live', config }) },
    (g) => String(g)
  );
  assert.deepEqual(found.live, ['0', '2']);
  assert.equal(found.current?.conversationId, '2');
  assert.equal(found.next(), '3');
});
