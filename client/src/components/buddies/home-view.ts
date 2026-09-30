/**
 * client/src/components/buddies/home-view.ts
 *
 * The workspace Home's derived facts, pure so both shells share them (gate G3) and the counting
 * rules are testable. Rules are the owner-approved brief
 * (agent_notes/2026-09-30_workspace-landing-product-brief.md):
 *   - progress = done / (immediate child todos − cancelled); ONLY `done` counts toward the %;
 *   - review, blocked and in-progress todos are unfinished; nested descendants are not counted;
 *   - no todos → "No todos yet", all cancelled → "No active todos", never a made-up 0%.
 */
import type { FollowedThread, Post, Task } from './types';

/** A pinned project's checklist. D = NoTodos ⊕ NoActive ⊕ Counted. */
export type ProjectProgress =
  | { kind: 'none' }
  | { kind: 'no_active' }
  | {
      kind: 'counted';
      done: number;
      total: number;
      percent: number;
      inProgress: number;
      blocked: number;
    };

export function projectProgress(children: readonly Task[]): ProjectProgress {
  if (children.length === 0) return { kind: 'none' };
  const active = children.filter((task) => task.status !== 'cancelled');
  if (active.length === 0) return { kind: 'no_active' };
  const done = active.filter((task) => task.status === 'done').length;
  return {
    kind: 'counted',
    done,
    total: active.length,
    percent: Math.round((done / active.length) * 100),
    inProgress: active.filter((task) => task.status === 'in_progress').length,
    blocked: active.filter((task) => task.status === 'blocked').length,
  };
}

/** One Task card on Home: a top-level Task, its checklist progress, and whether the owner pinned it. */
export type HomeTask = {
  task: Task;
  progress: ProjectProgress;
  pinned: boolean;
  /** Has child Tasks: what the owner calls a "project". Derived, never stored (no Project type). */
  project: boolean;
};

/** Recent projects offered beside the pins when the search box is empty. */
export const RECENT_PROJECTS = 8;

/**
 * The Home's Task list. Empty query: the pins (`Task.pin`, server-stored, shared by the owner and
 * every Buddy) in ascending order, then the most recently
 * active UNFINISHED unpinned PROJECTS (top-level Tasks that have child Tasks; activity = newest update of the
 * Task or any child). A query: every top-level Task whose title, next action or blocked reason
 * contains every word, pinned first, then by activity; the owner pins from these results.
 */
export function homeTasks(tasks: readonly Task[], query: string): readonly HomeTask[] {
  const children = new Map<string, Task[]>();
  for (const task of tasks) {
    if (task.parentId === undefined) continue;
    children.set(task.parentId, [...(children.get(task.parentId) ?? []), task]);
  }
  const pinnedTasks = pinOrder(tasks);
  const pinned = new Set(pinnedTasks.map((task) => task.id));
  const card = (task: Task): HomeTask => {
    const own = children.get(task.id) ?? [];
    return {
      task,
      progress: projectProgress(own),
      pinned: pinned.has(task.id),
      project: own.length > 0,
    };
  };
  const activity = (task: Task) =>
    [task, ...(children.get(task.id) ?? [])].reduce(
      (newest, entry) => (entry.updatedAt > newest ? entry.updatedAt : newest),
      ''
    );
  const newestFirst = (a: Task, b: Task) => (activity(a) < activity(b) ? 1 : -1);
  const topLevel = tasks.filter((task) => task.parentId === undefined);
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length > 0) {
    const matches = (task: Task) => {
      const text =
        `${task.title} ${task.nextAction ?? ''} ${task.blockedReason ?? ''}`.toLowerCase();
      return words.every((word) => text.includes(word));
    };
    return topLevel
      .filter(matches)
      .sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)) || newestFirst(a, b))
      .map(card);
  }
  const mine = pinnedTasks;
  const recent = topLevel
    .filter(
      (task) =>
        !pinned.has(task.id) &&
        task.status !== 'done' &&
        task.status !== 'cancelled' &&
        (children.get(task.id)?.length ?? 0) > 0
    )
    .sort(newestFirst)
    .slice(0, RECENT_PROJECTS);
  return [...mine, ...recent].map(card);
}

/** The pinned top-level Tasks, ascending by `pin` (ties by title, so agents' equal keys stay stable). */
export function pinOrder(tasks: readonly Task[]): readonly Task[] {
  return tasks
    .filter((task) => task.parentId === undefined && task.pin > 0)
    .sort((a, b) => a.pin - b.pin || a.title.localeCompare(b.title));
}

/** One `task_write` update: set `task.pin` to `pin` (0 unpins). */
export type PinWrite = { task: Task; pin: number };

/** Pin at the end of the list. */
export function appendPin(tasks: readonly Task[], task: Task): readonly PinWrite[] {
  const last = pinOrder(tasks).reduce((max, entry) => Math.max(max, entry.pin), 0);
  return [{ task, pin: last + 1 }];
}

export function unpin(task: Task): readonly PinWrite[] {
  return [{ task, pin: 0 }];
}

/**
 * Move a pin one place. Rewrites the order as dense ranks 1..n and returns only the Tasks whose
 * key changes, so a list with gaps or ties (Buddies choose their own keys) settles into a clean one.
 */
export function movePin(tasks: readonly Task[], task: Task, delta: -1 | 1): readonly PinWrite[] {
  const order = [...pinOrder(tasks)];
  const from = order.findIndex((entry) => entry.id === task.id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= order.length) return [];
  order.splice(to, 0, ...order.splice(from, 1));
  return order.flatMap((entry, index): PinWrite[] =>
    entry.pin === index + 1 ? [] : [{ task: entry, pin: index + 1 }]
  );
}

/**
 * A device's retired pins (saved before pins moved to the server), appended after the current pins
 * in their saved order. A saved id that is now pinned, a subtask, or gone is skipped: importing
 * never reorders or duplicates what the owner and Buddies already pinned.
 */
export function importPins(
  tasks: readonly Task[],
  savedIds: readonly string[]
): readonly PinWrite[] {
  const unpinned = new Map(
    tasks
      .filter((task) => task.parentId === undefined && task.pin === 0)
      .map((task) => [task.id, task] as const)
  );
  const last = pinOrder(tasks).reduce((max, entry) => Math.max(max, entry.pin), 0);
  return [...new Set(savedIds)]
    .flatMap((id) => unpinned.get(id) ?? [])
    .map((task, index) => ({ task, pin: last + 1 + index }));
}

/** The newest post a card shows: its latest reply, else the root. */
export function threadLatest(thread: FollowedThread): Post {
  return thread.tail.posts.at(-1) ?? thread.root;
}

/** Followed threads, newest activity first (the server orders unread first, which is not "recent"). */
export function recentThreads(
  threads: readonly FollowedThread[],
  limit: number
): readonly FollowedThread[] {
  return [...threads]
    .sort((a, b) => (threadLatest(a).ord < threadLatest(b).ord ? 1 : -1))
    .slice(0, limit);
}

/** The opening words of a post: markdown images and link syntax stripped, whitespace collapsed. */
export function excerpt(body: string, max: number): string {
  const text = body
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** The first markdown image path in a post, the card's preview. */
export function firstImage(body: string): string | null {
  return /!\[[^\]]*\]\(([^)\s]+)\)/.exec(body)?.[1] ?? null;
}
