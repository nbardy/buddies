import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServerSpec } from '@nbardy/agent-cli';
import type { Actor, ChannelRef, DocRef, DocScope, ListScope } from '@unleashd/buddies-core';
import { z } from 'zod';
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
import type { BuddyGrant, Grants, Role, TurnGrant } from './grants';
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
  z.object({ id: z.string().min(1) }).describe('A channel id (public, direct or task)'),
  z
    .object({ direct: z.array(z.string().min(1)) })
    .describe(
      "A direct channel with these members (buddy ids, 'owner'); you are always in it, so [] is you alone"
    ),
  z.object({ task: z.string().min(1) }).describe("A task's channel (its comments)"),
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

const docKind = z.enum(['soul', 'working', 'long_term', 'shared']);
const memoryKind = z.enum(['working', 'long_term']);
// Soul and memory have one address, the Buddy. Only a shared doc may live in the workspace.
const docScopeInput = z
  .enum(['buddy', 'workspace'])
  .default('buddy')
  .describe("Shared docs only: 'workspace' for one the whole workspace reads");

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
      .describe(
        'The revision you read (0 = new). A stale write is a conflict: re-read and reconcile'
      ),
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
const readTaskRows = async (deps: ToolDeps, scope: Scope, include: TaskInclude) => {
  const query =
    'buddyId' in scope
      ? ({ kind: 'owner', buddyId: scope.buddyId } as const)
      : 'taskId' in scope
        ? ({ kind: 'children', parentId: scope.taskId } as const)
        : ({ kind: 'workspace', workspaceId: scope.workspace } as const);
  const tasks = await deps.core.listTasks(query);
  return (include === 'all' ? tasks : tasks.filter(isOpenTask)).map(taskRow);
};

const TASKS_TOOL = teamTool({
  description:
    "List task rows by {buddyId}, {taskId} (children), or {workspace}; get one full task. Lists default to open tasks; include 'all' reaches closed ones.",
  writes: false,
  schema: z.object({
    action: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('list'), scope: scopeSchema, include: taskInclude }),
      z.object({ kind: z.literal('get'), taskId: z.string().min(1) }),
    ]),
  }),
  handler: (deps, grant, { action }) =>
    action.kind === 'get'
      ? taskDetail(deps.core, grant.author, action.taskId, 20)
      : readTaskRows(deps, checkedScope(grant, action.scope), action.include),
});

