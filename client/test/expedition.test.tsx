import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import type { ExpeditionDraftView, ExpeditionSummary, ExpeditionView } from '@unleashd/shared';
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
const { ExpeditionModal } = await import('../src/components/buddies/ExpeditionModal');
const { workspaceDirectory } = await import('../src/components/buddies/channel-data');
const { draftUrl, expeditionUrl, EXPEDITION_CREWS_URL } = await import(
  '../src/components/buddies/expedition-view'
);
const { buddySidebarAtom, buddySidebarOverviewAtom } = await import('../src/atoms/buddy-sidebar');
const { buddyRailFamily } = await import('../src/atoms/channel-rail');
const { loadResource } = await import('../src/atoms/resources');
const { jotaiStore } = await import('../src/atoms/store');
const { Provider } = await import('jotai');
const { MemoryRouter } = await import('react-router-dom');

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
  badge: '⛺ widget · needs you',
  run: { t: 'waiting_owner', question: 'Should the website be in scope?' },
  charter: {
    name: 'widget',
    // Markdown, as the Buddy writes it (2026-11-01 screenshot: shown as raw text before).
    goal: 'Make the **widget** pass its test.\n\n1. Find the failure\n2. Fix it',
    done: {
      t: 'checks',
      checks: [
        { kind: 'command', argv: ['pnpm', 'test', 'widget'], timeoutSeconds: 600 },
        { kind: 'judged', text: 'The widget docs describe the fix.' },
      ],
    },
    inScope: ['widget'],
    outOfScope: ['the website'],
    roster: { manager: 'claude', work: ['claude', 'codex'], check: ['codex'] },
    limits: { maxAttempts: 20, maxLive: 2, hours: 4, exploreShare: 0.2 },
  },
  validations: [
    {
      id: 'v1',
      subject: { t: 'candidate', claimAttemptId: 'w0' },
      label: 'validation v1 of candidate 1a2b3c4d5e of w0: FAILED',
      verdict: 'failed',
      checks: [{ checkIndex: 0, passed: false, outcome: 'FAILED (exit 3): widget still broken' }],
    },
  ],
  integration: {
    branch: 'expedition/widget-abc123',
    head: '9f8e7d6c5b4a39281706',
    integrated: 1,
    queued: 0,
    lastRefusal: {
      t: 'refused',
      label: 'integration i2 of w0 (1a2b3c4d5e): REFUSED — merge conflict in docs/README.md',
    },
  },
  cost: {
    short: '2k tokens',
    line: 'Cost: 2k input + 300 output tokens (cache 5k read, 300 written) over 1 measured attempt(s); 1 not measured (muse records no token usage (session s1)). Tokens only: no price is estimated.',
  },
  workspaceId: 'ws-1',
  launchedAt: '2026-11-01T00:00:00.000Z',
  deadline: '2026-11-01T04:00:00.000Z',
  now: '2026-11-01T00:10:00.000Z',
  crew: { t: 'pending' },
  counts: {
    attempts: 3,
    maxAttempts: 20,
    decisions: 2,
    maxDecisions: 42,
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
      stage: 'implementing',
      paths: ['widget'],
      after: [],
      attempts: ['w0', 'w1'],
    },
  ],
  attempts: [
    {
      id: 'w0',
      kind: 'work',
      label: 'work on q1 (codex)',
      seat: 'codex',
      questionId: 'q1',
      phase: { t: 'ended', outcome: 'CLAIM: fixed' },
      live: false,
      brief: 'Patch the widget.',
      requestId: 'post-0',
      worktree: { t: 'tree', branch: 'exp/widget-abc123/w0', path: '/x/w0' },
      cost: { t: 'unmeasured', reason: 'muse records no token usage (session s1)' },
    },
    {
      id: 'w1',
      kind: 'work',
      label: 'work on q1 (claude)',
      seat: 'claude',
      questionId: 'q1',
      phase: { t: 'posted' },
      live: true,
      brief: 'Bisect the last ten commits.',
      requestId: 'post-1',
      worktree: { t: 'tree', branch: 'exp/widget-abc123/w1', path: '/x/w1' },
      cost: { t: 'none' },
    },
  ],
  panels: [],
  verifications: [],
  reflections: [{ at: '2026-11-01T00:05:00.000Z', text: 'Two approaches fail the same way.' }],
  lessons: [],
};

