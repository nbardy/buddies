import assert from 'node:assert/strict';
import { register } from 'node:module';
import { test } from 'node:test';
import type { ExpeditionView, ExpeditionProposal as Proposal } from '@unleashd/shared';
import { Provider, createStore } from 'jotai';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { rowsAtom } from '../src/atoms/conversations';
import { expeditionCardOf } from '../src/components/buddies/channel-data';
import type { Post } from '../src/components/buddies/types';
import { syntheticConversation } from './fixtures/synthetic-conversations';

register(
  `data:text/javascript,${encodeURIComponent("export async function load(url, context, next) { return url.endsWith('.css') ? {format:'module',source:'',shortCircuit:true} : next(url, context); }")}`,
  import.meta.url
);
const { ProposalCard } = await import('../src/components/buddies/ExpeditionProposal');
const { ExpeditionContent } = await import('../src/components/buddies/ExpeditionView');

// Bugs caught: linking deleted conversations bounces to Chats; old cards crash the transcript;
// the replacement loses owner questions or hides actual spend and a failed step's reason.
const view: ExpeditionView = {
  id: 'run',
  workspaceId: 'ws',
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
const refresh = async () => {};
function renderRun(live: boolean, status: ExpeditionView['status']) {
  const store = createStore();
  store.set(rowsAtom, new Map(live ? [['chat', syntheticConversation(1, { id: 'chat' })]] : []));
  return renderToStaticMarkup(
    <Provider store={store}>
      <MemoryRouter>
        <ExpeditionContent view={{ ...view, status }} refresh={refresh} />
      </MemoryRouter>
    </Provider>
  );
}
test('run view retains evidence and only links available conversations', () => {
  const live = renderRun(true, 'running');
  assert.match(live, /href="\/chat\/chat"/);
  for (const text of ['Test failed', '$0.1200', '$3.00', 'abc123', 'Which result?', 'v1, v2'])
    assert.ok(live.includes(text));
  const gone = renderRun(false, 'met');
  assert.doesNotMatch(gone, /href="\/chat\/chat"/);
  assert.match(gone, /Expedition · met/);
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
