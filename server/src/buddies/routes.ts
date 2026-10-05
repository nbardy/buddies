import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  Actor,
  BuddyChanges,
  ChannelRef,
  DocScope,
  Post,
  PostQuery,
  RunQuery,
  TaskQuery,
} from '@unleashd/buddies-core';
import {
  AnswerSchema,
  BuddyCreateSchema,
  type BuddyMediaResult,
  type BuddyMutation,
  type BuddyMutationResults,
  type BuddyMutationRoute,
  BuddyPatchSchema,
  BuilderOpenSchema,
  ChannelSchema,
  type ConversationConfig,
  DirectPostSchema,
  DocWriteSchema,
  NewDirectSchema,
  PostBodySchema,
  ReadSchema,
  RetrySchema,
  ScheduleSchema,
  TaskCreateSchema,
  TaskUpdateSchema,
  WorkspaceSchema,
  buddyMutationRoute,
  BuddyDocKindSchema as docKind,
} from '@unleashd/shared';
import type { Express, Request, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  CHANNEL_IMAGE_EXTENSIONS,
  CHANNEL_MEDIA_MAX_BYTES,
  CHANNEL_VIDEO_EXTENSIONS,
  channelMediaDirectory,
  requireCanonicalPostMedia,
} from './channel-media';
import { type Channels, mentionedBuddyIds } from './channels';
import {
  type BuddiesCore,
  ChannelArchiveSchema,
  ChannelRenameSchema,
  CoreError,
  OWNER,
  buddyActor,
  buddyChanges,
  coreError,
  managerRef,
  taskDetail,
} from './core';
import { type BuddyEvents, type MentionPicks, NO_PICKS, announcePost } from './events';
import type { Runner } from './runner';
import { channelsNamed } from './search-channels';

/**
 * The owner's Buddy API over the crate, mounted behind the auth gate (server.ts registers it after
 * the gate, like every /api route). About 35 routes replace ~75. Every call acts as the Owner;
 * the crate authorizes. Bodies are parsed once here (κ); the core never sees unparsed input.
 */
export interface BuddyRouteDeps {
  core: BuddiesCore;
  events: BuddyEvents;
  runner: Runner;
  channels: Channels;
  uploadsRoot(): string;
  channelChanged(channelId: string): void;
  onBuddyArchived(buddyId: string): void;
  /**
   * `workingDirectory` is the workspace the owner opened the Builder from.
   * Absent: the caller uses the install default (sidebar New Buddy).
   */
  createBuilderConversation(workingDirectory?: string): Promise<{ conversationId: string }>;
}

/**
 * κ for "New workspace" on the home screen (port of 6d04860): the folder is resolved to its real
 * path, because the crate's reuse key is the stored root_path string — `~/x`, `/x/` and a symlink
 * to `/x` must all find the one workspace. A missing name is the folder's name.
 */