const inModal = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <Provider store={jotaiStore}>
      <MemoryRouter>{node}</MemoryRouter>
    </Provider>
  );
const close = () => {};

// The modal's first screen must answer "what is it, is it stuck, what is running and on what
// instructions" without a click: hiding the owner question or the live brief would leave the
// owner unable to unblock it. The goal renders as markdown (it showed raw `1.` and `**`).
test('the expedition modal leads with its state, the owner question, the goal as markdown, and live workers with their instructions', async () => {
  await loadResource({ key: expeditionUrl(view.id), load: async () => view });
  const html = inModal(
    <ExpeditionModal target={{ t: 'live', id: view.id }} presentation="dialog" onClose={close} />
  );
  assert.match(html, /<dialog[^>]*aria-label="Expedition widget"/);
  assert.match(html, /needs you/);
  assert.match(html, /Should the website be in scope\?/);
  assert.match(html, /Make the <strong>widget<\/strong> pass its test\./);
  assert.match(html, /<ol>\s*<li>Find the failure<\/li>/);
  assert.match(html, /Bisect the last ten commits\./);
  // Where work lands and why it did not: the worker's branch, its claim's host validation with
  // the exit code, and the expedition branch's last refused merge.
  assert.match(html, /branch exp\/widget-abc123\/w1/);
  assert.match(html, /validation failed/);
  assert.match(html, /check 0: FAILED \(exit 3\): widget still broken/);
  assert.match(html, /expedition\/widget-abc123 @ 9f8e7d6/);
  assert.match(html, /last refusal: .*merge conflict in docs\/README\.md/);
  // Spend is measured or says why not (design.md R6); nothing is priced.
  assert.match(html, /title="Cost: 2k input \+ 300 output tokens .* 1 not measured/);
  assert.match(html, /Cost: not measured \(muse records no token usage \(session s1\)\)/);
  assert.doesNotMatch(html, /\$\d/);
  // Reflections are one tab away, not on the first screen.
  assert.doesNotMatch(html, /Two approaches fail the same way\./);
});

// Before the crew Buddy exists there is no chat yet; the chat column must say what is happening.
test('before the crew exists, the chat says the crew is starting instead of rendering nothing', async () => {
  const starting: ExpeditionView = { ...view, id: 'widget-new000', crew: { t: 'pending' } };
  await loadResource({ key: expeditionUrl(starting.id), load: async () => starting });
  const html = inModal(
    <ExpeditionModal
      target={{ t: 'live', id: starting.id }}
      presentation="dialog"
      onClose={close}
    />
  );
  assert.match(html, /Starting the crew/);
});

const draft = (id: string, patch: Partial<ExpeditionDraftView> = {}): ExpeditionDraftView => ({
  id,
  workspaceId: 'ws-1',
  createdAt: '2026-11-01T00:00:00.000Z',
  state: { t: 'open' },
  charter: {
    ...view.charter,
    limits: { maxAttempts: 6, maxLive: 3, hours: 12, exploreShare: 0.2 },
  },
  issues: [],
  advice: [],
  defaulted: ['crew: the default crew'],
  resolved: [],
  ...patch,
});
const draftPost = (draftId: string) =>
  postFixture({
    id: `p-${draftId}`,
    purpose: 'expedition_draft',
    evidence: [`expedition-draft:${draftId}`],
    body: '⛺ Draft expedition: widget',
  });
const cardOf = async (d: ExpeditionDraftView) => {
  await loadResource({ key: draftUrl(d.id, 'ws-1'), load: async () => d });
  return inChat(draftPost(d.id));
};
const launchButton = (html: string) => /<button[^>]*>Launch<\/button>/.exec(html)?.[0] ?? '';

// 2026-11-01 owner request: a draft is a widget in the chat with Info and Launch. A Launch that
// stayed enabled with issues would only fail on click; one hidden after launch strands the owner.
test('a draft card shows Info and Launch; Launch is disabled with its reason while issues stand; a launched draft opens the expedition', async () => {
  const open = await cardOf(draft('dopen'));
  assert.match(open, /Draft ·<\/span> <strong>widget<\/strong>/);
  assert.match(open, /6 attempts · 3 at once · 12 h/);
  assert.match(open, />Info<\/button>/);
  assert.doesNotMatch(launchButton(open), /disabled/);
  assert.doesNotMatch(open, /⛺ Draft expedition: widget/, 'the card replaces the fallback text');

  const blocked = await cardOf(draft('dissue', { issues: ['codex: no such model gpt-0'] }));
  assert.match(launchButton(blocked), /disabled/);
  assert.match(blocked, /1 issue to fix first/);

  const replaced = await cardOf(draft('dold', { state: { t: 'superseded', by: 'dnew' } }));
  assert.match(launchButton(replaced), /disabled/);
  assert.match(replaced, /Replaced by a newer draft/);

  const launched = await cardOf(
    draft('dlaunched', { state: { t: 'launched', expeditionId: 'widget-abc123' } })
  );
  assert.match(launched, />Launched →<\/button>/);
  assert.equal(launchButton(launched), '');
});

test('the draft modal shows the charter with its issues and defaults, and a Launch footer', async () => {
  const d = draft('dmodal', { issues: ['codex: no such model gpt-0'] });
  await loadResource({ key: draftUrl(d.id, 'ws-1'), load: async () => d });
  const html = inModal(
    <ExpeditionModal
      target={{ t: 'draft', draftId: d.id, workspaceId: 'ws-1' }}
      presentation="dialog"
      onClose={close}
    />
  );
  assert.match(html, /Make the <strong>widget<\/strong> pass/);
  assert.match(html, /codex: no such model gpt-0/);
  assert.match(html, /crew: the default crew/);
  assert.match(html, /<code>\$ pnpm test widget<\/code>/);
  assert.match(launchButton(html), /disabled/);
  assert.match(html, />Close<\/button>/);
});

// The status post's body is markdown (server expeditions/news.ts launchNews): the name in bold,
// "Planning…" its own paragraph. 2026-11-01 screenshot: it read as one raw line cut mid-word.
test('an expedition status post renders as markdown in the chat', () => {
  const html = inChat(
    postFixture({
      id: 'p-status',
      purpose: 'expedition_status',
      evidence: ['expedition:widget-abc123'],
      body: '⛺ Launched **widget**: Make the widget pass its test.\n\nPlanning…',
    })
  );
  assert.match(html, /<strong>widget<\/strong>/);
  assert.match(html, /<p>Planning…<\/p>/);
});

// Crew Buddies are expedition machinery (2026-11-01 screenshot: "⛺ Emergent beach de…" listed as
// a team member). Hidden by the server's explicit crew list, in the sidebar and the channel rail.
test('expedition crew Buddies are absent from the Buddies roster and rail', async () => {
  const lead = { id: 'lead', name: 'Lead', status: 'active' as const };
  const crew = { id: 'crew-1', name: '⛺ widget crew', status: 'active' as const };
  jotaiStore.set(buddySidebarOverviewAtom, [
    { id: 'ws-1', name: 'Repo', rootPath: '/repo', buddies: [lead, crew] },
  ]);
  const listed = () =>
    jotaiStore.get(buddySidebarAtom).projects.flatMap((p) => p.items.map((i) => i.buddyId));
  assert.deepEqual(
    listed().sort(),
    ['crew-1', 'lead'],
    'before the crew list loads, nothing is guessed'
  );
  await loadResource({ key: EXPEDITION_CREWS_URL, load: async () => ({ buddyIds: ['crew-1'] }) });
  assert.deepEqual(listed(), ['lead']);
  const members = [lead, crew] as unknown as Parameters<typeof buddyRailFamily>[0];
  assert.deepEqual(
    jotaiStore.get(buddyRailFamily(members)).map((b) => b.id),
    ['lead']
  );
});

// ---------- Expeditions in the channels view (owner, 2026-11-01) ----------
// "we added the expeditions to the old conversation UI and not to the new slack UI". These pin the
// place: the channel rail lists them, a deep link opens the modal over the channels view, and the
// old conversations sidebar has no expedition section.

const { ChannelBrowser } = await import('../src/components/buddies/ChannelBrowser');
const { EXPEDITIONS_URL } = await import('../src/components/buddies/expedition-view');
const { inboxFixture, publicChannel } = await import('./fixtures/channel-posts');
const { rosterFixture } = await import('./fixtures/buddy-roster');
const { AppRoutes } = await import('../src/App');
const { Sidebar } = await import('../src/components/Sidebar');
const { prerenderToNodeStream } = await import('react-dom/static');

const summary = (
  id: string,
  run: ExpeditionView['run'],
  workspaceId = 'ws-rail'
): ExpeditionSummary => ({
  id,
  name: id,
  run,
  workspaceId,
  launchedAt: '2026-11-01T00:00:00.000Z',
  counts: view.counts,
  cost: view.cost,
});

async function railHtml(): Promise<string> {
  await loadResource({
    key: '/api/buddies/workspaces/ws-rail/inbox',
    load: async () =>
      inboxFixture([{ channel: publicChannel('ch_rail', 'general', 'ws-rail'), unread: 0 }]),
  });
  await loadResource({
    key: EXPEDITIONS_URL,
    load: async () => [
      summary('exp-running', { t: 'running' }),
      summary('exp-waiting', { t: 'waiting_owner', question: 'Which API?' }),
      summary('exp-paused', { t: 'paused' }),
      summary('exp-finished', { t: 'finished', reason: 'done' } as ExpeditionView['run']),
      summary('exp-elsewhere', { t: 'running' }, 'ws-other'),
    ],
  });
  const html = renderToStaticMarkup(
    <MemoryRouter initialEntries={['/']}>
      <Provider store={jotaiStore}>
        <ChannelBrowser
          workspaceId="ws-rail"
          directory={workspaceDirectory(
            [rosterFixture([], { id: 'ws-rail', name: 'rail' })],
            'ws-rail',
            [],
            CODEX_INSTALLED
          )}
          availableConversationIds={new Set()}
        />
      </Provider>
    </MemoryRouter>
  );
  return html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));
}

