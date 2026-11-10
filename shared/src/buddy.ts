import { z } from 'zod';
import { BuddyTeamStateSchema } from './buddy-team.js';
import { ProviderSchema } from './provider-catalog.js';

// Identity outlives Tasks and provider attempts; Worker mode reuses this Buddy model.
// Core rationale: ../../product/buddies/CORE_DESIGN.md#data-model-and-authority
export const BuddySummarySchema = z.object({
  id: z.string().min(1),
  project_id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  role: z.string().min(1),
  status: z.string().min(1),
  provider: ProviderSchema.nullable(),
  model: z.string().min(1).nullable(),
  reasoning_effort: z.string().min(1).nullable(),
});

export const BuddyWorkspaceSummarySchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  root_path: z.string().min(1),
  assignment_role: z.string().nullish(),
});

/** Saved work projection; the project store remains the authority for its current state. */
export const BuddyBuilderProjectSchema = z.object({
  id: z.string().min(1),
  buddy_id: z.string().min(1),
  workspace_id: z.string().min(1),
  parent_project_id: z.string().min(1).nullish(),
  title: z.string().min(1),
  objective: z.string().nullable(),
  definition_of_done: z.string().min(1),
  status: z.string().min(1),
  blocked_reason: z.string().nullable(),
  next_action: z.string().nullable(),
});
export type BuddyBuilderProject = z.infer<typeof BuddyBuilderProjectSchema>;

export const BuddyBuilderResultSchema = z.object({
  conversationId: z.string().min(1),
  creationKey: z.string().min(1).default('default'),
  buddy: BuddySummarySchema,
  homeWorkspace: BuddyWorkspaceSummarySchema,
  workspaces: z.array(BuddyWorkspaceSummarySchema),
  followUpQuestions: z.array(z.string().min(1)).default([]),
  teamState: BuddyTeamStateSchema.optional(),
  projects: z.array(BuddyBuilderProjectSchema).optional(),
  relationships: z
    .array(
      z.object({
        id: z.string(),
        from_buddy_id: z.string(),
        to_buddy_id: z.string(),
        kind: z.string(),
      })
    )
    .optional(),
});
export type BuddyBuilderResult = z.infer<typeof BuddyBuilderResultSchema>;

/** Successful Builder mutations, carried by the tool result into the transcript. */
export const BuddyBuilderEventSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('created'), result: BuddyBuilderResultSchema }),
  z.object({
    action: z.literal('updated'),
    result: BuddyBuilderResultSchema,
    revision: z.number().int().nonnegative(),
  }),
  z.object({
    action: z.literal('work_created'),
    result: BuddyBuilderResultSchema,
    project: BuddyBuilderProjectSchema,
  }),
]);
export type BuddyBuilderEvent = z.infer<typeof BuddyBuilderEventSchema>;

/** Unwrap provider/MCP result envelopes; failed tools never become success cards. */
export function parseBuddyBuilderToolResult(value: unknown, depth = 0): BuddyBuilderEvent | null {
  if (depth > 6) return null;
  if (typeof value === 'string') {
    try {
      return parseBuddyBuilderToolResult(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const block of value) {
      const event = parseBuddyBuilderToolResult(block, depth + 1);
      if (event) return event;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.isError || record.is_error || record.error) return null;
  const event = BuddyBuilderEventSchema.safeParse(record.buddyBuilderEvent);
  if (event.success) return event.data;
  if ('buddyBuilderEvent' in record) return null;
  // Creation results from older Builder transcripts already contain this projection.
  const legacy = BuddyBuilderResultSchema.safeParse(record);
  if (legacy.success) return { action: 'created', result: legacy.data };
  for (const key of ['structuredContent', 'content', 'text', 'result']) {
    const nested = parseBuddyBuilderToolResult(record[key], depth + 1);
    if (nested) return nested;
  }
  return null;
}

/** Host-issued launch receipt, preserved in live and hydrated tool output. */
export const BuddyWorkerThreadSchema = z.object({
  conversationId: z.string().min(1),
  buddyId: z.string().min(1),
  label: z.string().min(1),
});
export type BuddyWorkerThread = z.infer<typeof BuddyWorkerThreadSchema>;

export function parseBuddyWorkerToolResult(output: unknown): BuddyWorkerThread[] {
  const threads = new Map<string, BuddyWorkerThread>();
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 10) return;
    if (typeof value === 'string') {
      try {
        visit(JSON.parse(value), depth + 1);
      } catch {
        /* ordinary output */
      }
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.isError || record.is_error || record.error || record.preview) return;
    const thread = BuddyWorkerThreadSchema.safeParse(record.buddyWorkerThread);
    if (thread.success) threads.set(thread.data.conversationId, thread.data);
    for (const key of ['structuredContent', 'content', 'text', 'result', 'data'])
      if (key in record) visit(record[key], depth + 1);
  };
  visit(output);
  return [...threads.values()];
}
