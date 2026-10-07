import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import type { Message, ServerMessage } from '@unleashd/shared';
import { handleMessage } from '../src/atoms/actions';
import { streamStore } from '../src/atoms/conversations';
import { jotaiStore } from '../src/atoms/store';
import { setLoaded } from './fixtures/client-store';
import { syntheticId } from './fixtures/synthetic-conversations';

/**
 * Regression (2026-10-08 audit: a threads tab reached ~17GB): the chunk flush rode
 * requestAnimationFrame alone. Browsers never fire it in a hidden tab, so a background tab buffered
 * every streamed chunk of every conversation without bound. The timer fallback must flush with no
 * frame ever arriving.
 */

const id = syntheticId(901);
const at = new Date('2026-10-08T00:00:00.000Z');
const said = (role: Message['role'], text: string): Message => ({
  role,
  body: { t: 'text', text },
  timestamp: at,
});

test('streamed chunks reach the stream atom even when no animation frame ever fires', () => {
  const realFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 0; // a hidden tab: the callback never runs
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    setLoaded(id, [said('user', 'hi'), said('assistant', 'Hello')]);
    handleMessage({ type: 'chunk', conversationId: id, text: ' world' } as ServerMessage);
    assert.equal(jotaiStore.get(streamStore.byKey(id)), '', 'still buffered before the timer');
    mock.timers.tick(100);
    assert.equal(jotaiStore.get(streamStore.byKey(id)), ' world');
  } finally {
    mock.timers.reset();
    globalThis.requestAnimationFrame = realFrame;
  }
});
