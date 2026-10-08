import type {
  Buddy,
  Channel,
  Doc,
  Post,
  Run,
  RunWaiting,
  Schedule,
  Task,
  Workspace,
} from '@unleashd/buddies-core';
import { z } from 'zod';
import { OwnerPostMentionConfigSchema } from './buddy-channel-posts.js';
import { ConversationConfigSchema } from './conversation-config.js';
import type { UpstreamUpdateResult } from './upstream.js';

// Pattern: one-type-source (docs/patterns.md#one-type-source)
// Retry and New chat rejected UI-added keys because their HTTP bodies were not shared.
// Guard: buddies-v2.test.ts exercises the real client writer over owner HTTP.
export const key = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe('A retried key replays the first result');
export const ChannelArchiveSchema = z.object({ archived: z.boolean(), key }).strict();
export const ChannelRenameSchema = z
  .object({ name: z.string().trim().min(1).max(80), key })
  .strict();

export const evidence = z.array(z.string().min(1).max(4000)).max(32).default([]);

export const TaskChangesSchema = z.object({
  title: z.string().optional(),
  doneCriteria: z.string().optional(),
  status: z.enum(['open', 'in_progress', 'blocked', 'review', 'done', 'cancelled']).optional(),
  nextAction: z.string().optional(),
  blockedReason: z.string().optional(),
  evidence: z.array(z.string()).optional(),
  paused: z.boolean().optional(),
  position: z.number().int().optional(),
  // Home pin: 0 unpins, N > 0 pins at order N (lower = earlier); top-level Tasks only (the crate refuses others).
  pin: z.number().int().min(0).optional(),
  ownerId: z.string().optional(),
});

export const ScheduleFieldsSchema = z.object({
  taskId: z.string().min(1).optional(),
  name: z.string().min(1).max(120),
  cron: z.string().min(1),
  timezone: z.string().min(1),
  prompt: z.string().min(1).max(16_000),
  enabled: z.boolean(),
});

const profile = z.string().min(1).nullable().optional().describe('null: back to the default');
export const BuddyCreateFieldsSchema = z.object({
  workspaceId: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  role: z.string().min(1),
  managerId: z.string().min(1).nullable().optional(),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  reasoningEffort: z.string().min(1).optional(),
});
export const BuddyChangesSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  managerId: z.string().min(1).nullable().optional().describe('null: reports to nobody'),
  provider: profile,
  model: profile,
  reasoningEffort: profile,
  maxActiveRuns: z.number().int().positive().optional(),
  status: z.enum(['active', 'archived']).optional(),
});

export const BuddyPatchSchema = BuddyChangesSchema.extend({ key }).strict();
export const BuddyCreateSchema = BuddyCreateFieldsSchema.extend({ key }).strict();
export const TaskCreateSchema = z
  .object({
    ownerId: z.string().min(1),
    parentId: z.string().min(1).optional(),
    title: z.string().min(1),
    doneCriteria: z.string().min(1),
    key,
  })
  .strict();
export const TaskUpdateSchema = z
  .object({ baseRevision: z.number().int().positive(), changes: TaskChangesSchema.strict(), key })
  .strict();
export const PostBodySchema = z
  .object({
    body: z.string().trim().min(1).max(32_000),
    kind: z.enum(['inform', 'request']).default('inform'),
    replyToId: z.string().min(1).optional(),
    // Fix-guard: the owner rejected channel broadcast replies (2026-09-29).
    // Reject old clients that still request one; new replies stay in their thread.
    broadcast: z.literal(false).default(false),
    taskId: z.string().min(1).optional(),
    purpose: z.string().trim().min(1).max(200).optional(),
    evidence,
    mentionConfigs: z.array(OwnerPostMentionConfigSchema).max(32).default([]),
    // The owner writes as one of its Buddies (a standup, a handoff), as the Messages tab did before
    // T11. The crate authorizes the Buddy as the author; its @mentions start as that Buddy's.
    asBuddyId: z.string().min(1).optional(),
    // Answers one request the poster owes: the post lands in that request's thread, so it takes only
    // body, evidence and key (the server refuses the rest rather than dropping them silently).
    answers: z.string().min(1).optional(),
    key,
  })
  .strict();
