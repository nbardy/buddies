import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { legacyBody } from '@unleashd/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
register(
  `data:text/javascript,${encodeURIComponent(`
    export async function load(url, context, nextLoad) {
      if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
      return nextLoad(url, context);
    }
  `)}`,
  import.meta.url
);
const { ChannelMarkdown } = await import('../src/components/buddies/ChannelMarkdown');
const { ChannelTaskOverlay } = await import('../src/components/buddies/ChannelTaskOverlay');
const { pastedBody } = await import('../src/components/buddies/composer-draft');
const { Provider } = await import('jotai');
const { jotaiStore } = await import('../src/atoms/store');
const { loadResource } = await import('../src/atoms/resources');
type ChannelTask = import('../src/components/buddies/channel-text').ChannelTask;

// Regression, #buddies-dev 2026-09-24: a mention reply is the Buddy's final
// assistant message with the provider's tool summaries embedded, and the
// channel painted every `🔧 …` / `⚡ Bash …` line raw above the answer. Runs
// must collapse into the chat's "N tool calls" disclosure, closed by default.
test('tool-call lines in a post collapse into the chat activity disclosure', () => {
  const body = [
    '🔧 ToolSearch select:mcp__unleashd_buddy__get_thread,mcp__unleashd_buddy__get_inbox',
    '🔧 mcp__unleashd_buddy__get_thread',
    '⚡ Bash cd /Users/nicholasbardy/git/unleashd; rg -n "new_list" product/buddies',
    'Four channels are up. Next I am posting each open Task.',
    '🔧 mcp__unleashd_buddy__post',
    '🔧 mcp__unleashd_buddy__post',
    'Because only one has ever been **created**.',
  ].join('\n');
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <ChannelMarkdown body={legacyBody(body)} buddyNames={{}} tasks={new Map()} />
    </MemoryRouter>
  );
  const toggles = [...html.matchAll(/class="chat-activity-toggle"[^>]*>(.*?)<\/button>/g)].map(
    (match) => match[1].replace(/<[^>]+>/g, '').replace('▸', '')
  );
  assert.deepEqual(toggles, ['3 tool calls', '2 tool calls']);
  assert.doesNotMatch(html, /mcp__unleashd_buddy/);
  assert.doesNotMatch(html, /🔧|⚡/);
  assert.match(html, /Four channels are up/);
  assert.match(html, /<strong>created<\/strong>/);
});

test('channel images stay in the app instead of linking to a new document', () => {
  const html = renderChannel(
    '![Screenshot](/Users/me/.agent-viewer/uploads/channels/ch1/image.png)'
  );
  assert.match(
    html,
    /<button[^>]*class="channel-media-link"[^>]*aria-label="Open image: Screenshot"/
  );
  assert.match(html, /<img class="channel-media" src="\/api\/files\?path=/);
  assert.doesNotMatch(html, /target="_blank"/);
});

// Owner report, #buddies-dev 2026-09-24: a Task ref inside a sentence was a
// full-width wrapping pill that stranded ", marked ready." on its own line.
// In a sentence it must stay one inline chip in the same paragraph; alone on
// its line it becomes the card (title, status, owner, todo progress).
test('a Task ref is an inline chip in a sentence and a card on its own line', () => {
  const task: ChannelTask = {
    id: 'task_1',
    title: 'Mention replies post the tool-call trace into the channel',
    status: 'open',
    ownerId: 'lead',
    ownerName: 'Buddies Development Lead',
    topLevel: true,
    nextAction: undefined,
    todosDone: 1,
    todosTotal: 5,
  };
  const ref = `[${task.title}](task:${task.id})`;
  const render = (body: string) =>
    renderToStaticMarkup(
      <MemoryRouter>
        <ChannelMarkdown
          body={{ t: 'text', text: body }}
          buddyNames={{}}
          tasks={new Map([[task.id, task]])}
        />
      </MemoryRouter>
    );

  const inline = render(`I filed that as ${ref}, marked ready.`);
  // A button, not a link: a Task click opens the overlay and stays in Channels (493c1c7).
  assert.match(
    inline,
    /^<div class="channel-markdown"><p>I filed that as <button[^>]*class="channel-task-chip"/
  );
  assert.match(inline, /<\/button>, marked ready\.<\/p>/);
  assert.doesNotMatch(inline, /href="\/buddies\//);
  assert.doesNotMatch(inline, /channel-task-block/);

  for (const body of [ref, `- ${ref}\n- ${ref}`]) {
    const block = render(body);
    assert.doesNotMatch(block, /channel-task-chip/);
    assert.match(block, /class="channel-task-block"/);
    assert.match(
      block,
      /Open<span class="channel-task-card-owner[^"]*"> · Buddies Development Lead/
    );
    assert.match(block, /width:20%.*1\/5 todos/);
  }
});

const renderChannel = (body: string) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <ChannelMarkdown body={legacyBody(body)} buddyNames={{}} tasks={new Map()} />
    </MemoryRouter>
  );