// Pattern: table-driven (docs/patterns.md#table-driven)
const BUDDY_TOOLS = {
  post: buddyTool({
    description:
      'Write to a channel, DM ({direct:[ids]}) or task, or answer one request with `answers`. A DM request starts its recipient; inform wakes nobody. Use replyToId for a thread and [@Name](buddy:<id>) to mention. Embed media as ![alt](/absolute/path). A request with `worker` runs on that model and returns here. Never shell out to agent CLIs.',
    writes: true,
    schema: z.object({
      channel: channelRef.optional().describe('Required unless answers is set'),
      answers: z
        .string()
        .min(1)
        .optional()
        .describe('A request id; mutually exclusive with channel'),
      body: z.string().min(1).max(32_000),
      kind: z.enum(['inform', 'request']).default('inform'),
      replyToId: z.string().optional(),
      taskId: z.string().optional(),
      purpose: z.string().max(200).optional(),
      worker: WorkerSchema.optional().describe(
        "kind 'request' only: its runs execute on this model instead of the recipient's profile"
      ),
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
        return (
          await announcePost(
            deps,
            grant.author,
            await deps.core.answer(grant.author, {
              requestId: answers,
              body: input.body,
              evidence: input.evidence,
              key: input.key,
            }),
            NO_PICKS
          )
        ).post;
      }
      if (!ref) throw new Error('post needs channel or answers');
      const runConfig = worker && checkedRunConfig(worker);
      const channel = await deps.core.openChannel(grant.author, toChannelRef(grant.author, ref));
      const body = requireCanonicalPostMedia(input.body, {
        uploadsRoot: deps.uploadsRoot(),
        channelId: channel.id,
      });
      const { post, created } = await deps.core.post(
        grant.author,
        { kind: 'id', id: channel.id },
        // Buddies never send a reply to the channel: that is the owner's call (THREADS_VIEW §3).
        {
          ...input,
          body,
          fromConversationId: grant.conversationId,
          // The route was fixed when this turn started (Returns, policy-port.ts `returnsFor`).
          returns: grant.returns,
          runConfig,
          broadcast: false,
        }
      );
      // A replayed key (a retried tool call) announces nothing: it would wake everyone again.
      if (created) deps.events.emit({ kind: 'posted', post, channel, picks: NO_PICKS });
      return post;
    },
  }),
  inbox: buddyTool({
    description:
      'Requests you owe an answer, your own open requests, and your channels here with unread counts.',
    writes: false,
    schema: z.object({}),
    handler: (deps, grant) => deps.core.inbox(grant.author, grant.workspaceId),
  }),
  channel_admin: buddyTool({
    description:
      'Rename, archive or restore a public channel. Its identity and history stay intact; archived channels remain readable.',
    writes: true,
    schema: z.object({
      channelId: z.string().min(1),
      change: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('rename'), name: z.string().trim().min(1).max(80) }),
        z.object({ kind: z.literal('archive') }),
        z.object({ kind: z.literal('restore') }),
      ]),
      key,
    }),
    handler: (deps, grant, { channelId, change, key }) =>
      change.kind === 'rename'
        ? deps.core.renameChannel(grant.author, channelId, change.name, key)
        : deps.core.setChannelArchived(grant.author, channelId, change.kind === 'archive', key),
  }),
  channel_read: buddyTool({
    description:
      'Read a channel (top-level posts, newest first) or one thread, or search every channel you can read here (newest first). Search text: words (all must match; prefix, plural/stem and one-typo matches count: "market" finds marketing), "exact phrase", -excluded, OR, @Name or @"Two Words" (posts by that Buddy or by @owner; alone it lists them); filters narrow before paging. Example: read:{search:{text:\'"deploy window" -draft\', channels:[\'ops\'], from:[\'owner\'], after:\'2026-10-01\'}}. Every read returns { posts, next }; page older by passing `next` back as `before`. Reading a channel from its newest post marks it read.',
    writes: false,
    schema: z.object({
      read: z.union([
        z.object({ channelId: z.string().min(1) }),
        z.object({ threadId: z.string().min(1) }),
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
      before: z.object({ ord: z.string() }).optional().describe('next from the previous page'),
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
      const page = await deps.core.listPosts(grant.author, query, input.before, input.limit);
      const newest = page.posts[0];
      if (query.kind === 'channel' && !input.before && newest)
        await deps.core.markRead(grant.author, query.channelId, newest.id);
      return page;
    },
  }),
  tasks: TASKS_TOOL,
  task_write: buddyTool({
    description:
      'Create or compare-and-swap update a task. Pausing, cancelling or reassigning cancels queued runs. changes.pin pins a top-level task on the workspace Home: N>0 orders it (lower first; use max pin + 1 to append), 0 unpins. Comments use post {channel:{task}}.',
    writes: true,
    schema: taskWriteSchema(),
    handler: (deps, grant, input) => writeTask(deps, grant, input, grant.buddyId),
  }),
  doc_read: buddyTool({
    description:
      'Read a doc: soul, working or long-term memory, or shared docs. Returns its revision for doc_write. Detailed notes are agent_notes/*.md files in the workspace: read and search them with your own file tools.',
    writes: false,
    schema: docReadSchema(docKind),
    handler: (deps, grant, input) => deps.core.readDoc(grant.principal, docRef(grant, input)),
  }),
  doc_write: buddyTool({
    description:
      'Replace a doc with complete content (compare-and-swap on baseRevision; every revision is kept). Tasks own current work: never copy task status into memory.',
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
      'List run rows by {buddyId}, {taskId}, or {workspace} (yours: live runs first, then runs ended in the last 12 h) as {runs, truncated}. Each row says what happened: status, errorCode/error (errorCode "interrupted" = the host restarted mid-run) and conversationId. Get one full run or cancel. Queued rows include waiting.',
    writes: true,
    schema: z.object({
      action: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('list'), scope: scopeSchema }),
        z.object({ kind: z.literal('get'), runId: z.string().min(1) }),
        z.object({ kind: z.literal('cancel'), runId: z.string().min(1) }),
      ]),
    }),
    async handler(deps, grant, input) {
      switch (input.action.kind) {
        case 'list': {
          const scope = scopeQuery(checkedScope(grant, input.action.scope));
          const limit = RUN_ROW_LIMIT[scope.kind];
          const rows = await deps.core.listRunRows(scope, limit + 1);
          return { runs: rows.slice(0, limit), truncated: rows.length > limit };
        }
        case 'get':
          return deps.core.getRun(input.action.runId);
        case 'cancel': {
          const run = await deps.core.cancelRun(grant.principal, input.action.runId);
          deps.events.emit({ kind: 'cancelled', run });
          return run;
        }
      }
    },
  }),
  schedule: buddyTool({
    description:
      'List schedules, or create/update one (cron + IANA timezone + prompt). A due slot starts a run.',
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
            limits: '{}',
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
  const selected = toolsFor(grant.role)[name];
  if (!selected)
    return {
      isError: true,
      content: [{ type: 'text' as const, text: `[denied] ${name} is not available to this turn` }],
    };
  try {
    grant.observe(name, input);
    const result = await selected.handler(deps, grant, input as never);
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
  for (const [name, entry] of Object.entries(toolsFor(grant.role))) {
    registry.registerTool(
      name,
      { description: entry.description, inputSchema: entry.schema },
      (input: unknown) => callTool(deps, grant, name, input)
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
  url: string;
  close(): Promise<void>;
  spec(grant: TurnGrant): McpServerSpec;
};

/** Serve `/mcp` on 127.0.0.1 at an OS-assigned port. */
export async function startMcpEndpoint(deps: ToolDeps & { grants: Grants }): Promise<McpEndpoint> {
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const grant = bearer ? deps.grants.lookup(bearer) : null;
    if (!grant) return void res.writeHead(401).end('unknown, expired or revoked turn grant');
    if (req.method !== 'POST' || req.url !== '/mcp') return void res.writeHead(405).end();
    const server = mcpServerFor(deps, grant);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, await readJson(req));
  };
  const http: Server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      console.error('[buddies-mcp] request failed:', error);
      if (!res.headersSent) res.writeHead(500).end(String(error));
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  return {
    url,
    spec: (grant) => ({
      kind: 'http',
      url,
      headers: { Authorization: `Bearer ${grant.token}` },
      required: true,
    }),
    close: () => new Promise((resolve) => http.close(() => resolve())),
  };
}
