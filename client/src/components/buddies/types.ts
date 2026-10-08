/**
 * client/src/components/buddies/types.ts
 *
 * The Buddy owner API's shapes (server/src/buddies/routes.ts). Every domain
 * type is the crate's generated one (`@unleashd/buddies-core`, the same
 * `index.d.ts` the server compiles against), so a crate rename fails the
 * client build instead of drifting. Only the route envelopes are declared here.
 * Pure types: mobile may import this file (gate G3).
 */
import type {
  Buddy,
  Channel,
  Cursor,
  Post,
  PostPage,
  Run,
  Schedule,
  Task,
  TaskCount,
  ThreadStat,
  Workspace,
} from '@unleashd/buddies-core';
import type { BuddyMutationResults, ConversationConfig } from '@unleashd/shared';

// Pattern: one-type-source (docs/patterns.md#one-type-source)
export type {
  Actor,
  Buddy,
  Channel,
  ChannelKind,
  ChannelUnread,
  Cursor,
  Doc,
  DocKind,
  FollowedThread,
  FollowedThreads,
  DocRevision,
  DocScope,
  Inbox,
  Post,
  PostPage,
  Run,
  RunInput,
  RunStatus,
  Schedule,
  Task,
  TaskCount,
  TaskStatus,
  ThreadStat,
  Workspace,
} from '@unleashd/buddies-core';

/** A Buddy page section; each is a URL segment (buddy-tabs.ts). */
export type EmployeeTab =
  | 'conversations'
  | 'work'
  | 'mailbox'
  | 'background'
  | 'memory'
  | 'working-memory'
  | 'long-term-memory'
  | 'recent-tasks'
  | 'schedules'
  | 'settings';

/**
 * GET /api/buddies/overview: one entry per workspace, archived Buddies included. `taskCounts`
 * names only Buddies with unfinished top-level tasks (the crate's `taskCounts`).
 */
export type WorkspaceRoster = Workspace & { buddies: Buddy[]; taskCounts: TaskCount[] };
export type BuddyOverview = WorkspaceRoster[];

/** GET /api/buddies/:buddyId */
export interface BuddyDetail {
  buddy: Buddy;
  tasks: Task[];
  schedules: Schedule[];
  runs: Run[];
}

/** GET /api/buddies/tasks/:taskId — comments are the task channel's posts, newest first. */
export interface TaskDetail {
  task: Task;
  channel: Channel;
  children: Task[];
  comments: Post[];
  runs: Run[];
}

/** GET /api/buddies/channels/:channelId/posts — top-level posts, each root's reply stats beside. */
export type ChannelPage = PostPage & { threads: ThreadStat[] };

/** A Buddy's latest seat in a thread: what its next reply runs on (server channels.ts). */
export type ThreadSeat = { buddyId: string; config: ConversationConfig };

/** GET /api/buddies/posts/:postId/thread — replies newest first, and each Buddy's seat. */
export interface ThreadPage {
  root: Post;
  posts: Post[];
  next?: Cursor;
  seats: ThreadSeat[];
}

export type { ChannelResponse } from '@unleashd/shared';

/**
 * POST /api/buddies/channels/:channelId/posts (and /direct/posts). A mention's turn starts from
 * the server's post announcement; its reply, or a notice saying why not, lands in the thread.
 */
export type PostResult = BuddyMutationResults['channel.post'];
