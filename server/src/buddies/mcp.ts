import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServerSpec } from '@nbardy/agent-cli';
import type { Actor, ChannelRef, DocRef, DocScope, ListScope, Post } from '@unleashd/buddies-core';
import type { SteerTrigger, TaskQuery, ThreadUnread } from '@unleashd/buddies-core';
import type { Resolution } from '@unleashd/shared';
import { z } from 'zod';
import type { MessageSource } from '../conversations/messages';
import type { BackgroundWork } from '../turns/background-work';
import { requireCanonicalPostMedia } from './channel-media';
import {
  type BuddiesCore,
  BuddyChangesSchema,
  BuddyCreateFieldsSchema,
  OWNER,
  SENDER,
  ScheduleFieldsSchema,
  TaskChangesSchema,
  buddyActor,
  buddyChanges,
  coreError,
  evidence,
  key,
  managerRef,
  taskDetail,
} from './core';
import { type BuddyEvents, NO_PICKS, announcePost } from './events';
import type { BuddyGrant, Grants, OwnerChat, Role, TurnGrant } from './grants';
import { attachToRelay } from './mcp-relay';
import { resolveForWorkspace, wakes } from './mentions';
import {
  TAIL_MAX,
  checkedEvidence,
  inboxView,
  runRowsView,
  runTail,
  taskDetailView,
} from './tool-views';
import { WorkerSchema, checkedRunConfig } from './worker-config';

/**
 * The one Buddy tool endpoint: stateless streamable HTTP on its own loopback listener, NOT the
 * auth-gated Express app (the owner secret never reaches a turn; a turn's bearer never reaches
 * the owner routes). Each request builds a fresh McpServer from the grant its bearer names.
 * Replaces the per-turn stdio helpers (mcp-server, owner-mcp, builder-mcp-server,
 * memory-review-mcp) and the control server they relayed through: 0 processes per turn, and
 * every write runs in this process, next to the change bus (B2).
 */
export const MCP_SERVER_NAME = 'unleashd_buddy';

export interface ToolDeps {
  core: BuddiesCore;
  events: BuddyEvents;
  uploadsRoot(): string;
  /** The one source of message bodies; `runs get {tail}` reads a run's transcript through it. */
  messages: MessageSource;
  /** Open (or reuse) the background branch of an owner chat and return its id (`subscriber`). */
  openBranch(chat: OwnerChat): Promise<string>;
  /** Turns whose model is idle while their background jobs run (turns/background-work.ts). */
  backgroundWork: BackgroundWork;
}

// Pattern: route-at-send (docs/patterns.md#route-at-send)
/** Where later posts are delivered: the active background conversation, or an owner chat's
 * branch. Owner chats stay available while the branch carries returns (2026-10-07 decision).
 * See agent_notes/2026-10-07_deliveries-off-owner-chats.md.
 */
function subscriber(deps: ToolDeps, grant: BuddyGrant): Promise<string> {
  switch (grant.subscribes) {
    case 'self':
      return Promise.resolve(grant.conversationId);
    case 'branch':
      return deps.openBranch(grant);
  }
}

type Tool<G extends TurnGrant> = {
  description: string;
  schema: z.AnyZodObject;
  /** Writes emit `changed`, which also wakes the runner (a write may enqueue a run). */
  writes: boolean;
  handler(deps: ToolDeps, grant: G, input: never): Promise<unknown>;
};

type ToolSpec<G extends TurnGrant, S extends z.AnyZodObject> = {
  description: string;
  schema: S;
  writes: boolean;
  handler(deps: ToolDeps, grant: G, input: z.infer<S>): Promise<unknown>;
};
// The handler's input type is the schema's; the SDK validates against the same schema first.
const buddyTool = <S extends z.AnyZodObject>(t: ToolSpec<BuddyGrant, S>) =>
  t as unknown as Tool<BuddyGrant>;
const teamTool = <S extends z.AnyZodObject>(t: ToolSpec<TurnGrant, S>) =>
  t as unknown as Tool<TurnGrant>;

const actorOf = (id: string): Actor => (id === 'owner' ? OWNER : buddyActor(id));

const channelRef = z.union([
  z.object({ id: z.string().min(1) }),
  z
    .object({ direct: z.array(z.string().min(1)) })
    .describe("Buddy ids or 'owner'; you are always in it, so [] is you alone"),
  z.object({ task: z.string().min(1) }),
  z.object({ request: z.string().min(1), to: z.enum(['worker', 'parent']) }),
]);

// Pattern: sum-types (docs/patterns.md#sum-types)
// Every list uses the same scope vocabulary; the tool-specific adapter only translates it to the
// crate query name. This replaces four subtly different list selectors.
const scopeSchema = z.union([
  z.object({ buddyId: z.string().min(1) }).strict(),
  z.object({ taskId: z.string().min(1) }).strict(),
  z.object({ workspace: z.string().min(1) }).strict(),
]);
type Scope = z.infer<typeof scopeSchema>;
const teamTargetSchema = z.union([
  z.object({ buddyId: z.string().min(1) }).strict(),
  z.object({ workspace: z.string().min(1) }).strict(),
]);

const scopeQuery = (scope: Scope): ListScope =>
  'buddyId' in scope
    ? ({ kind: 'buddy', buddyId: scope.buddyId } as const)
    : 'taskId' in scope
      ? ({ kind: 'task', taskId: scope.taskId } as const)
      : ({ kind: 'workspace', workspaceId: scope.workspace } as const);

// Pattern: capability-grants (docs/patterns.md#capability-grants)
// A Buddy turn lists only its own workspace; the Builder spans workspaces by design. The crate list
// queries take no actor, so this is the boundary: until 2026-09-29 `{workspace}` passed any id
// through, and a Buddy could read another workspace's tasks, runs and schedule prompts.
function checkedScope(grant: TurnGrant, scope: Scope): Scope {
  if (!('workspace' in scope) || grant.role === 'builder' || scope.workspace === grant.workspaceId)
    return scope;
  throw new Error(`workspace ${scope.workspace} is not this turn's workspace`);
}

// Pattern: table-driven (docs/patterns.md#table-driven)
// The workspace view is the "all live work" read: 17 Buddies x 5 runs overflows 20 rows, and a
// silent cut there was the original complaint. A list past its cap says so (`truncated`).
const RUN_ROW_LIMIT: Record<ListScope['kind'], number> = { buddy: 20, task: 20, workspace: 100 };

