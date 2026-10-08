/**
 * Every "open this conversation" affordance in the buddy tree must be a real
 * anchor pointing at the conversation's own id, and must NOT be an anchor when
 * the client no longer holds that conversation.
 *
 * Both halves are regression guards, not schema mirrors:
 *
 *   - The Automations tab shipped these as `<button onClick={navigate(...)}>`.
 *     Buttons have no href: no middle-click, no open-in-new-tab, no status-bar
 *     target, and nothing in history. Reported 2026-08-21, fixed in 42dc28a.
 *
 *   - A run keeps its `conversationId` forever (schedule runs, task runs), but
 *     the conversation can be deleted. Linking one of those lands on Chat.tsx's
 *     `navigate('/')` bounce, which reads to the user as "Open took me to the
 *     conversation list." The run list is where both shells render them now.
 *
 * Renders the real components through a real MemoryRouter — no mocks, no
 * assertions on TSX source text.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConversationRow } from '@unleashd/shared';
import { Provider, createStore } from 'jotai';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { rowsAtom } from '../src/atoms/conversations';
import { BuddyConversationList } from '../src/components/buddies/BuddyConversationList';
import { BuddyRunList } from '../src/components/buddies/BuddyRunList';
import { BuddySectionNav } from '../src/components/buddies/BuddySectionNav';
import type { Run } from '../src/components/buddies/types';
import { syntheticConversation } from './fixtures/synthetic-conversations';

const LIVE = 'live-conversation-id';
const DEAD = 'dead-conversation-id';

const buddyConversation = (id: string, overrides: Partial<ConversationRow> = {}) =>
  syntheticConversation(1, {
    id,
    kind: { t: 'buddy', buddyId: 'lead', workspaceId: 'ws-1', visibility: 'foreground' },
    createdAt: Date.parse('2026-09-15'),
    activityAt: Date.parse('2026-09-15'),
    ...overrides,
  });

/** A store holding exactly the LIVE conversation; DEAD is deliberately absent. */
function storeWithLive() {
  const store = createStore();
  store.set(rowsAtom, new Map([[LIVE, buddyConversation(LIVE)]]));
  return store;
}

function scheduleRun(id: string, conversationId: string): Run {
  return {
    id,
    inputKey: `deliver:${id}:lead`,
    attempt: 1,
    input: { kind: 'deliver', postId: `post-${id}` },
    admission: 'capped',
    buddyId: 'lead',
    workspaceId: 'ws-1',
    conversationId,
    status: 'complete',
    readyAt: '2026-09-15T22:00:00Z',
    createdAt: '2026-09-15T22:00:00Z',
  };
}

const render = (element: ReactElement, store = storeWithLive()): string =>
  renderToStaticMarkup(
    <Provider store={store}>
      <MemoryRouter>{element}</MemoryRouter>
    </Provider>
  );

/** Hrefs of anchors pointing at a chat route, in document order. */
function chatHrefs(html: string): string[] {
  return [...html.matchAll(/<a[^>]*href="(\/chat\/[^"]*)"/g)].map((match) => match[1]);
}

test('run lists link live run conversations and never link dead ones', () => {
  const html = render(
    <BuddyRunList
      runs={[scheduleRun('run-live', LIVE), scheduleRun('run-dead', DEAD)]}
      refresh={async () => {}}
      empty="none"
    />
  );
  assert.deepEqual(chatHrefs(html), [`/chat/${LIVE}`]);
  assert.ok(!html.includes(DEAD), 'a dead conversation id must not reach the markup as a target');
});

test('Buddy conversations show real previews, sort running first, and react to completion', () => {
  const store = createStore();
  const running = buddyConversation(LIVE, { label: 'Review the launch plan', run: 'running' });
  const recent = buddyConversation('recent', {
    label: 'The rollout is ready',
    createdAt: Date.parse('2026-09-16'),
    activityAt: Date.parse('2026-09-16'),
  });
  const background = buddyConversation('background', {
    kind: { t: 'buddy', buddyId: 'lead', workspaceId: 'ws-1', visibility: 'background' },
  });
  const otherBuddy = buddyConversation('other', {
    kind: { t: 'buddy', buddyId: 'engineer', workspaceId: 'ws-1', visibility: 'foreground' },
  });
  store.set(
    rowsAtom,
    new Map([
      [LIVE, running],
      ['recent', recent],
      ['background', background],
      ['other', otherBuddy],
    ])
  );
  const renderList = () => render(<BuddyConversationList buddyId="lead" />, store);
  const html = renderList();
  // Background work and other Buddies' chats have their own surfaces.
  assert.deepEqual(chatHrefs(html), [`/chat/${LIVE}`, '/chat/recent']);
  assert.ok(html.includes('Review the launch plan'));
  assert.ok(html.includes('The rollout is ready'));
  assert.ok(html.includes('Running'));
  store.set(
    rowsAtom,
    new Map([
      [LIVE, { ...running, run: 'idle' }],
      ['recent', recent],
    ])
  );
  const completed = renderList();
  assert.deepEqual(chatHrefs(completed), ['/chat/recent', `/chat/${LIVE}`]);
  assert.ok(!completed.includes('Running'));
});

test('Buddy navigation keeps secondary sections reachable as real routes', () => {
  const html = render(<BuddySectionNav buddyId="buddy-1" activeTab="memory" layout="wide" />);
  assert.ok(html.includes('href="/buddies/buddy-1/conversations"'));
  const memoryLink = html.match(/<a[^>]*href="\/buddies\/buddy-1\/memory"[^>]*>/)?.[0];
  assert.ok(memoryLink?.includes('aria-current="page"'));
  assert.ok(html.includes('href="/buddies/buddy-1/settings"'));
  assert.ok(html.includes('href="/buddies/buddy-1/schedules"'));
});
