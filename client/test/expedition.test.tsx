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
const { ExpeditionView } = await import('../src/components/buddies/ExpeditionView');
const { expeditionUrl } = await import('../src/components/buddies/expedition-api');
const { loadResource } = await import('../src/atoms/resources');
const { jotaiStore } = await import('../src/atoms/store');
const { Provider } = await import('jotai');
const { MemoryRouter } = await import('react-router-dom');

// One smoke test of the expedition view over every state and both frames, plus the controls that
// cannot be undone.
const launch = {
  at: 'a',
  deadline: '2026-11-01T08:00:00Z',
  repoRoot: '/r',
  baseSha: 'b',
  baseRef: 'refs/heads/main',
};
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
    oracle: [],
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
const render = (id: string, frame: 'desktop' | 'mobile' = 'desktop', tab?: string) =>
  renderToStaticMarkup(
    <Provider store={jotaiStore}>
      <MemoryRouter initialEntries={[`/?expedition=${id}${tab ? `&tab=${tab}` : ''}`]}>
        <ExpeditionView id={id} workspaceId="ws-1" frame={frame} />
      </MemoryRouter>
    </Provider>
  );
const selected = (html: string) => /aria-selected="true"[^>]*>([A-Za-z]+)/.exec(html)?.[1];

// One smoke test of the tabbed view over every state and both frames: the URL picks the tab, the
// verdict badge and pill follow the record, and the controls that cannot be undone take two clicks.
test('the URL picks the tab; a needed verdict badges Attempts; stop and retire confirm', async () => {
  const states: State[] = [
    { t: 'draft', issues: ['claude is not installed on this host'] },
    { t: 'running', launch: live },
    { t: 'paused', launch: live },
    { t: 'finished', launch: live, at: 'a', reason: { t: 'passed', n: 1 } },
  ];
  for (const state of states) {
    const x = record(`x-${state.t}`, state);
    await loadResource({ key: expeditionUrl(x.id), load: async () => x });
    for (const frame of ['desktop', 'mobile'] as const) {
      const at = `${state.t} ${frame}`;
      assert.match(render(x.id, frame, 'goal'), /<strong>widget<\/strong>/, at);
      assert.match(render(x.id, frame, 'attempts'), /grep is literal/, at);
      // Only the open tab's panel renders: the goal is not on the Attempts tab.
      assert.doesNotMatch(render(x.id, frame, 'attempts'), /<strong>widget<\/strong>/, at);
      // Never one click: the first button only arms the confirm.
      for (const tab of ['chat', 'attempts', 'goal', 'details'])
        assert.doesNotMatch(render(x.id, frame, tab), /Confirm retire|Stop for good/, at);
    }
  }
  // With no tab (or an unknown one) a draft opens on its goal, with the blocked-launch issue; a
  // launched record opens on the chat.
  assert.equal(selected(render('x-draft')), 'Goal');
  assert.match(render('x-draft'), /claude is not installed/);
  assert.equal(selected(render('x-running', 'desktop', 'nonsense')), 'Chat');
  assert.match(render('x-draft', 'desktop', 'chat'), /starts at launch.*>Launch</s);
  assert.equal(selected(render('x-paused', 'mobile', 'details')), 'Details');
  // Review 2026-11-03: the pill said "Running" in green while an attempt waited on the owner.
  // Now the pill says so and Attempts carries the count, on any tab; Pass/Fail sit on Attempts.
  const waiting = render('x-running', 'mobile', 'goal');
  assert.match(waiting, /data-state="needs-you">Needs your verdict</);
  assert.match(waiting, />Attempts<span class="expedition-tab-count"[^>]*>1</);
  assert.match(render('x-running', 'desktop', 'attempts'), />Pass<.*>Fail</s);
  // Finished: no verdict is awaited, so no badge and no Pass/Fail.
  assert.doesNotMatch(render('x-finished', 'desktop', 'attempts'), /expedition-tab-count|>Pass</);
  // Owner 2026-11-03: relaunch is offered once an expedition is over, never while it runs.
  assert.match(render('x-finished'), /data-tone="primary"[^>]*>Relaunch</);
  assert.doesNotMatch(render('x-running'), />Relaunch</);
  assert.match(render('x-finished', 'desktop', 'details'), />Retire</);
  await loadResource({
    key: expeditionUrl('bad'),
    load: async () => Promise.reject(new Error('unreadable: bad json')),
  }).catch(() => undefined);
  assert.match(render('bad'), /unreadable: bad json/);
});
