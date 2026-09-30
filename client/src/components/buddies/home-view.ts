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

/** What the card says to do next: the stored blocked reason / next action, else the first unfinished todo. */
export function projectNext(parent: Task, children: readonly Task[]): string | null {
  if (parent.blockedReason) return `Blocked: ${parent.blockedReason}`;
  if (parent.nextAction) return parent.nextAction;
  const next = children
    .filter((task) => task.status !== 'done' && task.status !== 'cancelled')
    .sort((a, b) => a.position - b.position)[0];
  return next ? next.title : null;
}

export type PinnedProject = {
  task: Task;
  progress: ProjectProgress;
  next: string | null;
};

/**
 * The pinned Tasks in the owner's order. A pin whose Task is gone (deleted, or not loaded yet)
 * is skipped, never rendered blank; the stored id stays so a slow load does not unpin it.
 */
export function pinnedProjects(
  pinIds: readonly string[],
  tasks: readonly Task[]
): readonly PinnedProject[] {
  const byId = new Map(tasks.map((task) => [task.id, task] as const));
  const children = new Map<string, Task[]>();
  for (const task of tasks) {
    if (task.parentId === undefined) continue;
    children.set(task.parentId, [...(children.get(task.parentId) ?? []), task]);
  }
  return pinIds.flatMap((id): PinnedProject[] => {
    const task = byId.get(id);
    if (task === undefined || task.parentId !== undefined) return [];
    const own = children.get(id) ?? [];
    return [{ task, progress: projectProgress(own), next: projectNext(task, own) }];
  });
}

/** Top-level Tasks not yet pinned: unfinished first, then those with a checklist, then newest. */
export function pinnable(pinIds: readonly string[], tasks: readonly Task[]): readonly Task[] {
  const pinned = new Set(pinIds);
  const todos = new Map<string, number>();
  for (const task of tasks) {
    if (task.parentId !== undefined) todos.set(task.parentId, (todos.get(task.parentId) ?? 0) + 1);
  }
  const finished = (task: Task) => (task.status === 'done' || task.status === 'cancelled' ? 1 : 0);
  const listed = (task: Task) => ((todos.get(task.id) ?? 0) > 0 ? 0 : 1);
  return tasks
    .filter((task) => task.parentId === undefined && !pinned.has(task.id))
    .sort(
      (a, b) =>
        finished(a) - finished(b) ||
        listed(a) - listed(b) ||
        (a.updatedAt < b.updatedAt ? 1 : -1)
    );
}

/** Move one id `delta` places, clamped; the same list when it is absent. */
export function movePin(ids: readonly string[], id: string, delta: -1 | 1): string[] {
  const from = ids.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return [...ids];
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
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