function toChannelRef(author: Actor, ref: z.infer<typeof channelRef>): ChannelRef {
  if ('id' in ref) return { kind: 'id', id: ref.id };
  if ('task' in ref) return { kind: 'task', taskId: ref.task };
  if ('request' in ref) return { kind: 'request', requestId: ref.request, to: ref.to };
  return { kind: 'direct', members: [author, ...ref.direct.map(actorOf)] };
}

/** Inline follow waits default to 2 s, capped at 30 s, below the CLI/relay tool timeout.
 * Later messages remain durable deliveries (or steer through the next Buddy tool response).
 */
export const FOLLOW_WAIT_DEFAULT_S = 2;
export const FOLLOW_WAIT_MAX_S = 30;
/** The default wait in ms (tests time the grace with it). */
export const FOLLOW_GRACE_MS = FOLLOW_WAIT_DEFAULT_S * 1000;

/** Resolves on the first post in `rootId` by someone other than `author`, or after `ms`. */
function postInThread(events: BuddyEvents, rootId: string, author: Actor, ms: number) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      off();
      resolve();
    };
    const timer = setTimeout(done, ms);
    const off = events.on((event) => {
      if (event.kind !== 'posted' || event.post.rootId !== rootId) return;
      if (
        event.post.author.kind === 'buddy' &&
        author.kind === 'buddy' &&
        event.post.author.id === author.id
      )
        return;
      done();
    });
  });
}

// Pattern: route-at-send (docs/patterns.md#route-at-send)
/** Subscribe before waiting, then read unread posts; the read fence consumes their deliveries.
 * Later posts steer the live thread turn through a Buddy tool response, or run when it is idle.
 * Owner chats subscribe their branch. follow:false unsubscribes without dropping unread posts.
 */
async function followThread(
  deps: ToolDeps,
  grant: BuddyGrant,
  threadId: string,
  follow: { wait: number } | false,
  limit: number
) {
  const root = await deps.core.getPost(grant.author, threadId);
  if (follow === false) {
    const read = await deps.core.followThread(grant.author, root.id, null, limit);
    return { kind: 'unsubscribed' as const, ...read };
  }
  const read = await deps.core.followThread(
    grant.author,
    root.id,
    await subscriber(deps, grant),
    limit
  );
  if (read.posts.length > 0) return { kind: 'unread' as const, ...read };
  await postInThread(deps.events, root.id, grant.author, follow.wait * 1000);
  const late = await deps.core.catchUpThread(grant.author, root.id, limit);
  if (late.posts.length > 0) return { kind: 'unread' as const, ...late };
  return { kind: 'subscribed' as const, posts: [] };
}

const docKind = z.enum(['soul', 'working', 'long_term', 'shared']);
const memoryKind = z.enum(['working', 'long_term']);
// Soul and memory have one address, the Buddy. Only a shared doc may live in the workspace.
const docScopeInput = z
  .enum(['buddy', 'workspace'])
  .default('buddy')
  .describe("'workspace' for a shared doc");

type Kinds = z.ZodType<DocRef['kind']>;
const docReadSchema = (kinds: Kinds) =>
  z.object({
    buddyId: z.string().optional().describe('Default: you'),
    kind: kinds,
    scope: docScopeInput,
    name: z.string().optional(),
  });
const docWriteSchema = (kinds: Kinds) =>
  docReadSchema(kinds).extend({
    content: z.string().max(40_000),
    baseRevision: z
      .number()
      .int()
      .nonnegative()
      .describe('The revision you read (0 = new); a stale write conflicts: re-read'),
    reason: z.string().min(1).max(2000),
    key,
  });

function docRef(grant: BuddyGrant, input: z.infer<ReturnType<typeof docReadSchema>>): DocRef {
  // Soul and memory are the Buddy's; the crate refuses them at any other scope. The reviewer's
  // schema has no scope at all, so it always reaches the Buddy doc.
  const scope: DocScope =
    input.scope === 'workspace'
      ? { kind: 'workspace', workspaceId: grant.workspaceId }
      : { kind: 'buddy' };
  return {
    buddyId: input.buddyId ?? grant.buddyId,
    scope,
    kind: input.kind,
    name: input.name ?? '',
  };
}

const taskWriteSchema = () =>
  z.object({
    write: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('create'),
        ownerId: z.string().optional().describe('Default: you'),
        parentId: z.string().optional(),
        title: z.string().min(1).max(300),
        doneCriteria: z.string().min(1).max(4000),
      }),
      z.object({
        kind: z.literal('update'),
        taskId: z.string().min(1),
        baseRevision: z.number().int().positive(),
        changes: TaskChangesSchema,
      }),
    ]),
    key,
  });

/** Task writes, shared by Buddy turns and the Builder (which has no Buddy to default to). */
async function writeTask(
  deps: ToolDeps,
  grant: TurnGrant,
  input: z.infer<ReturnType<typeof taskWriteSchema>>,
  defaultOwner: string | null
) {
  // A Builder create names its owner (schema); a Buddy's defaults to the Buddy itself.
  const ownerOf = (id: string | undefined) => {
    const owner = id ?? defaultOwner;
    if (owner === null) throw new Error('a task needs an ownerId');
    return owner;
  };
  const write = input.write;
  switch (write.kind) {
    case 'create':
      return deps.core.upsertTask(grant.principal, {
        kind: 'create',
        ownerId: ownerOf(write.ownerId),
        parentId: write.parentId,
        title: write.title,
        doneCriteria: write.doneCriteria,
        key: input.key,
      });
    case 'update':
      if (write.changes.evidence) checkedEvidence(write.changes.evidence);
      return deps.core.upsertTask(grant.principal, { ...write, key: input.key });
  }
}

// Lists default to open tasks: the CEO's full list was 109 tasks (92 closed, ~206k chars) and
// overflowed the tool result on 2026-09-27. `include: 'all'` still reaches the closed ones.
const taskInclude = z.enum(['open', 'all']).default('open');
type TaskInclude = z.infer<typeof taskInclude>;
const isOpenTask = (task: { status: string }) =>
  task.status !== 'done' && task.status !== 'cancelled';
