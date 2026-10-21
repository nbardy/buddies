import { z } from 'zod';
import type { BuddiesCore } from './core';

export const Portfolio = z
  .object({
    rootTaskIds: z.array(z.string().min(1)).min(1),
    ownerIds: z.array(z.string().min(1)).min(1),
    reviewerIds: z.array(z.string().min(1)).min(1),
  })
  .strict();
export type PortfolioPolicy = z.infer<typeof Portfolio>;
export const Prerequisite = z
  .object({
    kind: z.literal('prerequisite'),
    runId: z.string().min(1),
    parentTaskId: z.string().min(1),
    ownerId: z.string().min(1),
    role: z.enum(['consumer', 'review']),
    title: z.string().trim().min(1).max(500),
    doneCriteria: z.string().trim().min(1).max(8000),
  })
  .strict();
export const Amendment = z
  .object({
    kind: z.literal('amend'),
    runId: z.string().min(1),
    baseConfigSha256: z.string().regex(/^[a-f0-9]{64}$/),
    configPath: z.string().min(1),
    configSha256: z.string().regex(/^[a-f0-9]{64}$/),
    workspacePath: z.string().min(1),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    reviewTaskId: z.string().min(1),
    reviewRevision: z.number().int().positive(),
    taskRevisions: z.record(z.number().int().positive()),
  })
  .strict();
export const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item
  );

// Pattern: capability-grants (docs/patterns.md#capability-grants)
// Canonical ancestry, not names or model prose, bounds prerequisite admission.
export async function portfolioTask(
  core: BuddiesCore,
  policy: PortfolioPolicy,
  workspaceId: string,
  id: string
) {
  const task = await core.getTask(id);
  if (task.workspaceId !== workspaceId || !policy.ownerIds.includes(task.ownerId))
    throw new Error('task is outside approved portfolio ownership');
  const owner = await core.getBuddy(task.ownerId);
  if (owner.workspaceId !== workspaceId || owner.status === 'archived')
    throw new Error('portfolio task owner is no longer active');
  let cursor = task;
  const seen = new Set<string>();
  while (!policy.rootTaskIds.includes(cursor.id)) {
    if (seen.has(cursor.id) || !cursor.parentId)
      throw new Error('task is outside approved canonical roots');
    seen.add(cursor.id);
    cursor = await core.getTask(cursor.parentId);
    if (cursor.workspaceId !== workspaceId) throw new Error('foreign portfolio ancestry');
  }
  return task;
}

