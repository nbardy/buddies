import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import type { ExpeditionView } from '@unleashd/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { CODEX_INSTALLED } from './fixtures/buddy-roster';
import { postFixture } from './fixtures/channel-posts';

register(
  `data:text/javascript,${encodeURIComponent(`
    export async function load(url, context, nextLoad) {
      if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
      return nextLoad(url, context);
    }
  `)}`,
  import.meta.url
);
const { ChannelPostContent } = await import('../src/components/buddies/ChannelPostContent');
const { ExpeditionPage } = await import('../src/components/buddies/ExpeditionPage');
const { workspaceDirectory } = await import('../src/components/buddies/channel-data');
const { expeditionUrl } = await import('../src/components/buddies/expedition-view');
const { loadResource } = await import('../src/atoms/resources');
const { jotaiStore } = await import('../src/atoms/store');
const { Provider } = await import('jotai');
const { MemoryRouter, Route, Routes } = await import('react-router-dom');

const directory = workspaceDirectory([], 'ws-1', [], CODEX_INSTALLED);
const inChat = (post: ReturnType<typeof postFixture>) =>
  renderToStaticMarkup(
    <Provider store={jotaiStore}>
      <MemoryRouter>
        <ChannelPostContent post={post} directory={directory} />
      </MemoryRouter>
    </Provider>
  );

// The badge is the only way back to a launched expedition from the chat it started in (server
// expeditions/host.ts posts it with this purpose and evidence). Losing the branch in the one shared
// post renderer would silently strand every launch in both shells.
test('a launch badge post renders a link to its expedition page; a plain post does not', () => {
  const badge = postFixture({
    id: 'p-badge',
    purpose: 'expedition_badge',
    evidence: ['expedition:widget-abc123'],
    body: '⛺ Expedition launched: widget.',
  });
  assert.match(inChat(badge), /href="\/expeditions\/widget-abc123"/);
  const plain = postFixture({ id: 'p-plain', evidence: ['expedition:widget-abc123'] });
  assert.doesNotMatch(inChat(plain), /\/expeditions\//);
});

const view: ExpeditionView = {
  id: 'widget-abc123',
  name: 'widget',
  badge: '⛺ widget · needs you',
  run: { t: 'waiting_owner', question: 'Should the website be in scope?' },
  goal: 'Make the widget pass its test.',
  done: ['pnpm test widget passes'],
  inScope: ['widget'],
  outOfScope: ['the website'],
  workspaceId: 'ws-1',
  launchedAt: '2026-11-01T00:00:00.000Z',
  deadline: '2026-11-01T04:00:00.000Z',
  now: '2026-11-01T00:10:00.000Z',
  crew: { t: 'pending' },
  roster: { manager: 'claude', work: ['claude', 'codex'], check: ['codex'] },
  counts: {
    attempts: 3,
    maxAttempts: 20,
    live: 1,
    maxLive: 2,
    queued: 0,
    verified: 0,
    exploreCap: 4,
  },
  questions: [
    {
      id: 'q1',
      title: 'Why does the widget fail?',
      detail: 'Find it.',
      scope: 'in',
      status: 'open',
      attempts: ['w1'],
    },
  ],
  attempts: [
    {
      id: 'w1',
      kind: 'work',
      label: 'work on q1 (claude)',
      seat: 'claude',
      questionId: 'q1',
      phase: 'posted',
      live: true,
      brief: 'Bisect the last ten commits.',
      outcome: null,
      requestId: 'post-1',
    },
  ],
  panels: [],
  reflections: [{ at: '2026-11-01T00:05:00.000Z', text: 'Two approaches fail the same way.' }],
  lessons: [],
};

// The page's first screen must answer "what is it, is it stuck, what is running and on what
// instructions" without a click: a page that hid the owner question or the live brief would
// leave the owner unable to unblock it.
test('the expedition page leads with its state, the owner question, and live workers with their instructions', async () => {
  await loadResource({ key: expeditionUrl(view.id), load: async () => view });
  const html = renderToStaticMarkup(
    <Provider store={jotaiStore}>
      <MemoryRouter initialEntries={[`/expeditions/${view.id}`]}>
        <Routes>
          <Route path="/expeditions/:id" element={<ExpeditionPage layout="wide" />} />
        </Routes>
      </MemoryRouter>
    </Provider>
  );
  assert.match(html, /needs you/);
  assert.match(html, /Should the website be in scope\?/);
  assert.match(html, /Bisect the last ten commits\./);
  // Lean: reflections and tasks are one click away, not on the first screen.
  assert.doesNotMatch(html, /Two approaches fail the same way\./);
});
