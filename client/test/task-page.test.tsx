import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { Task, TaskDetail } from '../src/components/buddies/types';
import { postFixture } from './fixtures/channel-posts';
import { CODEX_INSTALLED } from './fixtures/buddy-roster';

register(
  `data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    return nextLoad(url, context);
  }
`)}`,
  import.meta.url
);
const { Provider } = await import('jotai');
const { jotaiStore } = await import('../src/atoms/store');
const { seedResource } = await import('../src/atoms/resources');
const { TaskPage } = await import('../src/components/buddies/TaskPage');
const { workspaceDirectory } = await import('../src/components/buddies/channel-data');

const task = (id: string, title: string, parentId?: string): Task => ({
  id,
  title,
  parentId,
  workspaceId: 'workspace',
  ownerId: 'lead',
  doneCriteria: 'A usable task page',
  status: 'open',
  paused: false,
  epoch: 0,
  evidence: [],
  position: 0,
  pin: 0,
  revision: 1,
  createdAt: '2026-09-30T00:00:00Z',
  updatedAt: '2026-09-30T00:00:00Z',
});

test('Home task destination shows task details, project and subtask links, and mention discussion', () => {
  const project = task('project', 'Ship Tasks');
  const current = task('current', 'Task page', project.id);
  current.evidence = Array.from({ length: 60 }, (_, i) => `agent_notes/experiment-${i}/RESULT.md`);
  current.nextAction = 'Review the release';
  current.blockedReason = 'Waiting for owner review';
  const child = task('child', 'Polish comments', current.id);
  const detail: TaskDetail = {
    task: current,
    children: [
      child,
      { ...task('done', 'Finished subtask', current.id), status: 'done' },
      { ...task('cancelled', 'Cancelled subtask', current.id), status: 'cancelled' },
    ],
    comments: [],
    runs: [],
    channel: {
      id: 'task-channel',
      workspaceId: 'workspace',
      kind: { type: 'task', taskId: current.id },
      createdBy: { kind: 'owner' },
      createdAt: current.createdAt,
    },
  };
  seedResource({ key: '/api/buddies/tasks/current', load: async () => detail }, detail);
  const page = {
    posts: [
      postFixture({
        id: 'task-comment',
        channelId: 'general',
        author: { kind: 'owner' },
        body: 'Shared discussion rendering',
        evidence: ['agent_notes/experiment-comment/RESULT.md'],
      }),
    ],
    next: undefined,
  };
  seedResource({ key: '/api/buddies/tasks/current/posts?limit=50', load: async () => page }, page);
  for (const submit of ['enter', 'button'] as const) {
    const html = renderToStaticMarkup(
      <Provider store={jotaiStore}>
        <MemoryRouter>
          <TaskPage
            taskId="current"
            workspaceId="workspace"
            channelId="general"
            directory={workspaceDirectory(
              [],
              'workspace',
              [project, current, child],
              CODEX_INSTALLED
            )}
            submit={submit}
          />
        </MemoryRouter>
      </Provider>
    );
    assert.match(html, /Task page/);
    assert.match(html, /A usable task page/);
    assert.match(html, /aria-label="Next action"/);
    assert.match(html, /aria-label="Blocker"/);
    assert.ok(
      html.indexOf('aria-label="Next action"') < html.indexOf('aria-label="Completion criteria"')
    );
    assert.ok(
      html.indexOf('aria-label="Completion criteria"') < html.indexOf('aria-label="Discussion"')
    );
    assert.match(html, /aria-label="Completion criteria"/);
    assert.match(html, /Edit task<\/button>/);
    assert.doesNotMatch(html, /Details &amp; settings/);
    assert.doesNotMatch(
      html,
      /<details[^>]*aria-label="Completion criteria"/,
      'criteria must stay visible'
    );
    assert.ok(
      html.indexOf('aria-label="Execution history"') > html.indexOf('aria-label="Discussion"')
    );
    assert.match(html, /Project: Ship Tasks/);
    assert.match(html, /href="[^"]*task=project"/);
    assert.match(html, /href="[^"]*task=child"/);
    assert.doesNotMatch(html, /agent_notes\/experiment-|aria-label="Evidence"/);
    assert.match(html, /<section[^>]*aria-label="Subtasks"/);
    assert.match(html, /role="progressbar"[^>]*aria-valuenow="50"/);
    assert.match(html, /aria-valuetext="1 of 2 todos done"/);
    assert.ok(html.indexOf('aria-label="Subtasks"') < html.indexOf('aria-label="Next action"'));
    assert.match(html, /<details[^>]*aria-label="Execution history"/);
    assert.ok(html.indexOf('aria-label="Subtasks"') < html.indexOf('aria-label="Discussion"'));
    assert.match(html, /Shared discussion rendering/);
    assert.match(html, /aria-label="Message actions"/);
    assert.match(html, /Reply in thread<\/button>/);
    assert.match(html, /class="ui-section__title"/);
    assert.doesNotMatch(html, /class="landing[ -]/);
    assert.match(html, /Discussion/);
    assert.match(html, /@mention a Buddy/);
    assert.match(html, /class="channel-composer/);
    assert.doesNotMatch(
      html,
      /Manage<\/summary>/,
      'task rows must not repeat management disclosures'
    );
  }
});

test('a task page link works before the workspace has any public channel', async () => {
  const { channelsHref, channelsView } = await import('../src/components/buddies/channels-view');
  const target = { kind: 'task' as const, channelId: '', taskId: 'current' };
  const href = channelsHref('workspace', target);
  assert.equal(href, '/buddies/workspaces/workspace/channels?task=current');
  assert.deepEqual(channelsView(new URL(href, 'http://localhost').search), target);
});
