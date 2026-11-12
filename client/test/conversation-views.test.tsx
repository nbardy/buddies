import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import type { QueuedMessage, SubAgent } from '@unleashd/shared';
import { Provider, createStore } from 'jotai';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { rowsAtom } from '../src/atoms/conversations';
import { syntheticConversation } from './fixtures/synthetic-conversations';

register(
  `data:text/javascript,${encodeURIComponent(`
    export async function load(url, context, nextLoad) {
      if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
      return nextLoad(url, context);
    }
  `)}`,
  import.meta.url
);
const { QueuedMessages } = await import('../src/views/conversation/QueuedMessages');
const { ResumeSource } = await import('../src/views/conversation/ResumeSource');
const { SubAgentPanel } = await import('../src/views/conversation/SubAgentPanel');

// T20 slice A: Chat.tsx (desktop) and ConversationView (mobile) render these
// views, each in its own presentation. The behaviour below is what both trees
// must agree on; before the merge the mobile copies drifted from it.

const render = (element: ReactElement, store = createStore()): string =>
  renderToStaticMarkup(
    <Provider store={store}>
      <MemoryRouter>{element}</MemoryRouter>
    </Provider>
  );

test('both queue presentations list waiting messages, never the running input', () => {
  const current: QueuedMessage = {
    id: 'current',
    content: 'Already running',
    status: 'sending',
    queuedAt: new Date(),
  };
  const pending: QueuedMessage = {
    id: 'pending',
    content: 'Follow up later',
    status: 'pending',
    queuedAt: new Date(),
  };
  for (const presentation of ['list', 'disclosure'] as const) {
    assert.equal(
      render(<QueuedMessages presentation={presentation} conversationId="c" queue={[current]} />),
      ''
    );
    const html = render(
      <QueuedMessages presentation={presentation} conversationId="c" queue={[current, pending]} />
    );
    assert.match(html, /Follow up later/);
    assert.match(html, /Send now/);
    assert.doesNotMatch(html, /Already running/);
  }
});

test('both sub-agent presentations show live agents plus only the last three finished', () => {
  const agent = (id: string, status: SubAgent['status']): SubAgent => ({
    id,
    description: `task ${id}`,
    status,
    toolUses: 2,
    tokens: 1500,
    startedAt: new Date(0),
  });
  const subAgents = [
    agent('old-1', 'completed'),
    agent('old-2', 'completed'),
    agent('mid', 'error'),
    agent('new-1', 'completed'),
    agent('new-2', 'completed'),
    agent('live', 'running'),
  ];
  for (const html of [
    render(<SubAgentPanel presentation="tree" subAgents={subAgents} />),
    render(<SubAgentPanel presentation="cards" subAgents={subAgents} />),
  ]) {
    assert.match(html, /task live/);
    assert.match(html, /task mid/);
    assert.match(html, /task new-2/);
    assert.match(html, /1\.5k tokens/);
    assert.doesNotMatch(html, /task old-/);
  }
});

// AGENTS.md: an "open this conversation" affordance links only when the client
// still holds the thread. The mobile card linked blindly until T20.
test('both fork-source presentations link only to a conversation the client holds', () => {
  const source = syntheticConversation(1, { id: 'source-thread-id' });
  const held = createStore();
  held.set(rowsAtom, new Map([[source.id, source]]));
  for (const presentation of ['icon', 'card'] as const) {
    const element = (
      <ResumeSource
        presentation={presentation}
        sourceConversationId={source.id}
        sourceConversation={source}
      />
    );
    assert.match(render(element, held), /href="\/chat\/source-thread-id"/);
    assert.doesNotMatch(render(element, createStore()), /href="\/chat\//);
  }
});
