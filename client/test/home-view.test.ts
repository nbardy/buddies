import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appendPin,
  homeTasks,
  importPins,
  movePin,
  projectProgress,
} from '../src/components/buddies/home-view';
import type { Task, TaskStatus } from '../src/components/buddies/types';

const task = (id: string, status: TaskStatus, parentId?: string): Task => ({
  id,
  workspaceId: 'w',
  ownerId: 'b',
  ...(parentId ? { parentId } : {}),
  title: id,
  doneCriteria: '',
  status,
  paused: false,
  epoch: 0,
  evidence: [],
  position: 0,
  pin: 0,
  revision: 1,
  createdAt: '',
  updatedAt: '',
});

// Owner rule (2026-09-30): only `done` counts; review/blocked/in-progress are unfinished and
// cancelled todos leave the denominator. A fully coloured bar must still read 60%, not 100%.
test('progress counts only done over non-cancelled todos', () => {
  const todos = [
    task('a', 'done', 'p'),
    task('b', 'done', 'p'),
    task('c', 'done', 'p'),
    task('d', 'in_progress', 'p'),
    task('e', 'blocked', 'p'),
    task('f', 'cancelled', 'p'),
  ];
  assert.deepEqual(projectProgress(todos), {
    kind: 'counted',
    done: 3,
    total: 5,
    percent: 60,
    inProgress: 1,
    blocked: 1,
  });
  assert.equal(projectProgress([]).kind, 'none');
  assert.equal(projectProgress([task('x', 'cancelled', 'p')]).kind, 'no_active');
});

test('pins keep their order, then recent projects; search finds any Task; grandchildren are not counted', () => {
  const at = (task: Task, updatedAt: string, pin = 0): Task => ({ ...task, updatedAt, pin });
  const tasks = [
    at(task('p', 'open'), '2026-01-01', 2),
    at(task('q', 'open'), '2026-01-02', 1),
    at(task('lone', 'open'), '2026-09-01'), // newest, but no child Tasks: not a project
    at(task('old', 'open'), '2026-01-03'),
    at(task('c', 'done', 'p'), '2026-01-01'),
    at(task('g', 'open', 'c'), '2026-01-01'),
    at(task('oc', 'open', 'old'), '2026-05-01'), // a child's activity lifts its project
  ];
  const ids = (list: ReturnType<typeof homeTasks>) => list.map((entry) => entry.task.id);
  const home = homeTasks(tasks, '');
  assert.deepEqual(ids(home), ['q', 'p', 'old']);
  assert.deepEqual(
    home.map((entry) => entry.pinned),
    [true, true, false]
  );
  assert.deepEqual(home[1]?.progress, {
    kind: 'counted',
    done: 1,
    total: 1,
    percent: 100,
    inProgress: 0,
    blocked: 0,
  });
  // A query reaches Tasks Home never lists by default (`lone`); matches sort newest activity first.
  assert.deepEqual(ids(homeTasks(tasks, 'O')), ['lone', 'old']);
  // Pinned matches sort ahead of newer unpinned ones.
  assert.deepEqual(ids(homeTasks(tasks, 'p')), ['p']);
});

// Buddies choose their own pin keys through task_write, so keys can have gaps and ties. A move
// rewrites dense ranks (only the Tasks that change), and an append lands after the largest key.
test('moving a pin renumbers a gappy, tied list and appending goes last', () => {
  const pinned = (id: string, pin: number): Task => ({ ...task(id, 'open'), pin });
  const tasks = [pinned('a', 5), pinned('b', 5), pinned('c', 9), task('d', 'open')];
  const byId = (id: string) => tasks.find((entry) => entry.id === id) as Task;
  // Order a, b (tie broken by title), c. Moving c earlier: a, c, b -> ranks 1, 2, 3.
  assert.deepEqual(
    movePin(tasks, byId('c'), -1).map((write) => [write.task.id, write.pin]),
    [
      ['a', 1],
      ['c', 2],
      ['b', 3],
    ]
  );
  assert.deepEqual(movePin(tasks, byId('a'), -1), []);
  assert.deepEqual(
    appendPin(tasks, byId('d')).map((write) => write.pin),
    [10]
  );
});

// A device's pins saved before server pins import AFTER the shared ones, in saved order. A saved
// id that a Buddy already pinned, a todo, or a deleted Task must not be written: re-pinning an
// already-pinned Task would move it to the end and silently reorder the owner's list.
test('importing retired device pins appends in saved order and skips pinned, todos and missing', () => {
  const tasks = [
    { ...task('shared', 'open'), pin: 4 },
    task('x', 'open'),
    task('y', 'done'),
    task('todo', 'open', 'x'),
  ];
  assert.deepEqual(
    importPins(tasks, ['y', 'shared', 'gone', 'todo', 'x', 'y']).map((write) => [
      write.task.id,
      write.pin,
    ]),
    [
      ['y', 5],
      ['x', 6],
    ]
  );
});
