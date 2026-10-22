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
// Pattern: capability-grants (docs/patterns.md#capability-grants)
// An owner fixes the complete scaling authority at launch; absence grants none.
export const ScaleEnvelope = z
  .object({
    maxWorkers: z.number().int().positive(),
    models: z.array(z.string().min(1)).min(1),
    maxGpuWorkers: z.number().int().nonnegative(),
  })
  .strict();
export type ScaleEnvelopePolicy = z.infer<typeof ScaleEnvelope>;
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
    ownerScale: z.literal(true).optional(),
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

// Pattern: pure-core (docs/patterns.md#pure-core)
// Owner scale changes only allocation fields; budget and policy fields still compare exactly.
// Guard: oompa-mcp owner-only scale amendment, including scheduled receipt replay denial.
function scaleDelta(base: PortfolioConfig, next: PortfolioConfig, envelope?: ScaleEnvelopePolicy) {
  const worker = z
    .object({
      model: z.string().min(1),
      prompt: z.array(z.string().min(1)).min(1),
      count: z.number().int().positive(),
      can_claim_gpu: z.boolean(),
      task_ids: z.array(z.string().min(1)).optional(),
    })
    .passthrough();
  const before = z.array(worker).min(1).parse(base.workers);
  const after = z.array(worker).min(1).parse(next.workers);
  const allocation = envelope
    ? ['model', 'count', 'can_claim_gpu', 'task_ids']
    : ['model', 'prompt', 'count', 'can_claim_gpu', 'task_ids'];
  const controls = stable(without(before[0], allocation));
  if ([...before, ...after].some((item) => stable(without(item, allocation)) !== controls))
    throw new Error('owner scale cannot change worker task, runtime or spend controls');
  const count = after.reduce((sum, item) => sum + item.count, 0);
  const gpuCount = after
    .filter((item) => item.can_claim_gpu)
    .reduce((sum, item) => sum + item.count, 0);
  if (envelope) {
    if (count > envelope.maxWorkers)
      throw new Error(
        `scale envelope maxWorkers exceeded (agent count/subscription load): ${count} > ${envelope.maxWorkers}`
      );
    if (gpuCount > envelope.maxGpuWorkers)
      throw new Error(
        `scale envelope maxGpuWorkers exceeded: ${gpuCount} > ${envelope.maxGpuWorkers}`
      );
    for (const item of after)
      if (!envelope.models.includes(item.model))
        throw new Error(`scale envelope model not listed: ${item.model}`);
  } else if (count > 6 || gpuCount > 1)
    throw new Error('owner scale permits at most six workers and one GPU worker');
  const ids = new Set(next.task_backend.task_ids);
  for (const item of after)
    if (item.task_ids?.some((id) => !ids.has(id)))
      throw new Error('owner scale worker task outside admitted graph');
  const reviewer = z
    .object({ model: z.string().min(1), prompt: z.array(z.string().min(1)).min(1) })
    .passthrough();
  const oldReview = z.array(reviewer).length(1).parse(base.reviewers);
  const newReview = z.array(reviewer).length(1).parse(next.reviewers);
  const reviewerAllocation = envelope ? ['model'] : ['model', 'prompt'];
  if (
    stable(without(oldReview[0], reviewerAllocation)) !==
    stable(without(newReview[0], reviewerAllocation))
  )
    throw new Error('owner scale cannot change reviewer controls');
  if (envelope && !envelope.models.includes(newReview[0].model))
    throw new Error(`scale envelope reviewer model not listed: ${newReview[0].model}`);
}

export function amendmentDelta(
  base: PortfolioConfig,
  next: PortfolioConfig,
  executed: Set<string>,
  ownerScale = false,
  scaleEnvelope?: ScaleEnvelopePolicy
) {
  if (
    (ownerScale || scaleEnvelope) &&
    (stable(base.workers) !== stable(next.workers) ||
      stable(base.reviewers) !== stable(next.reviewers))
  )
    scaleDelta(base, next, ownerScale ? undefined : scaleEnvelope);
  const mutable = [
    'task_backend',
    'task_execution',
    'resume_swarm_id',
    ...(ownerScale || scaleEnvelope ? ['workers', 'reviewers'] : []),
  ];
  if (
    stable(without(base, mutable)) !== stable(without(next, mutable)) ||
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
