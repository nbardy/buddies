import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROTOCOL_MISMATCH_CLOSE_CODE,
  PROTOCOL_VERSION,
  type ServerMessage,
  classifyServerFrame,
  classifySocketClose,
  encodeRows,
} from '@unleashd/shared';
import { Provider } from 'jotai';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { handleMessage, noteClientOutdated, noteProtocolMismatch } from '../src/atoms/actions';
import { connectionAtom, rowsAtom } from '../src/atoms/conversations';
import { jotaiStore } from '../src/atoms/store';
import { UpdateBanner } from '../src/components/UpdateBanner';
import { syntheticConversation } from './fixtures/synthetic-conversations';

/**
 * Dev reloads run two protocol versions side by side: Vite serves this client
 * at once while the backend defers its restart until turns finish. On
 * 2026-09-24 a required field made every `init` from the older backend fail
 * validation and the list went empty (fixed in e54fe26). An old `init` is
 * recognised as skew: the rows the client holds stay, and the socket
 * reconnects until a current `hello` arrives. A v3
 * backend is rejected at the v4 socket upgrade, then reconnects after reload.
 */

const V2_INIT = {
  type: 'init',
  conversations: [{ id: 'from-old-backend', messages: [] }],
  defaultCwd: '/',
  protocol: { version: 2, capabilities: ['conversation_config'] },
};

test('a v2 init is a version skew that leaves the rows the client holds', () => {
  const held = syntheticConversation(1, { id: 'held' });
  jotaiStore.set(rowsAtom, new Map([[held.id, held]]));

  const frame = classifyServerFrame(V2_INIT);
  assert.deepEqual(frame, { t: 'skew', serverVersion: 2 });
  if (frame.t === 'skew') noteProtocolMismatch(frame.serverVersion);

  assert.deepEqual([...jotaiStore.get(rowsAtom).keys()], ['held']);
  assert.deepEqual(jotaiStore.get(connectionAtom).server, { tag: 'skew', serverVersion: 2 });
});

test('a current hello parses, replaces the rows and clears the skew state', () => {
  // `hello` resets per-device state that lives in localStorage.
  const stored = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    },
  });
  const frame = classifyServerFrame({
    type: 'hello',
    protocol: { version: PROTOCOL_VERSION },
    defaultCwd: '/',
    loading: false,
    archivedBuddyIds: [],
    ...encodeRows([syntheticConversation(2, { id: 'fresh' })]),
  });
  assert.equal(frame.t, 'message');
  if (frame.t === 'message') handleMessage(frame.message as ServerMessage);
  assert.deepEqual([...jotaiStore.get(rowsAtom).keys()], ['fresh']);
  assert.equal(jotaiStore.get(connectionAtom).server.tag, 'v3');
});

// T14b renamed channel_changed's `listId` to `channelId`. A backend that has not
// reloaded yet still sends `listId`; that frame must be dropped as invalid, not
// applied, or the client would invalidate `/api/buddies/channels/undefined` and
// miss the real channel silently.
test('a pre-rename channel_changed frame is invalid; the renamed one names its channel', () => {
  assert.equal(classifyServerFrame({ type: 'channel_changed', listId: 'ch_a' }).t, 'invalid');
  const frame = classifyServerFrame({ type: 'channel_changed', channelId: 'ch_a' });
  assert.deepEqual(frame, {
    t: 'message',
    // `threads` defaults to 'all': a frame from a backend that predates it still refreshes every
    // thread, as before.
    message: { type: 'channel_changed', channelId: 'ch_a', threads: 'all' },
  });
});

// Regression (lean-scope final review, "Open"): a tab left open across a
// protocol swap kept its list and silently stopped updating. A newer server
// closes the socket with PROTOCOL_MISMATCH_CLOSE_CODE; the tab must show the
// reload banner, while an OLDER server (dev reload in flight) stays a quiet
// skew that reconnecting heals.
test('a newer server closing with the mismatch code shows the reload banner', () => {
  const banner = () =>
    renderToStaticMarkup(
      createElement(Provider, { store: jotaiStore }, createElement(UpdateBanner))
    );
  const held = syntheticConversation(3, { id: 'held' });
  jotaiStore.set(rowsAtom, new Map([[held.id, held]]));

  const older = classifySocketClose(
    PROTOCOL_MISMATCH_CLOSE_CODE,
    `protocol ${PROTOCOL_VERSION - 1}`
  );
  assert.deepEqual(older, { t: 'skew', serverVersion: PROTOCOL_VERSION - 1 });
  noteProtocolMismatch(PROTOCOL_VERSION - 1);
  assert.equal(banner(), '');
  assert.deepEqual([...jotaiStore.get(rowsAtom).keys()], ['held']);

  const newer = classifySocketClose(
    PROTOCOL_MISMATCH_CLOSE_CODE,
    `protocol ${PROTOCOL_VERSION + 1}`
  );
  assert.deepEqual(newer, { t: 'outdated', serverVersion: PROTOCOL_VERSION + 1 });
  noteClientOutdated(PROTOCOL_VERSION + 1);
  assert.match(banner(), /The app was updated — reload/);
  assert.match(banner(), /Reload<\/button>/);
  assert.deepEqual([...jotaiStore.get(rowsAtom).keys()], ['held']);
  assert.deepEqual(classifySocketClose(1006, ''), { t: 'dropped' });
});
