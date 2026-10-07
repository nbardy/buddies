import type { Inbox, Post, Run, RunRow, Task } from '@unleashd/buddies-core';
import { bodyText } from '@unleashd/shared';
import type { MessageSource } from '../conversations/messages';
import { CoreError } from './core';

/**
 * What a Buddy's tools show of a record. Every view here is a SLIM projection: the full record is
 * one `get` away, and a list or preview says so by carrying only ids, short labels and a clipped
 * body. Fix-guard: until 2026-10-06 `tasks get` returned 60-95k chars (20 full comments, every
 * child task, uncapped evidence), `runs list` repeated each run's whole error and `inbox` carried
 * every owed request's full 32k body; one call could fill a turn's context (CEO feedback triage,
 * agent_notes/2026-10-06_ceo-tooling-feedback-triage.md). Guard: the "slim read surface" test in
 * server/test/buddies-v2.test.ts, which asserts a size bound on a seeded store.
 */

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max)}…`);

export const PREVIEW_CHARS = 300;
const ERROR_CHARS = 500;
/** A Task's evidence is pointers (a commit, a path, a test run), not a transcript. */
export const EVIDENCE_MAX_ENTRIES = 32;
export const EVIDENCE_MAX_CHARS = 500;

/**
 * Evidence is capped where it is WRITTEN (the Task row is read on every `tasks get` forever, so a
 * long entry costs every later reader). A typed `invalid` error names the offending entry, so the
 * writer moves the long content into a file and cites the path instead of being cut silently.
 */
export function checkedEvidence(evidence: readonly string[]): readonly string[] {
  if (evidence.length > EVIDENCE_MAX_ENTRIES)
    throw new CoreError(
      'invalid',
      `task evidence takes at most ${EVIDENCE_MAX_ENTRIES} entries, got ${evidence.length}. Keep the newest pointers; long content goes in a file`
    );
  const long = evidence.findIndex((entry) => entry.length > EVIDENCE_MAX_CHARS);
  if (long >= 0)
    throw new CoreError(
      'invalid',
      `task evidence entry ${long} is ${evidence[long].length} chars (max ${EVIDENCE_MAX_CHARS}). Put the content in a file and cite its path`
    );
  return evidence;
}

// ---- inbox -----------------------------------------------------------------------------------

const postPreview = (post: Post) => ({
  id: post.id,
  channelId: post.channelId,
  author: post.author,
  rootId: post.rootId,
  replyToId: post.replyToId,
  taskId: post.taskId,
  purpose: post.purpose,
  request: post.request,
  createdAt: post.createdAt,
  bodyChars: post.body.length,
  body: clip(post.body, PREVIEW_CHARS),
});

/** Requests as previews (`channel_read` has the body); channels only if unread (F8: 17k inbox). */
export const inboxView = ({ channels, ...inbox }: Inbox) => ({
  ...inbox,
  channels: channels.filter((row) => row.unread > 0),
  readChannels: channels.filter((row) => row.unread === 0).length,
  requests: inbox.requests.map(postPreview),
  waitingOn: inbox.waitingOn.map(postPreview),
});

// ---- tasks -----------------------------------------------------------------------------------

type TaskDetail = {
  task: Task;
  channel: unknown;
  children: Task[];
  comments: Post[];
};

/** `tasks get` for a Buddy: the task, its children as list rows, comments as previews. */
export const taskDetailView = ({ task, channel, children, comments }: TaskDetail) => ({
  task: { ...task, evidence: task.evidence.map((entry) => clip(entry, EVIDENCE_MAX_CHARS)) },
  channel,
  children: children.map(({ id, ownerId, title, status, paused, updatedAt }) => ({
    id,
    ownerId,
    title,
    status,
    paused,
    updatedAt,
  })),
  comments: comments.map((post) => ({
    id: post.id,
    author: post.author,
    createdAt: post.createdAt,
    evidenceCount: post.evidence.length,
    bodyChars: post.body.length,
    body: clip(post.body, PREVIEW_CHARS),
  })),
});

// ---- runs ------------------------------------------------------------------------------------

/**
 * Run rows with what each run is FOR: the post's `purpose` and its Task's title, joined by the
 * crate's row SQL (F4, 2026-10-06; it was one `getPost` and one `getTask` per row). Absence is
 * meaning: `purpose` is null when the run has no post (a chat, a retired kind) or the post is not
 * one this Buddy may read (a DM between others). The error is clipped; `runs get` returns the
 * whole one.
 */
export function runRowsView(rows: RunRow[]) {
  return rows.map((row) => ({
    ...row,
    purpose: row.purpose ?? null,
    taskTitle: row.taskTitle ?? null,
    error: row.error === undefined ? undefined : clip(row.error, ERROR_CHARS),
  }));
}

export const TAIL_MAX = 20;
const TAIL_TEXT_CHARS = 600;
const TAIL_ARGS_CHARS = 200;
// An assistant turn is several rows (text, then each tool call): four rows per wanted entry reach
// `n` entries in practice and bound the read.
const TAIL_ROWS_PER_ENTRY = 4;

/**
 * The last `n` assistant entries of a run's conversation: its text and the NAMES of the tools it
 * called, arguments clipped. Audit-only (decision L2): it answers "what did that worker say last",
 * e.g. to doubt an answer that came back, without opening the whole transcript. Read through
 * `MessageSource`, the one source of message bodies, in a window bounded by `n`.
 */
export async function runTail(messages: MessageSource, run: Run, n: number) {
  if (run.conversationId === undefined) return [];
  const probe = await messages(run.conversationId, { afterSeq: -1, limit: 1 });
  if (probe === null) return [];
  const afterSeq = Math.max(-1, probe.total - 1 - n * TAIL_ROWS_PER_ENTRY);
  const page = await messages(run.conversationId, { afterSeq, limit: n * TAIL_ROWS_PER_ENTRY });
  return (page?.messages ?? [])
    .filter((m) => m.role === 'assistant' && (m.body.t === 'parts' || m.body.text !== ''))
    .slice(-n)
    .map((message) => ({
      at: message.timestamp,
      text: clip(bodyText(message.body), TAIL_TEXT_CHARS) || undefined,
      tools:
        message.body.t === 'text'
          ? []
          : message.body.parts.flatMap((part) =>
              part.t === 'tool'
                ? [
                    {
                      name: part.name,
                      args: clip(JSON.stringify(part.input ?? null), TAIL_ARGS_CHARS),
                    },
                  ]
                : []
            ),
    }));
}