const taskRow = (task: Awaited<ReturnType<BuddiesCore['getTask']>>) => ({
  id: task.id,
  ownerId: task.ownerId,
  parentId: task.parentId,
  title: task.title,
  status: task.status,
  paused: task.paused,
  pin: task.pin,
  updatedAt: task.updatedAt,
});
// The task query each list scope names; one conversion from the tool's scope (`scopeQuery`).
const TASK_QUERY: { [K in ListScope['kind']]: (s: Extract<ListScope, { kind: K }>) => TaskQuery } =
  {
    buddy: ({ buddyId }) => ({ kind: 'owner', buddyId }),
    task: ({ taskId }) => ({ kind: 'children', parentId: taskId }),
    workspace: ({ workspaceId }) => ({ kind: 'workspace', workspaceId }),
  };
const readTaskRows = async (deps: ToolDeps, scope: Scope, include: TaskInclude) => {
  const list = scopeQuery(scope);
  const tasks = await deps.core.listTasks(TASK_QUERY[list.kind](list as never));
  return (include === 'all' ? tasks : tasks.filter(isOpenTask)).map(taskRow);
};

const TASKS_TOOL = teamTool({
  description:
    "List tasks by {buddyId}, {taskId} (children) or {workspace}, or get one; include:'all' adds closed ones.",
  writes: false,
  schema: z.object({
    action: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('list'), scope: scopeSchema, include: taskInclude }),
      z.object({ kind: z.literal('get'), taskId: z.string().min(1) }),
    ]),
  }),
  handler: async (deps, grant, { action }) =>
    action.kind === 'get'
      ? taskDetailView(await taskDetail(deps.core, grant.author, action.taskId, 20))
      : readTaskRows(deps, checkedScope(grant, action.scope), action.include),
});

const channelToolSchema = z.object({
  action: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('create'),
      name: z.string().trim().min(1).max(80),
      purpose: z.string().trim().min(1).max(500),
    }),
    z.object({
      kind: z.literal('rename'),
      channelId: z.string().min(1),
      name: z.string().trim().min(1).max(80),
    }),
    z.object({ kind: z.literal('archive'), channelId: z.string().min(1) }),
    z.object({ kind: z.literal('restore'), channelId: z.string().min(1) }),
  ]),
  key,
});

/** The author learns whom the post woke; an unresolved `@Token` is data, not a silent no-op. */
const withMentions = (post: Post, { mentioned, unresolved, ambiguous }: Resolution) => ({
  ...post,
  mentioned,
  unresolved: [...unresolved, ...ambiguous],
});