function workspaceInput(raw: unknown): { name: string; rootPath: string } {
  const input = WorkspaceSchema.parse(raw);
  const typed = input.rootPath;
  const expanded =
    typed === '~' || typed.startsWith('~/') ? path.join(os.homedir(), typed.slice(1)) : typed;
  if (!path.isAbsolute(expanded)) throw new CoreError('invalid', `not an absolute path: ${typed}`);
  if (!fs.existsSync(expanded) || !fs.statSync(expanded).isDirectory())
    throw new CoreError('invalid', `not a directory: ${typed}`);
  const rootPath = fs.realpathSync(expanded);
  if (rootPath === path.parse(rootPath).root)
    throw new CoreError('invalid', 'the filesystem root cannot be a workspace');
  return { name: input.name ?? path.basename(rootPath), rootPath };
}
// Keyset pages on the post's ordered id (`Post.ord`, a UUIDv7), never on timestamps.
// `from` (a post id) is a permalink's page instead: that post and everything newer (T22).
const CursorSchema = z.object({
  before: z.string().optional(),
  from: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** A doc scope from the query string: the portable doc by default. */
const DOC_SCOPES: Record<string, (id: string) => DocScope> = {
  workspace: (workspaceId) => ({ kind: 'workspace', workspaceId }),
};
function scopeOf(scope: string, scopeId: string | undefined): DocScope {
  if (scope === 'buddy') return { kind: 'buddy' };
  const make = DOC_SCOPES[scope];
  if (!make) throw new Error(`unknown doc scope ${scope}`);
  return make(z.string().min(1, `scope ${scope} needs a scopeId`).parse(scopeId));
}

/** κ for the owner's per-mention model picks: one per Buddy, and only for a mentioned Buddy. */
function mentionConfigsByBuddy(
  body: string,
  entries: readonly { buddyId: string; config: ConversationConfig }[]
) {
  const mentioned = new Set(mentionedBuddyIds(body));
  const byBuddy = new Map<string, ConversationConfig>();
  for (const entry of entries) {
    if (!mentioned.has(entry.buddyId) || byBuddy.has(entry.buddyId))
      throw new Error(
        `mentionConfigs must name each mentioned Buddy at most once (${entry.buddyId})`
      );
    byBuddy.set(entry.buddyId, entry.config);
  }
  return byBuddy;
}

export type OwnerPostInput = Omit<z.infer<typeof PostBodySchema>, 'asBuddyId' | 'mentionConfigs'>;

/**
 * The one way an owner-side post enters a channel: canonical media, the crate write and the
 * announcement, which carries the owner's mention-chip picks to the Buddy turns its @mentions
 * start (channels.ts, the one dispatch entry for every author). A replayed key announces nothing.
 * The owner post routes and the upstream update (upstream/routes.ts) both come here.
 */
// Pattern: one-write-path (docs/patterns.md#one-write-path)
export async function publishOwnerPost(
  deps: Pick<BuddyRouteDeps, 'core' | 'events' | 'uploadsRoot'>,
  author: Actor,
  ref: ChannelRef,
  input: OwnerPostInput,
  picks: MentionPicks
): Promise<{ post: Post }> {
  const target = await deps.core.openChannel(OWNER, ref);
  const body = requireCanonicalPostMedia(input.body, {
    uploadsRoot: deps.uploadsRoot(),
    channelId: target.id,
  });
  const { post, created } = await deps.core.post(
    author,
    { kind: 'id', id: target.id },
    { ...input, body, wakes: [] }
  );
  if (!created) return { post };
  deps.events.emit({ kind: 'changed' });
  await announcePost(deps, OWNER, post, picks);
  return { post };
}

const MEDIA = new Set<string>([...CHANNEL_IMAGE_EXTENSIONS, ...CHANNEL_VIDEO_EXTENSIONS]);

type Handler = (req: Request) => Promise<unknown>;
type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

// Pattern: table-driven (docs/patterns.md#table-driven) — one row per route, one registration loop.
// Pattern: idempotency-keys (docs/patterns.md#idempotency-keys) — every owner write carries `key`.
export function registerBuddyRoutes(app: Express, deps: BuddyRouteDeps): void {
  const { core, events, runner, channels } = deps;
  // A write changes Buddy state: clients refresh, and the runner wakes (it may have enqueued a run).
  const write = <T>(result: Promise<T>) =>
    result.then((value) => {
      events.emit({ kind: 'changed' });
      return value;
    });
  const p = (req: Request, name: string) => String(req.params[name]);
  const q = (req: Request, name: string) =>
    typeof req.query[name] === 'string' ? (req.query[name] as string) : undefined;
  // One feed page: keyset `before` an ordered id, or `from` a linked post (never both).
  const feedPage = (req: Request, query: PostQuery) => {
    const cursor = CursorSchema.parse(req.query);
    if (cursor.from !== undefined && cursor.before !== undefined)
      throw new Error('a page is `before` a cursor or `from` a post, not both');
    return cursor.from === undefined
      ? core.listPosts(
          OWNER,
          query,
          cursor.before === undefined ? null : { ord: cursor.before },
          cursor.limit
        )
      : core.listPostsFrom(OWNER, query, cursor.from, cursor.limit);
  };
  const posted = async <T extends Post>(post: Promise<T>) => {
    const written = await write(post);
    return announcePost(deps, OWNER, written, NO_PICKS);
  };
  const ownerPost = async (raw: unknown, ref: ChannelRef) => {
    const { asBuddyId, ...input } = PostBodySchema.parse(raw);
    const author = asBuddyId === undefined ? OWNER : buddyActor(asBuddyId);
    const chosen = mentionConfigsByBuddy(input.body, input.mentionConfigs);
    return publishOwnerPost(deps, author, ref, input, chosen);
  };
  const archive = async (buddyId: string, changes: BuddyChanges, changeKey: string) => {
    const buddy = await write(core.updateBuddy(OWNER, { buddyId, changes, key: changeKey }));
    if (buddy.status === 'archived') deps.onBuddyArchived(buddy.id);
    return buddy;
  };
  const putSchedule = (req: Request, id: string | undefined) =>
    write(
      core.putSchedule(OWNER, {
        ...ScheduleSchema.parse(req.body),
        id,
        buddyId: p(req, 'buddyId'),
        limits: '{}',
      })
    );
  const runQueries: Array<[string, (id: string) => RunQuery]> = [
    ['buddyId', (id) => ({ kind: 'buddy', buddyId: id })],
    ['taskId', (id) => ({ kind: 'task', taskId: id })],
    ['conversationId', (id) => ({ kind: 'conversation', conversationId: id })],
    ['liveInWorkspace', (id) => ({ kind: 'live', workspaceId: id })],
  ];

  const routes = {
    // ---- team -----------------------------------------------------------------------------------
    'GET 200 /api/buddies/overview': async () =>
      Promise.all(
        (await core.listWorkspaces()).map(async (w) => ({
          ...w,
          buddies: await core.listBuddies(w.id),
          // Directory cards' "N open · M blocked" (T22): one partial-index read per workspace.
          taskCounts: await core.taskCounts(w.id),
        }))
      ),
    [buddyMutationRoute('workspace.create')]: async (req) =>
      write(core.createWorkspace(OWNER, workspaceInput(req.body))),
    [buddyMutationRoute('builder.open')]: async (req) => {
      const { workspaceId } = BuilderOpenSchema.parse(req.body ?? {});
      if (workspaceId === undefined) return deps.createBuilderConversation();
      const workspace = (await core.listWorkspaces()).find((item) => item.id === workspaceId);
      if (!workspace) throw new CoreError('not_found', `workspace ${workspaceId}`);
      return deps.createBuilderConversation(workspace.rootPath);
    },
    [buddyMutationRoute('buddy.create')]: async (req) => {
      const { managerId, ...input } = BuddyCreateSchema.parse(req.body);
      return write(core.createBuddy(OWNER, { ...input, manager: managerRef(managerId ?? null) }));
    },
    [buddyMutationRoute('direct.open')]: (req) => channels.openDirect(p(req, 'buddyId')),
    'GET 200 /api/buddies/:buddyId/direct/chain': (req) => channels.directChain(p(req, 'buddyId')),
    [buddyMutationRoute('direct.new')]: (req) =>
      channels.newDirect(p(req, 'buddyId'), NewDirectSchema.parse(req.body ?? {})),
    [buddyMutationRoute('buddy.wake')]: (req) => channels.wake(p(req, 'buddyId')),
    // ---- docs -----------------------------------------------------------------------------------
    'GET 200 /api/buddies/:buddyId/docs/:kind': async (req) => {
      const buddyId = p(req, 'buddyId');
      const kind = docKind.parse(p(req, 'kind'));
      if (q(req, 'all') === '1') return core.listDocs(OWNER, buddyId, kind);
      const scope = scopeOf(q(req, 'scope') ?? 'buddy', q(req, 'scopeId'));
      return core.readDoc(OWNER, { buddyId, scope, kind, name: q(req, 'name') ?? '' });
    },
    [buddyMutationRoute('doc.write')]: async (req) => {
      const buddyId = p(req, 'buddyId');
      const { scope, scopeId, name, ...write_ } = DocWriteSchema.parse(req.body);
      const kind = docKind.parse(p(req, 'kind'));
      const doc = { buddyId, scope: scopeOf(scope, scopeId), kind, name };
      return write(core.writeDoc(OWNER, { doc, ...write_ }));
    },
    'GET 200 /api/buddies/docs/:docId/revisions': (req) =>
      core.docRevisions(OWNER, p(req, 'docId')),
    // ---- tasks (todos are child tasks) ----------------------------------------------------------
    'GET 200 /api/buddies/tasks': async (req) => {
      const buddyId = q(req, 'buddyId');
      const parentId = q(req, 'parentId');
      const query: TaskQuery = buddyId
        ? { kind: 'owner', buddyId }
        : parentId
          ? { kind: 'children', parentId }
          : { kind: 'workspace', workspaceId: z.string().min(1).parse(q(req, 'workspaceId')) };
      return core.listTasks(query);
    },
    'GET 200 /api/buddies/tasks/:taskId': async (req) => ({
      ...(await taskDetail(core, OWNER, p(req, 'taskId'), 100)),
      runs: await core.listRuns({ kind: 'task', taskId: p(req, 'taskId') }, 20),
    }),
    // The channel browser's Task filter: one Task's posts across every channel (T22).
    'GET 200 /api/buddies/tasks/:taskId/posts': (req) => {
      const cursor = CursorSchema.parse(req.query);
      const before = cursor.before === undefined ? null : { ord: cursor.before };
      return core.taskPosts(OWNER, p(req, 'taskId'), before, cursor.limit);
    },
    [buddyMutationRoute('task.create')]: (req) =>
      write(core.upsertTask(OWNER, { kind: 'create', ...TaskCreateSchema.parse(req.body) })),
    [buddyMutationRoute('task.update')]: (req) =>
      write(
        core.upsertTask(OWNER, {
          kind: 'update',
          taskId: p(req, 'taskId'),
          ...TaskUpdateSchema.parse(req.body),
        })
      ),
    // ---- runs -----------------------------------------------------------------------------------
    'GET 200 /api/buddies/runs': async (req) => {
      const found = runQueries.find(([name]) => q(req, name));
      if (!found) throw new Error('runs need buddyId, taskId, conversationId or liveInWorkspace');
      return core.listRuns(found[1](q(req, found[0])!), 100);
    },
    'GET 200 /api/buddies/runs/:runId': (req) => core.getRun(p(req, 'runId')),
    [buddyMutationRoute('run.cancel')]: (req) => runner.cancel(p(req, 'runId')),
    // ---- schedules ------------------------------------------------------------------------------
    'GET 200 /api/buddies/:buddyId/schedules': (req) =>
      core.listSchedules({ kind: 'buddy', buddyId: p(req, 'buddyId') }),
    [buddyMutationRoute('schedule.create')]: (req) => putSchedule(req, undefined),
    [buddyMutationRoute('schedule.update')]: (req) => putSchedule(req, p(req, 'scheduleId')),
    [buddyMutationRoute('schedule.run')]: (req) =>
      write(
        core.enqueueRun(OWNER, {
          buddyId: p(req, 'buddyId'),
          input: {
            kind: 'schedule',
            scheduleId: p(req, 'scheduleId'),
            slot: new Date().toISOString(),
          },
        })
      ),
    // ---- channels, DMs and the owner's inbox (everything is a post in a channel) ----------------
    'GET 200 /api/buddies/workspaces/:workspaceId/inbox': (req) =>
      core.inbox(OWNER, p(req, 'workspaceId')),
    // The channel Search panel shows the newest 50 hits plus the channels the words name; paging is
    // the Buddy tool's (channel_read). `@Name` in the text filters to that author (crate-side).
    'GET 200 /api/buddies/workspaces/:workspaceId/search': async (req) => {
      const workspaceId = p(req, 'workspaceId');
      const text = z.string().trim().min(1).parse(q(req, 'q'));
      const page = await core.searchPosts(
        OWNER,
        workspaceId,
        { text, channels: [], from: [] },
        null,
        50
      );
      const inbox = await core.inbox(OWNER, workspaceId);
      return {
        channels: channelsNamed(
          inbox.channels.map((row) => row.channel),
          text
        ),
        posts: page.posts,
      };
    },
    'GET 200 /api/buddies/workspaces/:workspaceId/channels/archived': (req) =>
      core.archivedChannels(OWNER, p(req, 'workspaceId')),
    [buddyMutationRoute('channel.archive')]: async (req) => {
      const { archived, key } = ChannelArchiveSchema.parse(req.body);
      const channelId = p(req, 'channelId');
      const channel = await write(core.setChannelArchived(OWNER, channelId, archived, key));
      deps.channelChanged(channelId);
      return channel;
    },
    [buddyMutationRoute('channel.rename')]: async (req) => {
      const { name, key } = ChannelRenameSchema.parse(req.body);
      const channelId = p(req, 'channelId');
      const channel = await write(core.renameChannel(OWNER, channelId, name, key));
      deps.channelChanged(channelId);
      return channel;
    },
    [buddyMutationRoute('channel.create')]: (req) =>
      write(
        core.createChannel(OWNER, {
          ...ChannelSchema.parse(req.body),
          workspaceId: p(req, 'workspaceId'),
        })
      ),
    'GET 200 /api/buddies/channels/:channelId': (req) =>
      core.openChannel(OWNER, { kind: 'id', id: p(req, 'channelId') }),
    // Each root carries its reply count and newest reply (T22: channel rows lost "3 replies ·
    // last reply 2m ago" in the T11 migration). One indexed query per page.
    'GET 200 /api/buddies/channels/:channelId/posts': async (req) => {
      const channelId = p(req, 'channelId');
      const page = await feedPage(req, { kind: 'channel', channelId });
      const roots = page.posts.map((post) => post.id);
      return { ...page, threads: await core.threadStats(OWNER, channelId, roots) };
    },
    'GET 200 /api/buddies/posts/:postId/thread': async (req) => {
      const root = await core.getPost(OWNER, p(req, 'postId'));
      return {
        root,
        ...(await feedPage(req, { kind: 'thread', rootId: root.id })),
        seats: await channels.threadSeats(root.id),
      };
    },
    [buddyMutationRoute('channel.post')]: (req) =>
      ownerPost(req.body, { kind: 'id', id: p(req, 'channelId') }),
    [buddyMutationRoute('direct.post')]: (req) => {
      const { members, ...body } = DirectPostSchema.parse(req.body);
      return ownerPost(body, { kind: 'direct', members: [OWNER, ...members.map(buddyActor)] });
    },
    // A failed reply's retry on another harness (493c1c7); the new attempt is a later reply.
    [buddyMutationRoute('reply.retry')]: async (req) =>
      channels.retryReply(
        await core.getPost(OWNER, p(req, 'postId')),
        RetrySchema.parse(req.body).config
      ),
    [buddyMutationRoute('request.answer')]: async (req) => {
      const input = AnswerSchema.parse(req.body);
      return (await posted(core.answer(OWNER, { requestId: p(req, 'postId'), ...input }))).post;
    },
    // Read through `postId`, the newest post the client rendered: a post that landed after the
    // render stays unread. The push clears the channel on the owner's other devices.
    [buddyMutationRoute('channel.read')]: async (req) => {
      const { postId } = ReadSchema.parse(req.body);
      await core.markRead(OWNER, p(req, 'channelId'), postId);
      deps.channelChanged(p(req, 'channelId'));
      return { ok: true };
    },
    // The Threads view (THREADS_VIEW_2026-09-28.md): followed threads, unread first.
    'GET 200 /api/buddies/workspaces/:workspaceId/threads': (req) =>
      core.followedThreads(
        OWNER,
        p(req, 'workspaceId'),
        z.coerce.number().int().min(1).max(200).default(30).parse(q(req, 'limit'))
      ),
    // Read a followed thread through `postId`; the channel's own cursor is left alone.
    [buddyMutationRoute('thread.read')]: async (req) => {
      const { postId } = ReadSchema.parse(req.body);
      const root = await core.getPost(OWNER, p(req, 'rootId'));
      await core.markThreadRead(OWNER, root.id, postId);
      deps.channelChanged(root.channelId);
      return { ok: true };
    },
    'GET 200 /api/buddies/channels/:channelId/responding': async (req) =>
      channels.responding(p(req, 'channelId')),
    // ---- one buddy: last, so `/api/buddies/tasks` and friends never read as a buddy id ----------
    'GET 200 /api/buddies/:buddyId': async (req) => {
      const buddyId = p(req, 'buddyId');
      const [buddy, tasks, schedules, runs] = await Promise.all([
        core.getBuddy(buddyId),
        core.listTasks({ kind: 'owner', buddyId }),
        core.listSchedules({ kind: 'buddy', buddyId }),
        core.listRuns({ kind: 'buddy', buddyId }, 30),
      ]);
      return { buddy, tasks, schedules, runs };
    },
    [buddyMutationRoute('buddy.update')]: (req) => {
      const { key: changeKey, ...changes } = BuddyPatchSchema.parse(req.body);
      return archive(p(req, 'buddyId'), buddyChanges(changes), changeKey);
    },
    [buddyMutationRoute('buddy.archive')]: (req) =>
      archive(p(req, 'buddyId'), { status: 'archived' }, `archive:${p(req, 'buddyId')}`),
  } satisfies Record<string, Handler> & {
    [K in Exclude<BuddyMutation, 'upstream.update'> as BuddyMutationRoute<K>]: (
      req: Request
    ) => Promise<BuddyMutationResults[K]>;
  };

  // Each key is `METHOD STATUS path`; order matters (a `:buddyId` route comes last).
  for (const [route, handle] of Object.entries(routes)) {
    const [method, status, path] = route.split(' ');
    app[method.toLowerCase() as Method](path, (req: Request, res: Response) => {
      // Synchronous schema failures escaped to Express's HTML error page; the UI called them
      // "feature unavailable". Guard: malformed task patch over owner HTTP (buddies-v2.test.ts).
      Promise.resolve()
        .then<unknown>(() => handle(req))
        .then(
          (body) => res.status(Number(status)).json(body ?? null),
          (error: unknown) => {
            const typed = coreError(error);
            const code = typed ? typed.httpStatus : error instanceof z.ZodError ? 400 : 500;
            if (code >= 500) console.error('[buddies] request failed:', error);
            const message = error instanceof Error ? error.message : String(error);
            res.status(code).json({ error: typed?.message ?? message });
          }
        );
    });
  }

  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, _file, callback) => {
        try {
          const directory = channelMediaDirectory(deps.uploadsRoot(), String(req.params.channelId));
          fs.mkdirSync(directory, { recursive: true });
          callback(null, directory);
        } catch (error) {
          callback(error as Error, '');
        }
      },
      filename: (_req, file, callback) =>
        callback(null, `${Date.now()}_${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`),
    }),
    limits: { fileSize: CHANNEL_MEDIA_MAX_BYTES, files: 10 },
    fileFilter: (_req, file, callback) =>
      callback(
        null,
        MEDIA.has(file.originalname.slice(file.originalname.lastIndexOf('.')).toLowerCase())
      ),
  });
  // Lands in the channel's media directory, so the composer's ![name](absolutePath) passes as-is.
  app.post('/api/buddies/channels/:channelId/media', upload.array('files', 10), (req, res) => {
    const files = req.files as Express.Multer.File[];
    if (files.length === 0)
      return void res
        .status(400)
        .json({ error: `No supported media: ${[...MEDIA].join(' ')} up to 50 MB` });
    const saved = files.map((f) => ({
      originalName: f.originalname,
      absolutePath: f.path,
      mimeType: f.mimetype,
      size: f.size,
    }));
    res.status(201).json({ files: saved } satisfies BuddyMediaResult);
  });
}