export const DocWriteSchema = z
  .object({
    scope: z.enum(['buddy', 'workspace']).default('buddy'),
    scopeId: z.string().min(1).optional(),
    name: z.string().default(''),
    content: z.string().max(40_000),
    baseRevision: z.number().int().nonnegative(),
    reason: z.string().min(1),
    key,
  })
  .strict();
export const ScheduleSchema = ScheduleFieldsSchema.extend({ key }).strict();
export const WorkspaceSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    rootPath: z.string().trim().min(1),
  })
  .strict();
// Slack "New Buddy" names the workspace on screen. Until 2026-09-27 the route
// ignored the body and the Builder always opened in the unleashd checkout, so
// a hire from Paint Live still landed in ~/git/unleashd. Guard: buddies-v2
// "builder opened from a workspace uses that workspace root".
export const BuilderOpenSchema = z.object({ workspaceId: z.string().min(1).optional() }).strict();

export const ChannelSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    purpose: z.string().trim().min(1).max(500),
    key,
  })
  .strict();
// buddyWrite includes `key`: rejecting it blocked every model retry before dispatch (2026-10-05).
// The channel pair already coalesces queued/running retries; guard: keyed retry over owner HTTP.
export const RetrySchema = z.object({ config: ConversationConfigSchema, key }).strict();
export const NewDirectSchema = z
  .object({
    config: ConversationConfigSchema.optional(),
    message: z.string().trim().min(1).max(100_000).optional(),
    // buddyWrite stamps every body with a `key`; .strict() rejected it as an unknown key (ZodError
    // on every "New chat" from the client, 2026-09-30). Accepted, not used: each call opens a chat.
    key,
  })
  .strict();
// One read mark for both feeds: a channel's, or a followed thread's (which leaves the channel's
// cursor alone). `postId` is the newest post the client rendered; a later one stays unread.
export const ReadSchema = z.union([
  z.object({ channelId: z.string().min(1), postId: z.string().min(1) }).strict(),
  z.object({ rootId: z.string().min(1), postId: z.string().min(1) }).strict(),
]);

/**
 * The turn id of a schedule's fire (crate runs.rs `fire_slot` writes `schedule:<id>:<slot>`): the
 * Schedules panel finds a schedule's runs by this prefix.
 */
export const scheduleTurnPrefix = (scheduleId: string): string => `schedule:${scheduleId}:`;

// Wake is silent (owner, 2026-10-07): this text is queued into the ongoing owner chat, no post.
export const WAKE_MESSAGE = [
  'Wake-up check: catch up on the workspace channels and act on what matters to you.',
  '1. Call inbox: requests you owe, and every channel with your unread count.',
  '2. Read each channel with unread posts with channel_read (reading from the top marks it read); open threads with channel_read({read:{threadId}}).',
  '3. For each thing that concerns you: answer it in its thread (post with replyToId) when a reply helps, create/update the work (task_write) and comment via post {channel:{task}}, hand it to its owner (post a request in a DM), or leave it.',
  '4. Finish with a short summary: what you read, what you replied to, what work you started (with ids).',
].join('\n');

