import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServerSpec } from '@nbardy/agent-cli';
import type { Actor, ChannelRef, DocRef, DocScope, ListScope, Post } from '@unleashd/buddies-core';
import type { TaskQuery } from '@unleashd/buddies-core';
import type { Resolution } from '@unleashd/shared';
import { z } from 'zod';
import type { MessageSource } from '../conversations/messages';
import { requireCanonicalPostMedia } from './channel-media';
import {
  type BuddiesCore,
  BuddyChangesSchema,
  BuddyCreateFieldsSchema,
  OWNER,
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
}

// Pattern: route-at-send (docs/patterns.md#route-at-send)
/**
 * The conversation a turn's post, answer or follow subscribes: where later posts in that thread
 * are delivered (crate deliveries.rs). Owner decision 2026-10-07 (task_01a1153f): deliveries stay
 * "out of our chats", shown "as background worker". Under decision A the owner chat subscribed
 * itself, so a worker's answer ran there and showed its raw envelope as a "You" message. Now a
 * turn the owner typed subscribes the chat's BRANCH: one background child of the chat (listed as
 * its worker) that forks the chat's session on its first turn, so it has the lead's context.
 * Deciding here, not where the delivery runs, keeps a delivery from queueing behind the owner's
 * turn (`conversation_busy`); that is why decision A needed owner_first and Stop-cancel, now gone.
 * Cost: the lead's post from the owner chat links to the branch, where its replies run. Rejected
 * alternatives: agent_notes/2026-10-07_deliveries-off-owner-chats.md.
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
  return { kind: 'direct', members: [author, ...ref.direct.map(actorOf)] };
}

/**
 * A follow read's inline wait for the next post, in seconds: the default, and the cap. The owner
 * asked for "wait for a message in thread" (#case-studies, 2026-10-06); 30 s stays far under the
 * ~60 s a Claude client holds a tool call and the relay's 55 s hold, and a longer blocking wait
 * was rejected on 2026-08-21 (agent_notes/2026-08-21_primitives-and-the-wait-design.md). Past the
 * wait the subscription delivers the post as the conversation's next turn, so nothing is lost.
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
/**
 * A follow read (`channel_read {threadId, follow}`), decision D2 and delivery design Task 3:
 *   - `follow: {wait}` SUBSCRIBES this conversation to the thread (the crate's `thread_read`
 *     subscription, deliveries.rs), then returns the unread posts at once, or holds the read open
 *     up to `wait` s for a post by someone else, or returns `subscribed` with no posts. From then
 *     on every post by someone else there is delivered to THIS conversation as its next turn (a
 *     durable `deliver` run); an owner chat's follow subscribes its branch (`subscriber`). So the wait only
 *     saves a turn when an answer is seconds away; nothing depends on catching it inline.
 *   - `follow: false` unsubscribes ("notify only" is unsubscribing, decision D2/D).
 * Subscribing BEFORE the wait means a post during it is both returned and queued as a delivery;
 * returning it reads it, and the read fences that delivery, so it is heard once.
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
      'Write to a channel, a 1:1 DM ({direct:[id]}; groups go public) or task, or answer a request (`answers`). A DM request starts its recipient; a Buddy-DM inform is inert; public/task posts wake @mentions and followers. Thread: replyToId; mention: [@Name](buddy:<id>); media: ![alt](/absolute/path). Never shell out to agent CLIs.',
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
      const channel = await deps.core.openChannel(grant.author, toChannelRef(grant.author, ref));
      const resolved = await resolveForWorkspace(
        deps.core,
        grant.workspaceId,
        requireCanonicalPostMedia(input.body, {
          uploadsRoot: deps.uploadsRoot(),
          channelId: channel.id,
        })
      );
      const body = resolved.body;
      const { post, created } = await deps.core.post(
        grant.author,
        { kind: 'id', id: channel.id },
        // Buddies never send a reply to the channel: that is the owner's call (THREADS_VIEW §3).
        {
          ...input,
          body,
          // Provenance, and in a DM the conversation later posts there are delivered to.
          fromConversationId: await subscriber(deps, grant),
          mentions: wakes(channel, grant.author, input.kind, body, NO_PICKS),
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

/** One tool call under a grant: typed errors come back as a tool error, never a crash. */
// Pattern: idempotency-keys (docs/patterns.md#idempotency-keys) — every writing tool takes a `key`
// the crate records once per (actor, workspace); a retried call replays the first result.
export async function callTool(deps: ToolDeps, grant: TurnGrant, name: string, input: unknown) {
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
    return { content: [{ type: 'text' as const, text: JSON.stringify(result ?? null) }] };
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

function mcpServerFor(deps: ToolDeps, grant: TurnGrant): McpServer {
  const server = new McpServer({ name: MCP_SERVER_NAME, version: '3' });
  const registry = server as unknown as ToolRegistry;
  const run = (name: string) => (input: unknown) => callTool(deps, grant, name, input);
  for (const [name, entry] of Object.entries(toolsFor(grant.role))) {
    registry.registerTool(
      name,
      { description: entry.description, inputSchema: entry.schema },
      run(name)
    );
  }
  return server;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : undefined;
}

export type McpEndpoint = {
  readonly url: string;
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
    if (req.method !== 'POST' || req.url !== '/mcp') return void res.writeHead(405).end();
    const body = await readJson(req);
    const server = mcpServerFor(deps, grant);
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
