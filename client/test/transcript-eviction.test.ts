import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message, ServerMessage } from '@unleashd/shared';
import { handleMessage, setTranscriptViewed } from '../src/atoms/actions';
import { groupsFamily, transcriptFamily } from '../src/atoms/conversations';
import { jotaiStore } from '../src/atoms/store';
import { setLoaded, setRows } from './fixtures/client-store';
import { syntheticConversation, syntheticId } from './fixtures/synthetic-conversations';

/**
 * Regression (2026-10-08 audit: a threads tab reached ~17GB): every conversation a tab ever
 * opened kept its full transcript until the socket reconnected. Writing more than the limit must
 * send the least recently written ones back to `absent` (the open view reloads on demand), and
 * must never evict the one just written.
 */

const at = new Date('2026-10-08T00:00:00.000Z');
const said = (text: string): Message => ({
  role: 'user',
  body: { t: 'text', text },
  timestamp: at,
});
const message = (conversationId: string, text: string): ServerMessage =>
  ({ type: 'message', conversationId, role: 'user', body: { t: 'text', text } }) as ServerMessage;

test('writing past the loaded-transcript limit evicts the oldest, keeps the newest', () => {
  const ids = Array.from({ length: 30 }, (_, index) => syntheticId(800 + index));
  setRows(ids.map((id, index) => syntheticConversation(800 + index, { id, messageCount: 1 })));
  for (const id of ids) {
    setLoaded(id, [said('first')]);
    handleMessage(message(id, 'second'));
  }
  const tag = (id: string) => jotaiStore.get(transcriptFamily(id)).tag;
  assert.equal(tag(ids[0] as string), 'absent', 'oldest evicted');
  assert.equal(tag(ids[5] as string), 'absent', 'oldest evicted');
  assert.equal(tag(ids[29] as string), 'loaded', 'newest kept');
  assert.equal(tag(ids[10] as string), 'loaded', 'within the limit kept');
  // An evicted conversation's derived groups are not left holding the old messages.
  assert.deepEqual(jotaiStore.get(groupsFamily(ids[0] as string)), []);
});

// An idle open chat is the OLDEST write, so recency alone would blank it under a flood of writes
// to other chats; the mounted view pins it.
test('a chat a mounted view is showing survives a flood of writes to other chats', () => {
  const ids = Array.from({ length: 40 }, (_, index) => syntheticId(900 + index));
  setRows(ids.map((id, index) => syntheticConversation(900 + index, { id, messageCount: 1 })));
  const open = ids[0] as string;
  setLoaded(open, [said('first')]);
  handleMessage(message(open, 'second'));
  setTranscriptViewed(open, true);
  for (const id of ids.slice(1)) {
    setLoaded(id, [said('first')]);
    handleMessage(message(id, 'second'));
  }
  assert.equal(jotaiStore.get(transcriptFamily(open)).tag, 'loaded');
  setTranscriptViewed(open, false);
});