// Pattern: table-driven (docs/patterns.md#table-driven)
const BUDDY_TOOLS = {
  post: buddyTool({
    description:
      "Post to a channel, 1:1 DM ({direct:[id]}; groups go public) or task, or answer (`answers`). A DM request starts its recipient; a Buddy-DM inform is inert; public/task posts wake @mentions+followers. {request:id,to:'worker'|'parent'} messages a live request's peer. Thread: replyToId; mention [@Name](buddy:<id>); media ![alt](/absolute/path).",
    writes: true,
    schema: z.object({
      channel: channelRef.optional(),
      answers: z.string().min(1).optional().describe('A request id; not with channel'),
      body: z.string().min(1).max(32_000).describe('Exact @Name mentions; see `unresolved`'),
      kind: z.enum(['inform', 'request']).default('inform'),
      replyToId: z.string().optional(),
      taskId: z.string().optional(),
      purpose: z.string().max(200).optional(),
      worker: WorkerSchema.optional().describe("kind 'request' only: run on this model"),
      evidence,
      key,
    }),
    async handler(deps, grant, { worker, answers, channel: ref, ...input }) {
      if (answers) {
        // An answer lands in the request's own thread: every channel-post field would be dropped
        // silently, so each is refused instead (a `kind:'request'` answer once read as sent).
        const dropped = Object.entries({
          channel: ref,
          worker,
          replyToId: input.replyToId,
          taskId: input.taskId,
          purpose: input.purpose,
          'kind request': input.kind === 'request' || undefined,
        }).flatMap(([name, value]) => (value === undefined ? [] : [name]));
        if (dropped.length)
          throw new Error(
            `post answers takes only body, evidence and key; drop ${dropped.join(', ')}`
          );
        const resolved = await resolveForWorkspace(deps.core, grant.workspaceId, input.body);
        const { post } = await announcePost(
          deps,
          grant.author,
          await deps.core.answer(grant.author, {
            requestId: answers,
            body: resolved.body,
            evidence: input.evidence,
            fromConversationId: await subscriber(deps, grant),
            key: input.key,
          })
        );
        return withMentions(post, resolved);
      }
      if (!ref) throw new Error('post needs channel or answers');
      const runConfig = worker && checkedRunConfig(worker);
      const target = toChannelRef(grant.author, ref);
      const channel = await deps.core.openChannel(grant.author, target);
      const resolved = await resolveForWorkspace(
        deps.core,
        grant.workspaceId,
        requireCanonicalPostMedia(input.body, {
          uploadsRoot: deps.uploadsRoot(),
          channelId: channel.id,
        })
      );
      const body = resolved.body;
      // A request message (`{request, to}`) is placed and authorized by the crate against the
      // request's endpoints (messages.rs); its receipt is its only delivery, so it wakes no mention.
      const addressed = target.kind === 'request';
      const { post, created } = await deps.core.post(
        grant.author,
        target,
        // Buddies never send a reply to the channel: that is the owner's call (THREADS_VIEW §3).
        {
          ...input,
          body,
          // Provenance, and in a DM the conversation later posts there are delivered to.
          fromConversationId: await subscriber(deps, grant),
          mentions: addressed ? [] : wakes(channel, grant.author, input.kind, body, NO_PICKS),
          runConfig,
          broadcast: false,
        }
      );
      // A replayed key (a retried tool call) announces nothing: it would wake everyone again.
      if (created) deps.events.emit({ kind: 'posted', post, channel });
      return withMentions(post, resolved);
    },
  }),
  inbox: buddyTool({
    description:
      'Requests you owe, your open requests (clipped), channels with unread posts (readChannels counts the rest).',
    writes: false,
    schema: z.object({}),
    handler: async (deps, grant) =>
      inboxView(await deps.core.inbox(grant.author, grant.workspaceId)),
  }),
  // Regression guard: 0fef9d4 (lean rewrite) dropped buddy.new_list, so Buddies could not create
  // channels for ~10 days although the crate's create_channel is Rule::AnyBuddy. Guard:
  // buddies-v2.test.ts "Buddy MCP creates a channel". One tool per noun (decision L1): the former
  // channel_create and channel_admin are this tool's `create` and `rename|archive|restore`.
  channel: buddyTool({
    description: 'Create a public channel, or rename, archive or restore one.',
    writes: true,
    schema: channelToolSchema,
    handler: (deps, grant, { action, key }) => {
      switch (action.kind) {
        case 'create':
          return deps.core.createChannel(grant.author, {
            name: action.name,
            purpose: action.purpose,
            key,
            workspaceId: grant.workspaceId,
          });
        case 'rename':
          return deps.core.renameChannel(grant.author, action.channelId, action.name, key);
        case 'archive':
        case 'restore':
          return deps.core.setChannelArchived(
            grant.author,
            action.channelId,
            action.kind === 'archive',
            key
          );
      }
    },
  }),
  channel_read: buddyTool({
    description:
      'Read a channel (newest first), a thread, or search every channel here; returns {posts, next} (page older: `next` as `before`). Search text: words (all match; stems and one typo count), "phrase", -excluded, OR, @Name (posts by that Buddy or @owner). Reading from the newest post marks it read.',
    writes: false,
    schema: z.object({
      read: z.union([
        z.object({ channelId: z.string().min(1) }),
        z.object({
          threadId: z.string().min(1),
          follow: z
            .union([
              z.object({
                wait: z.number().min(0).max(FOLLOW_WAIT_MAX_S).default(FOLLOW_WAIT_DEFAULT_S),
              }),
              z.literal(false),
            ])
            .optional()
            .describe(
              "Subscribe: later posts by others here start THIS conversation's next turn. Returns unread posts now or within `wait` s (≤30). false unsubscribes."
            ),
        }),
        z.object({
          search: z.object({
            text: z.string().min(1).max(200),
            channels: z.array(z.string().min(1)).max(20).optional().describe('ids or public names'),
            from: z.array(z.string().min(1)).max(20).optional().describe("buddy ids or 'owner'"),
            after: z.string().optional().describe('YYYY-MM-DD or RFC 3339, inclusive'),
            before: z.string().optional().describe('YYYY-MM-DD or RFC 3339, exclusive'),
            inThread: z.string().optional().describe('root post id'),
          }),
        }),
      ]),
      before: z.object({ ord: z.string() }).optional(),
      limit: z.number().int().min(1).max(100).default(30),
    }),
    async handler(deps, grant, input) {
      if ('search' in input.read)
        return deps.core.searchPosts(
          grant.author,
          grant.workspaceId,
          { channels: [], from: [], ...input.read.search },
          input.before,
          input.limit
        );
      const query =
        'channelId' in input.read
          ? ({ kind: 'channel', channelId: input.read.channelId } as const)
          : ({ kind: 'thread', rootId: input.read.threadId } as const);
      if ('threadId' in input.read && input.read.follow !== undefined) {
        if (input.before) throw new Error('follow reads from the newest post: drop before');
        return followThread(deps, grant, input.read.threadId, input.read.follow, input.limit);
      }
      const page = await deps.core.listPosts(grant.author, query, input.before, input.limit);
      const newest = page.posts[0];
      if (query.kind === 'channel' && !input.before && newest)
        await deps.core.markRead(grant.author, query.channelId, newest.id);
      // A Buddy's thread read moves its read mark (an existing `thread_read` row only), which
      // settles every queued delivery it covers without a turn (the read fence, deliveries.rs).
      if (query.kind === 'thread' && !input.before && newest)
        await deps.core.markThreadRead(grant.author, query.rootId, newest.id);
      return page;
    },
  }),
  tasks: TASKS_TOOL,
  task_write: buddyTool({
    description:
      'Create or compare-and-swap update a task; pausing, cancelling or reassigning cancels queued runs. changes.pin: N>0 pins a top-level task on Home (lower first, max + 1 appends), 0 unpins. Comment with post {channel:{task}}.',
    writes: true,
    schema: taskWriteSchema(),
    handler: (deps, grant, input) => writeTask(deps, grant, input, grant.buddyId),
  }),
  doc_read: buddyTool({
    description:
      'Read soul, working or long-term memory, or a shared doc; returns the revision for doc_write. Notes are agent_notes/*.md files: use your own file tools.',
    writes: false,
    schema: docReadSchema(docKind),
    handler: (deps, grant, input) => deps.core.readDoc(grant.principal, docRef(grant, input)),
  }),
  doc_write: buddyTool({
    description:
      'Replace a doc with its complete content (compare-and-swap on baseRevision). Never copy task status into memory.',
    writes: true,
    schema: docWriteSchema(docKind),
    handler: (deps, grant, { content, baseRevision, reason, key, ...doc }) =>
      deps.core.writeDoc(grant.principal, {
        doc: docRef(grant, doc),
        content,
        baseRevision,
        reason,
        key,
      }),
  }),
  runs: buddyTool({
    description:
      'List runs by {buddyId}, {taskId} or {workspace} (live first, then ended in the last 12 h) as {runs, truncated}; rows give purpose, taskTitle, status, errorCode (lease_expired = the holder died mid-run), conversationId, waiting. get {tail:n} adds its last n assistant entries. Also cancel, or retry a failed or cancelled run (same input, optionally another `worker`; reopens the request it answers).',
    writes: true,
    schema: z.object({
      action: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('list'), scope: scopeSchema }),
        z.object({
          kind: z.literal('get'),
          runId: z.string().min(1),
          tail: z.number().int().min(1).max(TAIL_MAX).optional(),
        }),
        z.object({ kind: z.literal('cancel'), runId: z.string().min(1) }),
        z.object({
          kind: z.literal('retry'),
          runId: z.string().min(1),
          worker: WorkerSchema.optional().describe('Absent: same as the failed run'),
          key,
        }),
      ]),
    }),
    async handler(deps, grant, input) {
      switch (input.action.kind) {
        case 'list': {
          const scope = scopeQuery(checkedScope(grant, input.action.scope));
          const limit = RUN_ROW_LIMIT[scope.kind];
          const rows = await deps.core.listRunRows(grant.author, scope, limit + 1);
          return {
            runs: runRowsView(rows.slice(0, limit)),
            truncated: rows.length > limit,
          };
        }
        case 'get': {
          const run = await deps.core.getRun(input.action.runId);
          const { tail } = input.action;
          return tail === undefined
            ? run
            : { ...run, tail: await runTail(deps.messages, run, tail) };
        }
        case 'cancel': {
          const run = await deps.core.cancelRun(grant.principal, input.action.runId);
          deps.events.emit({ kind: 'cancelled', run });
          return run;
        }
        case 'retry':
          // Attempt numbering and the request re-open live in the crate (runs.rs `retry_run`);
          // authority too. Only the model choice is checked here, against the catalog.
          return deps.core.retryRun(
            grant.principal,
            input.action.runId,
            input.action.worker && checkedRunConfig(input.action.worker),
            input.action.key
          );
      }
    },
  }),
  schedule: buddyTool({
    description:
      'List schedules, or create/update one (cron + IANA timezone + prompt). A due slot posts in its thread and wakes you there.',
    writes: true,
    schema: z.object({
      action: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('list'), scope: scopeSchema }),
        ScheduleFieldsSchema.extend({
          kind: z.literal('put'),
          id: z.string().optional().describe('Absent: create'),
          buddyId: z.string().optional(),
          key,
        }),
      ]),
    }),
    async handler(deps, grant, input) {
      const action = input.action;
      switch (action.kind) {
        case 'list':
          return deps.core.listSchedules(scopeQuery(checkedScope(grant, action.scope)));
        case 'put':
          return deps.core.putSchedule(grant.principal, {
            ...action,
            buddyId: action.buddyId ?? grant.buddyId,
          });
      }
    },
  }),
};

