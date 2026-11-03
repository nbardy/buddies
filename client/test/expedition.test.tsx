import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import type { Expedition, State } from '@unleashd/shared';
import { renderToStaticMarkup } from 'react-dom/server';

register(
  `data:text/javascript,${encodeURIComponent(`
    export async function load(url, context, nextLoad) {
      if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
      return nextLoad(url, context);
    }
  `)}`,
  import.meta.url
);
const { ExpeditionModal } = await import('../src/components/buddies/ExpeditionModal');
const { expeditionUrl } = await import('../src/components/buddies/expedition-api');
const { loadResource } = await import('../src/atoms/resources');
const { jotaiStore } = await import('../src/atoms/store');
const { Provider } = await import('jotai');
const { MemoryRouter } = await import('react-router-dom');

// One smoke test of the modal over every state, plus the one control that cannot be undone.
const launch = { at: 'a', deadline: '2026-11-01T08:00:00Z', repoRoot: '/r', baseSha: 'b' };
const live = { ...launch, crewBuddyId: 'c', chatChannelId: 'dm', chatSeenOrd: '' };
const end = {
  at: 'a',
  turn: 'answered' as const,
  sha: 'cd',
  lesson: { t: 'lesson' as const, text: 'grep is literal' },
};
const record = (id: string, state: State): Expedition => ({
  v: 1,
  id,
  workspaceId: 'ws-1',
  createdAt: 'a',
  launcherId: 'lead',
  origin: { t: 'direct' },
  charter: {
    name: id,
    goal: 'Make the **widget** pass.',
    done: { t: 'owner' },
    maxAttempts: 5,
    maxLive: 1,
    hours: 8,
    seat: { provider: 'claude' },
  },
  state,
  attempts: [
    {
      n: 1,
      workspace: 'w',
      branch: `expedition/${id}/a1`,
      startedAt: 'a',
      tree: { t: 'released', salvageRef: null },
      phase: { t: 'judging', end },
    },
  ],
  notes: [],
});
const render = (id: string) =>
  renderToStaticMarkup(
    <Provider store={jotaiStore}>
      <MemoryRouter>
        <ExpeditionModal id={id} onClose={() => undefined} />
      </MemoryRouter>
    </Provider>
  );

test('the modal renders every state and an unreadable record; retire takes a confirm step', async () => {
  const states: State[] = [
    { t: 'draft', issues: ['claude is not installed on this host'] },
    { t: 'running', launch: live },
    { t: 'paused', launch: live },
    { t: 'finished', launch: live, at: 'a', reason: { t: 'passed', n: 1 } },
  ];
  for (const state of states) {
    const x = record(`x-${state.t}`, state);
    await loadResource({ key: expeditionUrl(x.id), load: async () => x });
    const html = render(x.id);
    assert.match(html, /<strong>widget<\/strong>/, state.t);
    assert.match(html, /grep is literal/, state.t);
    // Retire is never one click: the first button only arms the confirm.
    assert.doesNotMatch(html, /Confirm retire/, state.t);
  }
  assert.match(render('x-draft'), /claude is not installed/);
  assert.match(render('x-running'), />Pass<.*>Fail</s);
  assert.match(render('x-finished'), />Retire</);
  await loadResource({
    key: expeditionUrl('bad'),
    load: async () => Promise.reject(new Error('unreadable: bad json')),
  }).catch(() => undefined);
  assert.match(render('bad'), /unreadable: bad json/);
});
