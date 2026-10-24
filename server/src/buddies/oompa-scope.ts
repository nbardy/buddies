import type { BuddiesCore } from './core';
import type { BuddyGrant } from './grants';

type Task = Awaited<ReturnType<BuddiesCore['getTask']>>;
type Scope = NonNullable<BuddyGrant['oompa']>;

// Pattern: capability-grants (docs/patterns.md#capability-grants)
// An Oompa grant admits a task if its ID is in the explicit `taskIds`, or its canonical parentId
// chain reaches one of `rootTaskIds` (roots included). Ancestry is re-read per request, not
// frozen at launch: a child created under a root mid-run is admitted, a task moved out of the
// subtree is refused at once. Guard: oompa-mcp.test.ts "root task grant".
export async function oompaAdmits(core: BuddiesCore, scope: Scope, task: Task) {
  if (scope.taskIds.includes(task.id)) return true;
  const seen = new Set<string>();
  let at = task;
  while (!scope.rootTaskIds?.includes(at.id)) {
    if (!at.parentId || seen.has(at.id)) return false; // top-level, or a corrupt cycle
    seen.add(at.id);
    at = await core.getTask(at.parentId);
    if (at.workspaceId !== task.workspaceId) return false;
  }
  return true;
}

/** Explicit tasks, then the roots' current subtrees: one workspace list per shared Oompa scan. */
export async function oompaSelection(core: BuddiesCore, scope: Scope, workspaceId: string) {
  const explicit = await Promise.all(scope.taskIds.map((id) => core.getTask(id)));
  if (!scope.rootTaskIds?.length) return explicit;
  const all = await core.listTasks({ kind: 'workspace', workspaceId });
  const admitted = new Set(scope.rootTaskIds);
  // Fixpoint over parentId: the listing is not guaranteed parent-first.
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of all)
      if (t.parentId && admitted.has(t.parentId) && !admitted.has(t.id)) {
        admitted.add(t.id);
        grew = true;
      }
  }
  return [...explicit, ...all.filter((t) => admitted.has(t.id) && !scope.taskIds.includes(t.id))];
}