const TEAM_TOOLS = {
  team: teamTool({
    description: 'List workspace and Buddy rows, or get one full workspace or Buddy.',
    writes: false,
    schema: z.object({
      action: z
        .discriminatedUnion('kind', [
          z.object({ kind: z.literal('list'), workspace: z.string().min(1).optional() }),
          z.object({ kind: z.literal('get'), target: teamTargetSchema }),
        ])
        .default({ kind: 'list' }),
    }),
    async handler(deps, _grant, { action }) {
      if (action.kind === 'get') {
        const target = action.target;
        if ('buddyId' in target) return deps.core.getBuddy(target.buddyId);
        const workspaces = await deps.core.listWorkspaces();
        const workspace = workspaces.find((item) => item.id === target.workspace);
        if (!workspace) throw new Error(`workspace ${target.workspace} not found`);
        return workspace;
      }
      const workspaces = (await deps.core.listWorkspaces()).filter(
        (workspace) => !action.workspace || workspace.id === action.workspace
      );
      const buddies = (await Promise.all(workspaces.map((item) => deps.core.listBuddies(item.id))))
        .flat()
        .map(({ id, workspaceId, name, role, status, managerId }) => ({
          id,
          workspaceId,
          name,
          role,
          status,
          managerId,
        }));
      return {
        workspaces: workspaces.map(({ id, name }) => ({ id, name })),
        buddies,
      };
    },
  }),
  team_admin: teamTool({
    description:
      'Owner only: hire a buddy, or change one (profile, manager, model, limits, archive).',
    writes: true,
    schema: z.object({
      change: z.discriminatedUnion('kind', [
        BuddyCreateFieldsSchema.extend({
          kind: z.literal('create'),
          soul: z
            .string()
            .max(10_000)
            .optional()
            .describe("The new buddy's soul: its identity and role"),
        }),
        BuddyChangesSchema.extend({ kind: z.literal('update'), buddyId: z.string().min(1) }),
      ]),
      key,
    }),
    async handler(deps, grant, input) {
      const change = input.change;
      switch (change.kind) {
        case 'create': {
          const { soul, kind: _kind, managerId, ...profile } = change;
          const buddy = await deps.core.createBuddy(grant.principal, {
            ...profile,
            manager: managerRef(managerId ?? null),
            key: input.key,
          });
          if (soul)
            await deps.core.writeDoc(grant.principal, {
              doc: { buddyId: buddy.id, scope: { kind: 'buddy' }, kind: 'soul', name: '' },
              content: soul,
              baseRevision: 0,
              reason: 'hired',
              key: `${input.key}:soul`,
            });
          return buddy;
        }
        case 'update': {
          const { kind: _kind, buddyId, ...changes } = change;
          return deps.core.updateBuddy(grant.principal, {
            buddyId,
            changes: buddyChanges(changes),
            key: input.key,
          });
        }
      }
    },
  }),
};

// The Builder saves work for the staff it hires (as the owner's old Builder tools did). It has no
// Buddy of its own, so every view and every new task names its Buddy.
const BUILDER_TOOLS = {
  tasks: TASKS_TOOL,
  task_write: teamTool({
    description:
      'Create a task (ownerId required), or compare-and-swap update one. Comments use post {channel:{task}}.',
    writes: true,
    schema: taskWriteSchema(),
    handler: (deps, grant, input) => writeTask(deps, grant, input, null),
  }),
};

const REVIEWER_TOOLS = {
  doc_read: {
    ...BUDDY_TOOLS.doc_read,
    schema: docReadSchema(z.enum(['soul', 'working', 'long_term'])).omit({ scope: true }),
  },
  // The reviewer curates working and long-term memory; it writes no soul or shared docs.
  doc_write: {
    ...BUDDY_TOOLS.doc_write,
    schema: docWriteSchema(memoryKind).omit({ scope: true }),
  },
};

/** Which tools a role is shown. Presentation only: the crate's `authorize` decides every call. */
export function toolsFor(role: Role): Record<string, Tool<TurnGrant>> {
  const { team_admin, team } = TEAM_TOOLS;
  const buddy = BUDDY_TOOLS as Record<string, Tool<TurnGrant>>;
  switch (role) {
    case 'worker':
      return { ...buddy, team };
    case 'owner':
      return { ...buddy, team, team_admin };
    case 'reviewer':
      return REVIEWER_TOOLS as Record<string, Tool<TurnGrant>>;
    case 'builder':
      return { ...TEAM_TOOLS, ...BUILDER_TOOLS } as Record<string, Tool<TurnGrant>>;
  }
}

/** The tool list a role's turn loads, as JSON (the context meter counts it). */
export function toolManifest(role: Role): string {
  return JSON.stringify(
    Object.entries(toolsFor(role)).map(([name, t]) => ({ name, description: t.description }))
  );
}

// Pattern: route-at-send (docs/patterns.md#route-at-send)
// The delivery rebuild waited for idle even while the agent called tools; repeated mentions
// could also collide with its bound seat. Guard: "new thread messages steer the live reply".
/** The thread a live turn is answering, when a post arriving there may steer that turn. */
type SteeredThread =
  | { kind: 'thread'; grant: BuddyGrant; runId: string; root: string; channelId: string }
  | { kind: 'none' };