const NoBodySchema = z.undefined();
export const BuddyDocKindSchema = z.enum(['soul', 'working', 'long_term', 'shared']);
// Pattern: table-driven (docs/patterns.md#table-driven)
// This table owns the wire: client paths, methods and bodies; server routes and success statuses.
export const buddyMutations = {
  'workspace.create': {
    method: 'POST',
    path: '/api/buddies/workspaces',
    status: 201,
    body: WorkspaceSchema,
  },
  'builder.open': {
    method: 'POST',
    path: '/api/buddies/builder',
    status: 201,
    body: BuilderOpenSchema,
  },
  'buddy.create': { method: 'POST', path: '/api/buddies', status: 201, body: BuddyCreateSchema },
  'buddy.update': {
    method: 'PATCH',
    path: '/api/buddies/:buddyId',
    status: 200,
    body: BuddyPatchSchema,
  },
  'buddy.archive': {
    method: 'DELETE',
    path: '/api/buddies/:buddyId',
    status: 200,
    body: NoBodySchema,
  },
  'direct.open': {
    method: 'POST',
    path: '/api/buddies/:buddyId/direct',
    status: 200,
    body: NoBodySchema,
  },
  'direct.new': {
    method: 'POST',
    path: '/api/buddies/:buddyId/direct/new-chat',
    status: 200,
    body: NewDirectSchema,
  },
  'buddy.wake': {
    method: 'POST',
    path: '/api/buddies/:buddyId/wake',
    status: 202,
    body: NoBodySchema,
  },
  'doc.write': {
    method: 'PUT',
    path: '/api/buddies/:buddyId/docs/:kind',
    status: 200,
    body: DocWriteSchema,
  },
  'task.create': {
    method: 'POST',
    path: '/api/buddies/tasks',
    status: 201,
    body: TaskCreateSchema,
  },
  'task.update': {
    method: 'PATCH',
    path: '/api/buddies/tasks/:taskId',
    status: 200,
    body: TaskUpdateSchema,
  },
  'run.cancel': {
    method: 'POST',
    path: '/api/buddies/runs/:runId/cancel',
    status: 200,
    body: NoBodySchema,
  },
  'schedule.create': {
    method: 'POST',
    path: '/api/buddies/:buddyId/schedules',
    status: 201,
    body: ScheduleSchema,
  },
  'schedule.update': {
    method: 'PUT',
    path: '/api/buddies/:buddyId/schedules/:scheduleId',
    status: 200,
    body: ScheduleSchema,
  },
  'schedule.run': {
    method: 'POST',
    path: '/api/buddies/:buddyId/schedules/:scheduleId/run',
    status: 202,
    body: NoBodySchema,
  },
  'channel.archive': {
    method: 'POST',
    path: '/api/buddies/channels/:channelId/archive',
    status: 200,
    body: ChannelArchiveSchema,
  },
  'channel.rename': {
    method: 'POST',
    path: '/api/buddies/channels/:channelId/rename',
    status: 200,
    body: ChannelRenameSchema,
  },
  'channel.create': {
    method: 'POST',
    path: '/api/buddies/workspaces/:workspaceId/channels',
    status: 201,
    body: ChannelSchema,
  },
  'channel.post': {
    method: 'POST',
    path: '/api/buddies/channels/:channelId/posts',
    status: 201,
    body: PostBodySchema,
  },
  'reply.retry': {
    method: 'POST',
    path: '/api/buddies/posts/:postId/retry',
    status: 202,
    body: RetrySchema,
  },
  // The one read mark: {channelId, postId} or {rootId, postId}.
  read: {
    method: 'POST',
    path: '/api/buddies/read',
    status: 200,
    body: ReadSchema,
  },
  'upstream.update': {
    method: 'POST',
    path: '/api/upstream/update',
    status: 201,
    body: NoBodySchema,
  },
} as const;

export type BuddyMutation = keyof typeof buddyMutations;
type Contract<K extends BuddyMutation> = (typeof buddyMutations)[K];
export type BuddyMutationBody<K extends BuddyMutation> = z.input<Contract<K>['body']>;
type WithOptionalKey<T> = T extends { key: string } ? Omit<T, 'key'> & { key?: string } : T;
export type BuddyMutationInput<K extends BuddyMutation> = WithOptionalKey<BuddyMutationBody<K>>;
type ParamNames<Path extends string> = Path extends `${string}:${infer Param}/${infer Rest}`
  ? Param | ParamNames<Rest>
  : Path extends `${string}:${infer Param}`
    ? Param
    : never;