/** The rail button whose name is `id` (its attributes and children). */
const railRow = (rail: string, id: string) => {
  const end = rail.indexOf(`>${id}</span>`);
  assert.ok(end > 0, `${id} is in the rail`);
  return rail.slice(rail.lastIndexOf('<button', end), rail.indexOf('</button>', end));
};

// A wrong dot or a lost emphasis hides an expedition that is stuck waiting on the owner.
test('the channel rail lists this workspace’s unfinished expeditions between Channels and Buddies, with a status dot and needs-you emphasis', async () => {
  const rail = await railHtml();
  const section = rail.indexOf('>Expeditions</a>');
  assert.ok(section > rail.indexOf('>general</span>'), 'after the channels');
  assert.ok(section < rail.indexOf('>Buddies</h3>'), 'before the Buddies');
  assert.match(railRow(rail, 'exp-running'), /data-status="running"/);
  assert.doesNotMatch(railRow(rail, 'exp-running'), /data-unread/);
  const waiting = railRow(rail, 'exp-waiting');
  assert.match(waiting, /data-status="queued"/);
  assert.match(waiting, /data-unread="new"/);
  assert.match(waiting, /needs you/);
  assert.match(railRow(rail, 'exp-paused'), /data-status="idle"/);
  assert.match(railRow(rail, 'exp-paused'), /data-unread="read"/);
  assert.ok(
    rail.indexOf('>exp-waiting<') < rail.indexOf('>exp-running<'),
    'needing you comes first'
  );
  assert.doesNotMatch(rail, /exp-finished|exp-elsewhere/);
  // The count covers the finished ones too: 3 active + 1 finished used to read with no count.
  assert.match(rail, /All expeditions \(4\)/);
});

