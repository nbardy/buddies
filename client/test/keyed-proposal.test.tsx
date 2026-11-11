import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { keyed } from '@unleashd/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { finished, rowOf } from './keyed-fixtures';

register(
  `data:text/javascript,${encodeURIComponent(`
    export async function load(url, context, nextLoad) {
      if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
      return nextLoad(url, context);
    }
  `)}`,
  import.meta.url
);
const { ProposalCard } = await import('../src/components/buddies/ExpeditionProposal');
const { expeditionCardOf } = await import('../src/components/buddies/channel-data');
const { KEYED_URL, proposalUrl } = await import('../src/components/buddies/keyed-api');
const { loadResource } = await import('../src/atoms/resources');
const { jotaiStore } = await import('../src/atoms/store');
const { Provider } = await import('jotai');
const { MemoryRouter } = await import('react-router-dom');

// A proposal card as the chat renders it, from the wire values the server posts and serves: the
// post's `keyed-proposal:` evidence and `GET …/proposals/:digest`, both parsed with the real schemas.

const proposalOf = (n: number): keyed.KeyedProposal =>
  keyed.KeyedProposal.parse({
    folder: `/repo/exp-${n}`,
    workspaceId: 'ws-1',
    digest: `digest-${n}`,
    preview: {
      t: 'clean',
      goal: 'Find ten design partners\nthen write them up',
      leader: 'lead',
      repo: '/repo',
      budget: { usd: 50, hours: 4 },
      firstWave: [
        { key: 'scope', kind: 'agent', reservedUsd: 1.5, who: 'claude · sonnet · low' },
        { key: 'ask/which-color', kind: 'ask', reservedUsd: 0, who: 'you' },
      ],
      costUsd: 1.5,
      access: [
        {
          label: 'scope',
          turn: 'call',
          harness: {
            t: 'known',
            provider: 'codex',
            grants: {
              reads: { t: 'advisory', reason: 'the sandbox does not confine reads' },
              writes: { t: 'enforced' },
              shell: { t: 'enforced' },
              web: { t: 'enforced' },
              agents: { t: 'enforced' },
              schedule: { t: 'enforced' },
              mcp: { t: 'enforced' },
              instructions: { t: 'enforced' },
            },
          },
        },
      ],
    },
  });
const statusOf = (
  mode: object,
  launched: object,
  folder: object = { t: 'unchanged' }
): keyed.KeyedProposalStatus => keyed.KeyedProposalStatus.parse({ mode, launched, folder });

const card = async (n: number, status: keyed.KeyedProposalStatus, listed = false) => {
  const proposal = proposalOf(n);
  await loadResource({ key: proposalUrl(proposal), load: async () => status });
  await loadResource({
    key: KEYED_URL,
    load: async () => (listed ? [rowOf({ ...finished, id: 'ex-launched' })] : []),
  });
  return renderToStaticMarkup(
    <Provider store={jotaiStore}>
      <MemoryRouter>
        <ProposalCard proposal={proposal} />
      </MemoryRouter>
    </Provider>
  );
};
const LIVE = { t: 'live' };
const NOT_LAUNCHED = { t: 'no' };

test('a clean proposal shows the goal, budget, first wave with who and cost, and a Launch to confirm', async () => {
  const html = await card(1, statusOf(LIVE, NOT_LAUNCHED));
  assert.match(html, /Find ten design partners/);
  assert.doesNotMatch(html, /then write them up/);
  assert.match(html, /Budget \$50\.00 \/ 4 h/);
  assert.match(html, /scope · claude · sonnet · low · \$1\.50/);
  assert.match(html, /ask\/which-color · you · \$0\.00/);
  assert.match(html, />Launch</);
  assert.doesNotMatch(html, /Confirm launch/, 'the second click is a later state');
});

test('a grant the harness only advises is called out beside the first wave', async () => {
  const html = await card(2, statusOf(LIVE, NOT_LAUNCHED));
  assert.match(html, /aria-label="Limits not enforced"/);
  assert.match(html, /scope \(codex\) reads: the sandbox does not confine reads/);
  assert.doesNotMatch(html, /writes: /);
});

test('a read-only host says why and offers no Launch', async () => {
  const html = await card(
    3,
    statusOf({ t: 'read-only', why: 'keyed expeditions are switched off' }, NOT_LAUNCHED)
  );
  assert.match(html, /Cannot launch: keyed expeditions are switched off/);
  assert.doesNotMatch(html, />Launch</);
});

// Guard: the owner launches what they looked at. A folder edited after the proposal is superseded
// here, and the server refuses its digest anyway (expeditions-v1-server.test.ts).
test('a folder changed after the proposal reads as superseded, with no Launch', async () => {
  const html = await card(
    4,
    statusOf(LIVE, NOT_LAUNCHED, { t: 'changed', why: 'its files changed after this was proposed' })
  );
  assert.match(html, /Superseded: its files changed after this was proposed/);
  assert.doesNotMatch(html, />Launch</);
});

test('a launched proposal links to its expedition when it is listed, and only names it when not', async () => {
  const launched = statusOf(LIVE, { t: 'yes', id: 'ex-launched' });
  const listed = await card(5, launched, true);
  assert.match(listed, /<a [^>]*href="[^"]*keyed=ex-launched"[^>]*>Open the expedition</);
  assert.doesNotMatch(listed, />Launch</);
  const unlisted = await card(6, launched, false);
  assert.match(unlisted, /Launched as ex-launched/);
  assert.doesNotMatch(unlisted, /<a /);
});

test('a backend without the route reads as unavailable', async () => {
  const proposal = proposalOf(7);
  await loadResource({
    key: proposalUrl(proposal),
    load: async () => Promise.reject(new Error('HTTP 404')),
  }).catch(() => undefined);
  const html = renderToStaticMarkup(
    <Provider store={jotaiStore}>
      <MemoryRouter>
        <ProposalCard proposal={proposal} />
      </MemoryRouter>
    </Provider>
  );
  assert.match(html, /not available on this backend/);
  assert.doesNotMatch(html, />Launch</);
});

// κ: the post is a card only with the purpose AND well-formed evidence; anything else stays text.
test('a chat post is a proposal card only when its evidence parses', () => {
  const post = (purpose: string, evidence: string[]) => ({ purpose, evidence }) as never;
  const ok = `${keyed.PROPOSAL_EVIDENCE}${JSON.stringify(proposalOf(8))}`;
  assert.equal(expeditionCardOf(post('expedition', [ok])).t, 'proposal');
  assert.equal(expeditionCardOf(post('reply', [ok])).t, 'none');
  assert.equal(
    expeditionCardOf(post('expedition', [`${keyed.PROPOSAL_EVIDENCE}{not json`])).t,
    'none'
  );
  assert.equal(
    expeditionCardOf(post('expedition', [`${keyed.PROPOSAL_EVIDENCE}{"folder":"/x"}`])).t,
    'none'
  );
  assert.deepEqual(expeditionCardOf(post('expedition', ['expedition:old-1'])), {
    t: 'card',
    id: 'old-1',
  });
});