// Owner report 2026-09-24 (#general thread): a mention reply showed the raw
// `<!--buddy_team_configuration:%7B%22…-->` blob under "6 tool calls". Team
// configuration was retired with the v2 Buddy server (T11), but old posts
// still carry the marker, compact or whitespace-wrapped: it must vanish, never
// paint raw.
test('a retired team configuration marker renders nothing, not the raw blob', () => {
  const marker = '<!--buddy_team_configuration:%7B%22workspaceId%22%3A%22p1%22%7D-->';
  for (const wrapped of [marker, marker.replace('<!--', '<!--\n').replace('-->', '\n-->')]) {
    const html = renderChannel(`Hired the coordinator.\n${wrapped}\nWelcome aboard.`);
    assert.match(html, /Hired the coordinator/);
    assert.match(html, /Welcome aboard/);
    assert.doesNotMatch(html, /buddy_team_configuration/);
    assert.doesNotMatch(html, /%22workspaceId%22/);
  }
});

// Sibling markers ride the same server injection path (runtime tool.result),
// so none of them may paint raw in a channel either.
test('sibling structured markers never paint raw in channels', () => {
  const question = `<!--ask_user_question:${JSON.stringify({
    questions: [{ question: 'Which opening?', options: [{ label: 'Zone' }] }],
  })}-->`;
  const worker = '<!--buddy_worker_thread:{"conversationId":"w1"}-->';
  const review = [
    '<!-- unleashd:buddy-review-result -->',
    '{"verdict":"pass","summary":"Looks good","evidence":[],"requiredActions":[]}',
    '<!-- /unleashd:buddy-review-result -->',
  ].join('\n');
  const html = renderChannel(`${question}\n${worker}\n${review}\nTip-off at nine.`);
  assert.match(html, /Which opening\?/);
  assert.doesNotMatch(html, /Looks good/);
  assert.match(html, /Tip-off at nine/);
  assert.doesNotMatch(html, /ask_user_question/);
  assert.doesNotMatch(html, /buddy_worker_thread/);
  assert.doesNotMatch(html, /buddy-review-result/);
});

// 493c1c7: a Task click left Channels for the owner's Work tab. It now opens the Task over the
// channel: its criteria, todos and comments, with the Work tab one link away.
test('the Task overlay shows the Task detail in place, with a way on to Work', async () => {
  const task: ChannelTask = {
    id: 'task_9',
    title: 'Ship the overlay',
    status: 'in_progress',
    ownerId: 'lead',
    ownerName: 'Lead',
    topLevel: true,
    nextAction: undefined,
    todosDone: 0,
    todosTotal: 1,
  };
  const stored = {
    id: 'task_9',
    workspaceId: 'ws',
    ownerId: 'lead',
    title: 'Ship the overlay',
    doneCriteria: 'The chip opens it',
    status: 'in_progress',
    paused: false,
    epoch: 0,
    evidence: [],
    position: 0,
    revision: 1,
    createdAt: '2026-09-26T00:00:00Z',
    updatedAt: '2026-09-26T00:00:00Z',
  };
  await loadResource({
    key: '/api/buddies/tasks/task_9',
    load: async () => ({
      task: stored,
      channel: { id: 'ch_task', workspaceId: 'ws', kind: { type: 'task', taskId: 'task_9' } },
      children: [{ ...stored, id: 'todo_1', title: 'Write the test' }],
      comments: [],
      runs: [],
    }),
  });
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <Provider store={jotaiStore}>
        <ChannelTaskOverlay task={task} names={{ lead: 'Lead' }} onClose={() => undefined} />
      </Provider>
    </MemoryRouter>
  );
  assert.match(html, /<dialog[^>]*aria-label="Ship the overlay"/);
  assert.match(html, /The chip opens it/);
  assert.match(html, /Write the test/);
  assert.match(html, /href="\/buddies\/lead\/work"[^>]*>Open in Work</);
  assert.match(html, /aria-label="Close task"/);
});

// 2026-10-08: copying a rendered mention and pasting it into the composer pasted plain "@Name" and
// lost the Buddy. The composer reads the id from the markup the post actually renders (the router
// link's data attribute), so renaming or restyling that link must keep it.
test('a copied rendered mention pastes into the composer as its Buddy', () => {
  const html = renderChannel('[@Old name](buddy:b9) please look');
  const roster = [{ kind: 'buddy' as const, id: 'b9', name: 'Reviewer' }];
  assert.equal(
    pastedBody('@Old name please look', html, roster),
    '[@Reviewer](buddy:b9) please look'
  );
});
