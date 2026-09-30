import assert from 'node:assert/strict';
import { test } from 'node:test';
import { homeTasks, movePin, projectProgress } from '../src/components/buddies/home-view';
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

test('pins keep owner order, then recent projects; search finds any Task; grandchildren are not counted', () => {
  const at = (task: Task, updatedAt: string): Task => ({ ...task, updatedAt });
  const tasks = [
    at(task('p', 'open'), '2026-01-01'),
    at(task('q', 'open'), '2026-01-02'),
    at(task('lone', 'open'), '2026-09-01'), // newest, but no child Tasks: not a project
    at(task('old', 'open'), '2026-01-03'),
    at(task('c', 'done', 'p'), '2026-01-01'),
    at(task('g', 'open', 'c'), '2026-01-01'),
    at(task('oc', 'open', 'old'), '2026-05-01'), // a child's activity lifts its project
  ];
  const ids = (list: ReturnType<typeof homeTasks>) => list.map((entry) => entry.task.id);
  const home = homeTasks(['q', 'gone', 'p'], tasks, '');
  assert.deepEqual(ids(home), ['q', 'p', 'old']);
  assert.deepEqual(
    home.map((entry) => entry.pinned),
    [true, true, false]
  );
  assert.deepEqual(home[1]?.progress, {
    kind: 'counted', done: 1, total: 1, percent: 100, inProgress: 0, blocked: 0,
  });
  // A query reaches Tasks Home never lists by default (`lone`), and lists pinned matches first.
  assert.deepEqual(ids(homeTasks(['old'], tasks, 'O')), ['old', 'lone']);
  assert.deepEqual(movePin(['a', 'b', 'c'], 'c', -1), ['a', 'c', 'b']);
  assert.deepEqual(movePin(['a', 'b'], 'a', -1), ['a', 'b']);
});
