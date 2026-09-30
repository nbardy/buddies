import assert from 'node:assert/strict';
import { test } from 'node:test';
import { movePin, pinnedProjects, projectProgress } from '../src/components/buddies/home-view';
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

test('a pin keeps its owner order, skips a missing Task and never counts grandchildren', () => {
  const tasks = [task('p', 'open'), task('q', 'open'), task('c', 'done', 'p'), task('g', 'open', 'c')];
  const projects = pinnedProjects(['q', 'gone', 'p'], tasks);
  assert.deepEqual(
    projects.map((project) => project.task.id),
    ['q', 'p']
  );
  assert.deepEqual(projects[1]?.progress, {
    kind: 'counted', done: 1, total: 1, percent: 100, inProgress: 0, blocked: 0,
  });
  assert.deepEqual(movePin(['a', 'b', 'c'], 'c', -1), ['a', 'c', 'b']);
  assert.deepEqual(movePin(['a', 'b'], 'a', -1), ['a', 'b']);
});