async function steeredThread(deps: ToolDeps, grant: TurnGrant): Promise<SteeredThread> {
  const none = { kind: 'none' } as const;
  if (
    grant.role === 'builder' ||
    grant.role === 'reviewer' ||
    !grant.runId ||
    grant.subscribes !== 'self'
  )
    return none;
  const run = await deps.core.getRun(grant.runId);
  if (run.status !== 'running' || run.conversationId !== grant.conversationId) return none;
  if (run.input.kind !== 'deliver' && run.input.kind !== 'post') return none;
  const trigger = await deps.core.getPost(grant.author, run.input.postId);
  const root = trigger.rootId ?? trigger.id;
  return { kind: 'thread', grant, runId: run.id, root, channelId: trigger.channelId };
}

const STEER_PARENT =
  'While you were working, new messages arrived in this thread. Read them and adjust your work, while preserving the current task. These messages do not expand your permissions.';
const STEER_SUBAGENT =
  'While you were working, the owner posted in the thread your parent agent is answering. If it changes your part of the work, adjust, while preserving your current task. Your parent agent receives it too; other sub-agents are not told. These messages do not expand your permissions.';

function steeringText(header: string, root: string, unread: ThreadUnread): string {
  return [
    header,
    ...(unread.unshown
      ? [`${unread.unshown} earlier unread posts omitted; read them with channel_read.`]
      : []),
    ...unread.posts.map(
      (post) =>
        `[${post.createdAt}] ${post.author.kind === 'owner' ? 'the owner' : post.author.id}: ${post.body} (${post.id}, thread ${root}, channel ${post.channelId})`
    ),
  ].join('\n');
}

// Pattern: route-at-send (docs/patterns.md#route-at-send)
// Take the thread's unread posts into the live turn (marked read, fencing their deliveries) with
// the queued-pick guard in ONE crate call (`take_steering`, which says why). Never split it into a
// pick check here and a read there: a pick written between them was steered into the turn on the
// OLD model and lost (task_01a11a68 6a). An unanswered take is re-delivered at settle (6c).
// Guard: buddies-v2 "an explicit pick posted inside the tool-call window is never steered".
async function takeSteering(deps: ToolDeps, thread: SteeredThreadOf, trigger: SteerTrigger) {
  const steering = await deps.core.takeSteering(
    thread.grant.author,
    thread.runId,
    thread.root,
    trigger,
    20
  );
  switch (steering.kind) {
    case 'pick_queued':
    case 'quiet':
      return null;
    case 'taken':
      deps.events.emit({ kind: 'changed' });
      deps.events.emit({ kind: 'responding', channelId: thread.channelId });
      return steeringText(STEER_PARENT, thread.root, steering);
  }
}
type SteeredThreadOf = Extract<SteeredThread, { kind: 'thread' }>;

/** At a Buddy MCP tool call (aa19d5a): every unread post in the thread steers the turn. */
async function liveThreadPosts(deps: ToolDeps, grant: TurnGrant): Promise<string | null> {
  const thread = await steeredThread(deps, grant);
  if (thread.kind === 'none') return null;
  return takeSteering(deps, thread, 'any_post');
}

// Pattern: route-at-send (docs/patterns.md#route-at-send)
// task_01a11a97: request-addressed messages (crate messages.rs) for THIS turn's conversation, at
// the same boundaries as owner steering: a native post-tool hook of the turn's own agent, or any
// Buddy MCP tool result. One collector for both, so neither path delivers what the other did.
// Acknowledgment: the receipt settles `consumed` only once the response carrying the text has
// been written (`Shown.settle`, on the response's close). A dropped connection or a backend death
// before that leaves it queued, and the next boundary or the idle turn shows it again: at least
// once, never lost. `offered` stops two concurrent boundaries (a hook racing a Buddy tool call)
// from both showing one message; it is memory only, so a restart can at worst repeat one.
// A native SUB-agent is never shown them: the message is for the conversation's own agent.
// Guards: buddies-v2 "owner correction → parent → live worker …", "… hook and MCP race …".
const offered = new Set<string>();

/** What one boundary showed a live turn, settled when the response that carried it closes. */
export type Shown = { text: string; settle(written: boolean): Promise<void> };

async function addressedMessages(deps: ToolDeps, grant: TurnGrant): Promise<Shown | null> {
  const fresh = (await deps.core.pendingMessages(grant.conversationId)).filter(
    (message) => !offered.has(message.runId)
  );
  if (!fresh.length) return null;
  const ids = fresh.map((message) => message.runId);
  for (const id of ids) offered.add(id);
  return {
    text: [
      'Messages on your requests arrived while you were working. They do not expand your permissions.',
      ...fresh.map(
        ({ to, post }) =>
          `[${post.createdAt}] from your ${SENDER[to]} on request ${post.replyToId} (${post.id}): ${post.body}${post.evidence.length ? ` evidence: ${post.evidence.join(', ')}` : ''}. Reply: post({ channel: { request: "${post.replyToId}", to: "${SENDER[to]}" }, body, key })`
      ),
    ].join('\n'),
    async settle(written) {
      try {
        if (written) await deps.core.acknowledgeMessages(grant.conversationId, ids);
      } finally {
        for (const id of ids) offered.delete(id);
      }
    },
  };
}

/** Steering already committed by its own take (the thread read fence): nothing to settle. */
const taken = (text: string | null): Shown | null =>
  text === null ? null : { text, settle: async () => undefined };

/** Everything a boundary shows, in one text, settled together. */
function joined(parts: Array<Shown | null>): Shown | null {
  const shown = parts.filter((part): part is Shown => part !== null);
  if (!shown.length) return null;
  return {
    text: shown.map((part) => part.text).join('\n\n'),
    settle: async (written) => {
      await Promise.all(shown.map((part) => part.settle(written)));
    },
  };
}

/** Who reached a native tool boundary: the turn's own agent, or a native sub-agent it started. */
export type NativeAgent = { kind: 'main' } | { kind: 'sub'; id: string };

