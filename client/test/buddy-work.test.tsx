import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { BuddyWork, byPosition, moveTask } from '../src/components/buddies/BuddyWork';
import type { Task } from '../src/components/buddies/types';

const task = (id: string, position: number, overrides: Partial<Task> = {}): Task => ({
  id,
  workspaceId: 'ws',
  ownerId: 'ada',
  title: `Title ${id}`,
  doneCriteria: 'done',
  status: 'open',
  paused: false,
  epoch: 0,
  evidence: [],
  position,
  pin: 0,
  revision: 1,
  createdAt: `2026-09-2${id}T00:00:00Z`,
  updatedAt: '2026-09-26T00:00:00Z',
  ...overrides,
});

const apply = (ordered: Task[], writes: { task: Task; position: number }[]) =>
  byPosition(
    ordered.map((t) => ({
      ...t,
      position: writes.find((w) => w.task.id === t.id)?.position ?? t.position,
    }))
  ).map((t) => t.id);

test('reordering tied top-level tasks renumbers them once, then moves write only the swapped pair', () => {
  // The crate creates every top-level task at position 0: creation order breaks the tie.
  const tied = byPosition([task('3', 0), task('1', 0), task('2', 0)]);
  assert.deepEqual(
    tied.map((t) => t.id),
    ['1', '2', '3']
  );
  const first = moveTask(tied, 2, -1);
  assert.deepEqual(apply(tied, first), ['1', '3', '2'], 'task 3 moved up one place');

  const numbered = [task('1', 0), task('3', 1), task('2', 2)];
  const second = moveTask(numbered, 0, 1);
  assert.deepEqual(
    second.map((w) => w.task.id).sort(),
    ['1', '3'],
    'a numbered list writes only the two swapped tasks'
  );
  assert.deepEqual(apply(numbered, second), ['3', '1', '2']);
});

test('the Work tab offers task creation and per-task reorder and pause controls', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <BuddyWork
        buddyId="ada"
        tasks={[task('1', 1), task('2', 0, { paused: true }), task('3', 0, { parentId: '1' })]}
        names={{}}
        refresh={async () => {}}
      />
    </MemoryRouter>
  );
  assert.match(html, /aria-label="New task"/);
  // Position order: task 2 (0) first, then task 1 (1); the todo stays inside its task.
  assert.ok(html.indexOf('Title 2') < html.indexOf('Title 1'));
  assert.doesNotMatch(html, /Title 3/);
  assert.match(html, /Paused/);
  assert.match(html, /href="[^"]*task=2"/);
  assert.match(html, /href="[^"]*task=1"/);
  assert.match(html, /Resume/, 'a paused task offers Resume');
  assert.match(html, /Pause</, 'a running task offers Pause');
  const [first] = html.split('Title 1');
  assert.match(first, /disabled="">Move up/, 'the first task cannot move up');
});