export type BuddyMutationParams<K extends BuddyMutation> = [
  ParamNames<Contract<K>['path']>,
] extends [never]
  ? Record<string, never>
  : {
      [P in ParamNames<Contract<K>['path']>]: P extends 'kind'
        ? z.infer<typeof BuddyDocKindSchema>
        : string;
    };

export interface BuddyMediaResult {
  files: { originalName: string; absolutePath: string; mimeType: string; size: number }[];
}

export type ReplyRetryResult =
  | { buddyId: string; status: 'started' }
  | { buddyId: string; status: 'rejected'; reason: string };
type ConversationOpened = { conversationId: string };
// Generated crate types are the domain source; only HTTP envelopes belong here.
export interface BuddyMutationResults {
  'workspace.create': Workspace;
  'builder.open': ConversationOpened;
  'buddy.create': Buddy;
  'buddy.update': Buddy;
  'buddy.archive': Buddy;
  // `channelId` is the 1:1 DM channel itself: write to it with `channel.post` (there is no
  // separate direct-post route).
  'direct.open': ConversationOpened & { channelId: string };
  'direct.new': ConversationOpened;
  'buddy.wake': ConversationOpened;
  'doc.write': Doc;
  'task.create': Task;
  'task.update': Task;
  'run.cancel': Run;
  'schedule.create': Schedule;
  'schedule.update': Schedule;
  'schedule.run': Run;
  'channel.archive': Channel;
  'channel.rename': Channel;
  'channel.create': Channel;
  'channel.post': { post: Post };
  'reply.retry': ReplyRetryResult;
  read: { ok: boolean };
  'upstream.update': UpstreamUpdateResult;
}
export type BuddyMutationRoute<K extends BuddyMutation> =
  `${Contract<K>['method']} ${Contract<K>['status']} ${Contract<K>['path']}`;
export function buddyMutationRoute<K extends BuddyMutation>(operation: K): BuddyMutationRoute<K> {
  const { method, status, path } = buddyMutations[operation];
  return `${method} ${status} ${path}` as BuddyMutationRoute<K>;
}

// Pattern: one-type-source (docs/patterns.md#one-type-source)
/** A channel delivery with the same waiting reason the claim gate reports. */
export type ChannelResponse = {
  channelId: string;
  threadRootId: string;
  buddyId: string;
  startedAt: string;
  /** `background`: the model is idle while its own background jobs run (task_01a11aa8). */
  state: 'replying' | 'background' | 'queued';
  waiting?: RunWaiting;
  /** For a delivery queued behind its Buddy's live turn (`conversation_busy`): what reaches that
   * turn. Absent otherwise, and from backends before task_01a11af2. */
  reach?: LiveReach;
};

/**
 * What reaches the live turn a queued owner post waits behind (server channels.ts `reachOf`).
 * task_01a11af2 (owner, 2026-10-08): "we should never see waiting unless it's at the 5 worker
 * max." Each case is one cause, said as such, never a generic "waiting":
 * - `next_step`: the turn takes it at its next tool use, a sub-agent's return, or at once when its
 *   model is idle on background work.
 * - `buddy_tool_only`: the harness has no per-turn hook; it lands at a Buddy tool call, or after.
 * - `spawned_before_live_delivery`: the process predates its hook set being recorded.
 * - `model_pick`: the owner picked a model; that pick needs its own turn.
 * - `turn_not_live`: no live turn here (starting, or a dead holder until its lease ends).
 * Table of every waiting path: agent_notes/2026-10-08_waiting-paths.md.
 */
// Pattern: sum-types (docs/patterns.md#sum-types)
export type LiveReach =
  | { kind: 'next_step' }
  | { kind: 'buddy_tool_only'; harness: string }
  | { kind: 'spawned_before_live_delivery' }
  | { kind: 'model_pick' }
  | { kind: 'turn_not_live' };
