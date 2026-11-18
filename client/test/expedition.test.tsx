import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
import type { ExpeditionView, ExpeditionProposal as Proposal } from '@unleashd/shared';
import { Provider, createStore } from 'jotai';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { rowsAtom, transcriptStore } from '../src/atoms/conversations';
import { loadResource } from '../src/atoms/resources';
import { jotaiStore } from '../src/atoms/store';
import { expeditionCardOf } from '../src/components/buddies/channel-data';
import type { Post } from '../src/components/buddies/types';
import {
  syntheticConversation,
  syntheticDetail,
  syntheticMessages,
} from './fixtures/synthetic-conversations';

register(
  `data:text/javascript,${encodeURIComponent("export async function load(url, context, next) { return url.endsWith('.css') ? {format:'module',source:'',shortCircuit:true} : next(url, context); }")}`,
  import.meta.url
);
const { ProposalCard } = await import('../src/components/buddies/ExpeditionProposal');
const { ExpeditionContent } = await import('../src/components/buddies/ExpeditionView');
const { WorkspaceSlack } = await import('../src/components/buddies/ChannelBrowser');
const { ChannelsMobile } = await import('../src/mobile/channels/ChannelsMobile');

// Bugs caught: linking deleted conversations bounces to Chats; old cards crash the transcript;
// the replacement loses owner questions or hides actual spend and a failed step's reason.
const view: ExpeditionView = {
  id: 'run',
  workspaceId: 'ws',
  managerId: 'manager',
  status: 'running',
  goal: 'Build the result',
  budget: { usd: 3, hours: 1 },
  spend: 0.12,
  reserved: 0.3,
  versions: [1, 2],
  steps: [
    {
      key: 'edit',
      hash: 'hash',
      who: 'codex:model:low',
      state: 'failed',
      cost: 0.12,
      why: 'Test failed',
      commit: 'abc123',
      conversationId: 'chat',
    },
  ],
  questions: [{ key: 'ask', question: 'Which result?', kind: 'text' }],
};
function renderAttempts(live: boolean) {
  const store = createStore();
  store.set(rowsAtom, new Map(live ? [['chat', syntheticConversation(1, { id: 'chat' })]] : []));
  return renderToStaticMarkup(
    <Provider store={store}>
      <MemoryRouter>
        <ExpeditionContent view={view} />
      </MemoryRouter>
    </Provider>
  );
}
test('attempts retain evidence and only link available conversations', () => {
  const live = renderAttempts(true);
  assert.match(
    live,
    /href="\/buddies\/workspaces\/ws\/channels\?expedition=run&amp;conversation=chat"/
  );
  for (const text of ['Test failed', '$0.1200', 'abc123']) assert.ok(live.includes(text));
  const gone = renderAttempts(false);
  assert.doesNotMatch(gone, /Open conversation/);
  assert.match(gone, /Conversation chat/);
});

test('both Channels shells open expedition chat, owner questions, details and step transcripts', async () => {
  await loadResource({ key: '/api/buddies/expeditions/run', load: async () => view });
  const store = jotaiStore;
  store.set(
    rowsAtom,
    new Map([['chat', syntheticConversation(1, { id: 'chat', kind: { t: 'chat' } })]])
  );
  store.set(transcriptStore.patch, {
    set: [
      [
        'chat',
        {
          tag: 'loaded',
          epoch: 0,
          messages: syntheticMessages(1),
          detail: syntheticDetail('chat'),
        },
      ],
    ],
    remove: [],
  });
  const route = '/buddies/workspaces/ws/channels';
  for (const Shell of [WorkspaceSlack, ChannelsMobile]) {
    const render = (search = '') =>
      renderToStaticMarkup(
        <Provider store={store}>
          <MemoryRouter initialEntries={[`${route}?expedition=run${search}`]}>
            <Routes>
              <Route path="/buddies/workspaces/:workspaceId/channels" element={<Shell />} />
            </Routes>
          </MemoryRouter>
        </Provider>
      );
    const chat = render();
    assert.match(chat, /Chat with the manager/);
    assert.match(chat, /placeholder="Message the manager"/);
    assert.match(chat, /Which result\?/);
    assert.match(chat, /Send answer/);
    assert.match(render('&tab=details'), /\$0\.1200 spent/);
    assert.match(render('&tab=goal'), /Build the result<\/p>/);
    const html = render('&conversation=chat');
    const back = html.match(/<a\b[^>]*aria-label="Back to expedition"[^>]*>/)?.[0];
    assert.ok(back?.includes(`href="${route}?expedition=run&amp;tab=attempts"`));
    assert.match(html, /Question 1/);
    assert.match(html, /Answer 1/);
    assert.doesNotMatch(html, /<textarea\b/);
    assert.match(render('&conversation=other'), /Conversation unavailable/);
  }
});
test('proposal states cost and owner launch; old evidence stays plain text', () => {
  const proposal: Proposal = {
    file: '/tmp/plan.ts',
    hash: 'hash',
    workspaceId: 'ws',
    preview: {
      goal: view.goal,
      leader: 'buddy:manager',
      repo: '/tmp/repo',
      start: { commit: 'abc1234', line: 'starts from origin/main at abc1234, fetch succeeded' },
      budget: view.budget,
      costUsd: 0.25,
      firstWave: [{ key: 'edit', who: 'codex:model:low', usd: 0.25 }],
      defaults: ['one per harness'],
    },
  };
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <ProposalCard proposal={proposal} />
    </MemoryRouter>
  );
  assert.match(html, /Launch expedition/);
  assert.match(html, /\$0.25/);
  assert.match(html, /starts from origin\/main at abc1234, fetch succeeded/);
  const old: Post = {
    id: 'p',
    channelId: 'dm',
    author: { kind: 'owner' },
    body: 'Old proposal',
    evidence: ['keyed-proposal:{"old":true}'],
    purpose: 'expedition',
    request: { state: 'none' },
    createdAt: '2026-11-12',
    ord: '1',
    broadcast: false,
    editRevision: 1,
    reactions: [],
  };
  assert.deepEqual(expeditionCardOf(old), { t: 'none' });
});
