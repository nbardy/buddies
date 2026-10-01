import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { Task, TaskDetail } from '../src/components/buddies/types';

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
  const child = task('child', 'Polish comments', current.id);
  const detail: TaskDetail = {
    task: current,
    children: [child],
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
  const page = { posts: [], next: undefined };
  seedResource({ key: '/api/buddies/tasks/current/posts?limit=50', load: async () => page }, page);
  for (const submit of ['enter', 'button'] as const) {
    const html = renderToStaticMarkup(
      <Provider store={jotaiStore}>
        <MemoryRouter>
          <TaskPage
            taskId="current"
            workspaceId="workspace"
            channelId="general"
            directory={workspaceDirectory([], 'workspace', [project, current, child])}
            submit={submit}
          />
        </MemoryRouter>
      </Provider>
    );
    assert.match(html, /Task page/);
    assert.match(html, /A usable task page/);
    assert.match(html, /Project: Ship Tasks/);
    assert.match(html, /href="[^"]*task=project"/);
    assert.match(html, /href="[^"]*task=child"/);
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
