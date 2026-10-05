import type { Task } from '@unleashd/buddies-core';
import type { BuddyMutationInput } from '@unleashd/shared';
import { buddyWrite } from './api';

/**
 * Display order for siblings (top-level tasks, or one task's todos): `position`, then creation.
 * The crate creates every top-level task at position 0, so creation order breaks those ties until
 * the owner first reorders.
 */
export const byPosition = (tasks: readonly Task[]): Task[] =>
  [...tasks].sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));

/**
 * The writes that move `ordered[from]` one place up (-1) or down (+1): every sibling's position
 * becomes its index in the new order, and only the siblings whose position changes are written.
 * The first move renumbers a list of tied zeros; later moves write two tasks.
 */
export function moveTask(
  ordered: readonly Task[],
  from: number,
  delta: -1 | 1
): { task: Task; position: number }[] {
  const to = from + delta;
  const next = [...ordered];
  [next[from], next[to]] = [next[to], next[from]];
  return next.flatMap((task, position) => (task.position === position ? [] : [{ task, position }]));
}

export const patchTask = (task: Task, changes: BuddyMutationInput<'task.update'>['changes']) =>
  buddyWrite('task.update', { taskId: task.id }, { baseRevision: task.revision, changes });

// Passing a move entry as changes included `task` and rejected every reorder.
// Guard: client task reorder over owner HTTP (buddies-v2.test.ts).
export function reorderTasks(ordered: readonly Task[], from: number, delta: -1 | 1) {
  return Promise.all(
    moveTask(ordered, from, delta).map(({ task, position }) => patchTask(task, { position }))
  );
}