/** Renders the app's real route table at `url`, waiting for its lazy chunks. */
async function appAt(url: string, device: 'desktop' | 'mobile' = 'desktop'): Promise<string> {
  const { prelude } = await prerenderToNodeStream(
    <Provider store={jotaiStore}>
      <MemoryRouter initialEntries={[url]}>
        <AppRoutes device={device} />
      </MemoryRouter>
    </Provider>
  );
  let html = '';
  for await (const chunk of prelude) html += chunk;
  return html;
}

// A deep link (reload, pasted URL) must land in the channels view of the expedition's workspace with
// the modal over it — it used to open over the old shell's home.
test('a deep link to an expedition opens its modal over the channels view of its workspace', async () => {
  await loadResource({ key: expeditionUrl(view.id), load: async () => view });
  await loadResource({
    key: '/api/buddies/workspaces/ws-1/inbox',
    load: async () => inboxFixture([{ channel: publicChannel('ch_1', 'general'), unread: 0 }]),
  });
  const html = await appAt(`/expeditions/${view.id}`);
  assert.match(html, /class="channel-browser"/, 'the channels view is underneath');
  assert.match(html, /<section class="channel-browser-pane ui-stack" aria-label="Expeditions">/);
  assert.match(html, /Should the website be in scope\?/, 'the modal is open');
  assert.doesNotMatch(html, /class="sidebar/, 'never the old conversations shell');
});

// The phone shell takes the same route: the sheet over ChannelsMobile, never the old shell.
test('on the phone, a deep link opens the expedition sheet over the channels view', async () => {
  await loadResource({ key: expeditionUrl(view.id), load: async () => view });
  const html = await appAt(`/expeditions/${view.id}`, 'mobile');
  assert.match(html, /Should the website be in scope\?/, 'the sheet is open');
  assert.match(
    html,
    /mobile-ui-page__title">Expeditions</,
    'the channels expedition screen is underneath'
  );
  assert.match(html, /aria-label="Channels" class="[^"]*mobile-tab--active/, 'in the Channels tab');
  assert.doesNotMatch(html, /class="sidebar/);
});

// A deleted or unknown id used to leave the base 'pending' forever: a blank page under the modal,
// and closing went to the old home. It now lands on the channels expedition index with the error.
test('a deep link to an unreadable expedition shows the error over the channels expedition index', async () => {
  await loadResource({
    key: expeditionUrl('exp-gone'),
    load: async () => {
      throw new Error('HTTP 404');
    },
  });
  const html = await appAt('/expeditions/exp-gone');
  assert.match(html, /HTTP 404/, 'the modal says why');
  assert.match(html, /Channels/, 'the channels expedition index is underneath');
  assert.doesNotMatch(html, /class="sidebar/);
});

test('the old conversations sidebar has no expedition section', async () => {
  await loadResource({
    key: EXPEDITIONS_URL,
    load: async () => [summary('exp-running', { t: 'running' })],
  });
  const html = renderToStaticMarkup(
    <Provider store={jotaiStore}>
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>
    </Provider>
  );
  assert.match(html, /Buddies/, 'the sidebar rendered');
  assert.doesNotMatch(html, /Expeditions|exp-running|\/expeditions/);
});