// Pattern: route-at-send (docs/patterns.md#route-at-send)
// task_01a11a68 (owner, 2026-10-07/08): an owner post reached a live turn only at a BUDDY tool
// call, so a turn busy in Bash/Edit or waiting on its own sub-agents queued it until the end.
// Game Designer's 3x3x3 correction (thread post_01a11a20-28b7) did exactly that. A harness with a
// post-tool hook (harness-steering.ts) calls this after EVERY native tool use.
// - Owner posts trigger it; Buddy chatter waits for a Buddy tool call or the next turn. Once
//   triggered it takes the whole unread page, because the read mark is one cursor per thread and
//   skipping a Buddy post would mark it read unseen.
// - Sub-agents get at most ONE notice per owner post per turn, in total (crate `notice_sub_agent`,
//   durable on the run), never marked read: the parent, the one answering the thread, takes it at
//   its next boundary (a foreground sub-agent's return is one; an idle parent's Stop hold is
//   another). Taking it in the sub-agent would fence the delivery, and the parent would never see
//   it unless the sub-agent relayed it. Claude fires no parent hook while a foreground sub-agent
//   runs (probed with claude 2.1.294), so one sub-agent's boundary is the earliest notice.
//   task_01a11af2: this was once per sub-agent id, in memory: 35 notices into a 27-agent Workflow,
//   repeated after a restart, while the idle parent got nothing.
// Guard: buddies-v2 "an owner post steers a live turn at a native tool boundary".
export async function steerNativeTool(
  deps: ToolDeps,
  grant: TurnGrant,
  agent: NativeAgent
): Promise<Shown | null> {
  switch (agent.kind) {
    case 'main':
      return joined([
        await addressedMessages(deps, grant),
        taken(await steerOwner(deps, grant, agent)),
      ]);
    case 'sub':
      return taken(await steerOwner(deps, grant, agent));
  }
}

async function steerOwner(
  deps: ToolDeps,
  grant: TurnGrant,
  agent: NativeAgent
): Promise<string | null> {
  const thread = await steeredThread(deps, grant);
  if (thread.kind === 'none') return null;
  switch (agent.kind) {
    case 'main':
      return takeSteering(deps, thread, 'owner_post');
    case 'sub': {
      const { author } = thread.grant;
      const fresh = await deps.core.noticeSubAgent(author, thread.runId, thread.root, 20);
      return fresh.posts.length ? steeringText(STEER_SUBAGENT, thread.root, fresh) : null;
    }
  }
}

// task_01a11aa8 (owner, 2026-10-08): Game Designer's model ended its turn while a background
// Workflow ran, and `claude -p` sat 29.5 min with no tool call to steer at; the owner's posts
// waited for the Workflow. Claude runs its Stop hook the moment the model ends a turn, with the
// in-flight `background_tasks` in the input, and holds while the hook runs. A `decision: block`
// continues the model in the SAME process with the reason as its next message; the jobs keep
// running, and a job that ends during the hold still streams its notice (probed on claude
// 2.1.294: agent_notes/2026-10-08_idle-background-delivery.md). So this holds the hook while the
// turn is in the `background` state (turns/background-work.ts) and answers with the first owner
// post. When the last job finishes first, it releases with no decision, and claude handles the
// job's notice as it always did. A Stop with no background work returns at once: the turn is
// settling, and a queued delivery runs as the next turn, unchanged.
// A request-addressed message for this conversation (task_01a11a97) ends the hold the same way:
// a parent idle on its own background work still hears its worker's question.
// Guard: idle-background-delivery.test.ts "an owner post reaches a Buddy whose model is idle
// while its background job runs"; buddies-v2 "a worker's question reaches a parent idle on …".
export async function holdStoppedTurn(
  deps: ToolDeps,
  grant: TurnGrant,
  tasks: readonly string[],
  closed: AbortSignal
): Promise<Shown | null> {
  if (!tasks.length) return null;
  const thread = await steeredThread(deps, grant);
  if (thread.kind === 'none') return null;
  // A post that arrived during the model's last step is taken at once. After a wake the take runs
  // again: a Buddy tool call may already have taken the page, and then the hold resumes.
  for (;;) {
    const shown = joined([
      await addressedMessages(deps, grant),
      taken(await takeSteering(deps, thread, 'owner_post')),
    ]);
    if (shown !== null || closed.aborted) return shown;
    const owner = new AbortController();
    // An owner post in the thread, or any DM post (request messages live in DMs): look again.
    const off = deps.events.on((event) => {
      if (event.kind !== 'posted') return;
      const inThread = event.post.rootId === thread.root && event.post.author.kind === 'owner';
      if (inThread || event.channel.kind.type === 'direct') owner.abort();
    });
    const { conversationId, buddyId } = thread.grant;
    const held = deps.backgroundWork.hold(
      conversationId,
      { buddyId, rootId: thread.root },
      tasks,
      AbortSignal.any([closed, owner.signal])
    );
    deps.events.emit({ kind: 'responding', channelId: thread.channelId });
    // The background state has ended by now, so the status line never shows it while the model
    // answers.
    const drained = await held;
    off();
    deps.events.emit({ kind: 'responding', channelId: thread.channelId });
    if (drained) return null;
  }
}

/** One tool call under a grant: typed errors come back as a tool error, never a crash. */
// Pattern: idempotency-keys (docs/patterns.md#idempotency-keys) — every writing tool takes a `key`
// the crate records once per (actor, workspace); a retried call replays the first result.
export async function callTool(
  deps: ToolDeps,
  grant: TurnGrant,
  name: string,
  input: unknown,
  show: (part: Shown) => void
) {
  const advertised = toolsFor(grant.role);
  const selected = advertised[name];
  if (!selected)
    return {
      isError: true,
      content: [{ type: 'text' as const, text: `[denied] ${name} is not available to this turn` }],
    };
  try {
    const result = await grant.observe(name, input, () =>
      selected.handler(deps, grant, input as never)
    );
    if (selected.writes) deps.events.emit({ kind: 'changed' });
    const boundary = await Promise.all([
      addressedMessages(deps, grant),
      liveThreadPosts(deps, grant).then(taken),
    ])
      .then(joined)
      .catch((error) => {
        console.warn('[buddies-mcp] live delivery deferred:', error);
        return null;
      });
    if (boundary) show(boundary);
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(result ?? null) },
        ...(boundary ? [{ type: 'text' as const, text: boundary.text }] : []),
      ],
    };
  } catch (error) {
    const typed = coreError(error);
    const text = typed ? typed.message : error instanceof Error ? error.message : String(error);
    return { isError: true, content: [{ type: 'text' as const, text }] };
  }
}

// The SDK's registerTool generics instantiate every zod schema type deeply (TS2589); tools are
// registered through this narrow view instead.
type ToolRegistry = {
  registerTool(
    name: string,
    config: { description: string; inputSchema: z.AnyZodObject },
    callback: (input: unknown) => Promise<unknown>
  ): unknown;
};