const without = (object: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));
export type PortfolioConfig = {
  task_backend: {
    task_ids: string[];
    owner_by_task?: Record<string, string>;
    dependencies?: Record<string, string[]>;
    buddy_id: string;
    [key: string]: unknown;
  };
  task_execution?: {
    validators: Record<string, { timeout_seconds: number; reconcile_on_rejection?: boolean }>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export function amendmentDelta(
  base: PortfolioConfig,
  next: PortfolioConfig,
  executed: Set<string>
) {
  if (
    stable(without(base, ['task_backend', 'task_execution', 'resume_swarm_id'])) !==
      stable(without(next, ['task_backend', 'task_execution', 'resume_swarm_id'])) ||
    stable(without(base.task_backend, ['task_ids', 'owner_by_task', 'dependencies'])) !==
      stable(without(next.task_backend, ['task_ids', 'owner_by_task', 'dependencies'])) ||
    stable(
      without(base.task_execution ?? {}, [
        'validators',
        'task_readiness',
        'prepare_only_task_ids',
        'owner_window',
      ])
    ) !==
      stable(
        without(next.task_execution ?? {}, [
          'validators',
          'task_readiness',
          'prepare_only_task_ids',
          'owner_window',
        ])
      )
  )
    throw new Error('amendment changes frozen harness, model, spend or task budget controls');
  if (next.resume_swarm_id !== undefined || next.task_execution?.owner_window !== undefined)
    throw new Error('resume identity and owner window are host-owned');
  const ids = new Set(next.task_backend.task_ids);
  for (const id of base.task_backend.task_ids) {
    if (!ids.has(id)) throw new Error('amendment cannot discard existing tasks or histories');
    const beforeOwner = base.task_backend.owner_by_task?.[id] ?? base.task_backend.buddy_id;
    const afterOwner = next.task_backend.owner_by_task?.[id] ?? next.task_backend.buddy_id;
    if (beforeOwner !== afterOwner) throw new Error('amendment cannot change approved task owner');
    for (const dependency of base.task_backend.dependencies?.[id] ?? [])
      if (!(next.task_backend.dependencies?.[id] ?? []).includes(dependency))
        throw new Error('amendment cannot remove existing acceptance dependencies');
  }
  for (const [id, deps] of Object.entries(next.task_backend.dependencies ?? {}))
    if (!ids.has(id) || deps.some((dep) => !ids.has(dep)))
      throw new Error('dependency outside admitted graph');
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) throw new Error('cyclic prerequisite graph');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of next.task_backend.dependencies?.[id] ?? []) visit(dep);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of ids) visit(id);
  const oldValidators = base.task_execution?.validators ?? {};
  const newValidators = next.task_execution?.validators ?? {};
  const changed = Object.keys(newValidators).filter(
    (id) =>
      stable(without(oldValidators[id] ?? {}, ['reconcile_on_rejection'])) !==
      stable(without(newValidators[id], ['reconcile_on_rejection']))
  );
  for (const id of Object.keys(oldValidators))
    if (
      oldValidators[id].reconcile_on_rejection === true &&
      newValidators[id]?.reconcile_on_rejection !== true
    )
      throw new Error('cannot weaken rejection reconciliation control');
  for (const id of Object.keys(oldValidators))
    if (!newValidators[id]) throw new Error('amendment cannot remove an existing validator');
  for (const id of changed) {
    if (!ids.has(id) || executed.has(id)) throw new Error('cannot repin an executed or held task');
    if (newValidators[id].timeout_seconds > (oldValidators[id]?.timeout_seconds ?? 600))
      throw new Error('validator amendment exceeds approved timeout');
  }
  const oldPrepare = (base.task_execution?.prepare_only_task_ids ?? []) as string[];
  const newPrepare = (next.task_execution?.prepare_only_task_ids ?? []) as string[];
  for (const id of oldPrepare)
    if (!newPrepare.includes(id)) throw new Error('cannot change existing preparation mode');
  for (const id of newPrepare)
    if (!ids.has(id) || (!oldPrepare.includes(id) && base.task_backend.task_ids.includes(id)))
      throw new Error('cannot downgrade an existing consumer to preparation');
  const readiness = z
    .record(
      z
        .object({
          blocker_class: z.enum(['internal', 'external', 'acceptance']),
          reason_code: z.string().min(1),
          required_owner: z.string().min(1),
          next_action: z.string().min(1),
          role: z.enum(['consumer', 'observed']).optional(),
        })
        .strict()
    )
    .parse(next.task_execution?.task_readiness ?? {});
  for (const id of ids)
    if (!base.task_backend.task_ids.includes(id) && readiness[id]?.blocker_class !== 'internal')
      throw new Error('new executable prerequisites require reviewed internal classification');
  for (const [id, item] of Object.entries(readiness))
    if (
      item.role === 'observed' &&
      !base.task_backend.task_ids.includes(id) &&
      (newValidators[id] || newPrepare.includes(id))
    )
      throw new Error('observed prerequisites cannot fabricate an executable consumer');
  for (const [id, old] of Object.entries(
    (base.task_execution?.task_readiness ?? {}) as Record<
      string,
      { blocker_class: string; role?: string }
    >
  ))
    if (old.blocker_class !== 'internal' && stable(old) !== stable(readiness[id]))
      throw new Error('cannot loosen existing external or human acceptance boundaries');
  return { changed, readiness };
}