function mcpServerFor(deps: ToolDeps, grant: TurnGrant, show: (part: Shown) => void): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: '3' });
  const registry = server as unknown as ToolRegistry;
  const run = (name: string) => (input: unknown) => callTool(deps, grant, name, input, show);
  for (const [name, entry] of Object.entries(toolsFor(grant.role))) {
    registry.registerTool(
      name,
      { description: entry.description, inputSchema: entry.schema },
      run(name)
    );
  }
  return server;
}

// κ for every native hook (harness-steering.ts STABLE set): ONE url, dispatched here on the
// input's `hook_event_name`, so what a hook does is decided by the server that answers it, never
// frozen into a process's argv (task_01a11af2). An event no delivery path uses answers empty.
// `agent_id` is present exactly when a native sub-agent made the tool call (probe:
// agent_notes/2026-10-08_steer-any-tool-boundary.md). `background_tasks` lists claude's in-flight
// background work at Stop (absent on harness versions before it existed: nothing to hold for).
const HOOK_PATH = '/hooks/event';
// The two per-event urls of hook sets spawned before task_01a11af2. Their processes keep calling
// them until they end, so they reach the same dispatcher.
const HOOK_PATHS = new Set([HOOK_PATH, '/hooks/post-tool-use', '/hooks/stop']);
const ToolHook = z.object({
  hook_event_name: z.enum(['PostToolUse', 'PostToolUseFailure']),
  agent_id: z.string().min(1).optional(),
});
const StopHook = z.object({
  hook_event_name: z.literal('Stop'),
  background_tasks: z.array(z.object({ id: z.string().min(1) })).default([]),
});
// Pattern: sum-types (docs/patterns.md#sum-types)
type NativeHook =
  | { t: 'tool'; event: z.infer<typeof ToolHook>['hook_event_name']; agent: NativeAgent }
  | { t: 'stop'; tasks: readonly string[] }
  | { t: 'unused' };
function nativeHook(raw: unknown): NativeHook {
  const event = z.object({ hook_event_name: z.string().min(1) }).parse(raw).hook_event_name;
  switch (event) {
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const input = ToolHook.parse(raw);
      const agent: NativeAgent = input.agent_id ? { kind: 'sub', id: input.agent_id } : { kind: 'main' };
      return { t: 'tool', event: input.hook_event_name, agent };
    }
    case 'Stop':
      return { t: 'stop', tasks: StopHook.parse(raw).background_tasks.map((task) => task.id) };
    default:
      return { t: 'unused' };
  }
}
function postToolOutput(hookEventName: string, additionalContext: string): string {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName, additionalContext },
  });
}

/** One native hook call: what it shows the turn, and the harness's reply body. */
async function answerHook(
  deps: ToolDeps,
  grant: TurnGrant,
  hook: NativeHook,
  closed: AbortSignal
): Promise<{ shown: Shown; body: string } | null> {
  switch (hook.t) {
    case 'tool': {
      const shown = await steerNativeTool(deps, grant, hook.agent);
      return shown && { shown, body: postToolOutput(hook.event, shown.text) };
    }
    case 'stop': {
      const shown = await holdStoppedTurn(deps, grant, hook.tasks, closed);
      return shown && { shown, body: JSON.stringify({ decision: 'block', reason: shown.text }) };
    }
    case 'unused':
      return null;
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : undefined;
}

export type McpEndpoint = {
  readonly url: string;
  /** Every native hook POSTs here (harness-steering.ts), with the turn's MCP bearer. */
  readonly hookUrl: string;
  close(): Promise<void>;
  spec(grant: TurnGrant): McpServerSpec;
};

function listen(http: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', () => {
      http.off('error', reject);
      resolve();
    });
  });
}

/**
 * Serve `/mcp` on an OS-assigned internal loopback port, attached to the Buddy MCP relay. Turns
 * call the relay's port, which outlives this backend (mcp-relay.ts), so a call made while no
 * backend runs is held and delivered by the next one instead of meeting ECONNREFUSED.
 */
export async function startMcpEndpoint(
  deps: ToolDeps & { grants: Grants; portFile: string }
): Promise<McpEndpoint> {
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const grant = bearer ? deps.grants.lookup(bearer) : null;
    if (!grant) return void res.writeHead(401).end('unknown, expired or revoked turn grant');
    // What this response shows the turn settles once it is written (`addressedMessages`); a part
    // shown after the client already left settles unwritten at once, or it would stay offered.
    const shown: Shown[] = [];
    let closed = false;
    const settle = (part: Shown) =>
      part
        .settle(res.writableFinished)
        .catch((error) => console.warn('[buddies-mcp] receipt not settled:', error));
    const show = (part: Shown) => (closed ? void settle(part) : void shown.push(part));
    res.on('close', () => {
      closed = true;
      for (const part of shown) settle(part);
    });
    if (req.method === 'POST' && HOOK_PATHS.has(req.url ?? '')) {
      // The harness kills its hook with the turn (Stop, timeout, process exit): a hold ends.
      const closed = new AbortController();
      res.on('close', () => closed.abort());
      const answer = await answerHook(deps, grant, nativeHook(await readJson(req)), closed.signal);
      if (answer) show(answer.shown);
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(answer?.body ?? '');
    }
    if (req.method !== 'POST' || req.url !== '/mcp') return void res.writeHead(405).end();
    const body = await readJson(req);
    const server = mcpServerFor(deps, grant, show);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
  const http: Server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      console.error('[buddies-mcp] request failed:', error);
      if (!res.headersSent) res.writeHead(500).end(String(error));
    });
  });
  await listen(http);
  // Attach only now: the grants of adopted turns are restored before this (server.ts), so the
  // first call the relay forwards already finds them.
  const relay = await attachToRelay(deps.portFile, (http.address() as AddressInfo).port);
  const url = () => `http://127.0.0.1:${relay.port}/mcp`;
  return {
    get url() {
      return url();
    },
    get hookUrl() {
      return `http://127.0.0.1:${relay.port}${HOOK_PATH}`;
    },
    spec: (grant) => ({
      kind: 'http',
      url: url(),
      headers: { Authorization: `Bearer ${grant.token}` },
      required: true,
    }),
    close: () => {
      relay.close();
      return new Promise((resolve) => http.close(() => resolve()));
    },
  };
}
