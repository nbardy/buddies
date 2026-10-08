import { isLocalFilePath } from '@unleashd/shared';
/**
 * client/src/components/buddies/channel-text.ts
 *
 * Pure text rules for channel posts. Pure and CSS-free so mobile may import it.
 *
 * A post body is markdown. References are markdown links with app schemes:
 *   `[@Name](buddy:<id>)`   a mention — starts that Buddy's turn, whoever wrote it
 *   `[Title](task:<id>)`    a Task, rendered as a live status chip
 *   `![alt](/abs/path)`     inline image or video, served through /api/files
 *
 * Their one interpretation is shared/src/body-references.ts; the composer's draft is
 * composer-draft.ts. This file keeps the @ menu ranking, media, tasks and the mention chip.
 */
import type { ChannelReference, ConversationConfig, ProviderCatalog } from '@unleashd/shared';
import { modelSummary } from '../../views/config/config-options';
import type { Task, TaskStatus, ThreadSeat } from './types';

// A Buddy carries what its turn runs on by default, so the composer's mention
// chip can show it and open the harness/model picker from it.
export type { ChannelReference };

// ── Fuzzy matching ─────────────────────────────────────────────────────────

/**
 * Subsequence match, scored so that word starts and consecutive runs win:
 * "pdl" ranks "Product Development Lead" above "Upload deadline". Null when
 * the query is not a subsequence of the text.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const needle = query.toLowerCase().replace(/\s+/g, '');
  const haystack = text.toLowerCase();
  if (needle.length === 0) return 0;
  let score = 0;
  let previous = -2;
  let position = 0;
  for (const char of needle) {
    const found = haystack.indexOf(char, position);
    if (found < 0) return null;
    const atWordStart = found === 0 || /[\s_\-/.:]/.test(haystack[found - 1]);
    score += found === previous + 1 ? 6 : 1;
    if (atWordStart) score += 8;
    if (found === 0) score += 4;
    previous = found;
    position = found + 1;
  }
  // Prefer shorter texts among equal matches.
  return score - haystack.length * 0.05;
}

// Pattern: one-definition (docs/patterns.md#one-definition)
// Fix-guard: Task suggestions crowded the eight @ slots; the menu now selects Buddies only.
// channel-text.test.ts checks empty, matching and task-only queries against mixed references.
export function rankReferences(
  query: string,
  references: readonly ChannelReference[],
  limit = 8
): BuddyReference[] {
  return references
    .filter((reference): reference is BuddyReference => reference.kind === 'buddy')
    .map((reference) => ({ reference, score: fuzzyScore(query, reference.label) }))
    .filter((entry): entry is { reference: BuddyReference; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.reference);
}

// ── The @ trigger ──────────────────────────────────────────────────────────

const MAX_QUERY_LENGTH = 40;

/**
 * The @-query under the caret, if the caret sits in one: an `@` at the start
 * of the text or after whitespace, followed by up to 40 characters with no
 * newline. Spaces are allowed so full Buddy names can be typed ("@Product Dev").
 */
export function activeReferenceQuery(
  text: string,
  caret: number
): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (query.length > MAX_QUERY_LENGTH || query.includes('\n')) return null;
  return { start: at, query };
}

export type BuddyReference = Extract<ChannelReference, { kind: 'buddy' }>;

// ── Drafts ─────────────────────────────────────────────────────────────────

/**
 * The composer's draft id for `useConversationDraft` (the chat's draft hook,
 * stored at `draft:<id>`): one per channel and one per thread.
 */
export function channelDraftId(channelId: string, rootId: string | null): string {
  return rootId === null ? `channel:${channelId}` : `channel:${channelId}:thread:${rootId}`;
}

// ── Media ──────────────────────────────────────────────────────────────────

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov']);

const linkText = (label: string) => label.replace(/[[\]]/g, '');

export function mediaMarkdown(file: { originalName: string; absolutePath: string }): string {
  // Fix-guard: PDF/ZIP uploads used image markdown and rendered broken previews.
  // channel-markdown.test.tsx exercises upload framing through the real renderer.
  const preview = isImageSource(file.absolutePath) || isVideoSource(file.absolutePath);
  const label = linkText(preview ? file.originalName.replace(/\.[^.]+$/, '') : file.originalName);
  const target = /[\s()<>]/.test(file.absolutePath)
    ? `<${file.absolutePath.replaceAll('<', '%3C').replaceAll('>', '%3E')}>`
    : file.absolutePath;
  return `${preview ? '!' : ''}[${label}](${target})`;
}

/** Local absolute paths render through the authenticated file route. */
export function mediaUrl(source: string): string {
  return isLocalFilePath(source) ? `/api/files?path=${encodeURIComponent(source)}` : source;
}

export type ChannelFileKind = 'image' | 'video' | 'markdown' | 'pdf';

/** Local files and authenticated file URLs use the same preview classification. */
export function channelFilePreview(source: string): { kind: ChannelFileKind; src: string } | null {
  let localPath = source;
  if (source.startsWith('/api/files?'))
    localPath = new URL(source, 'http://localhost').searchParams.get('path') ?? '';
  else if (source.startsWith('/api/serve/')) {
    try {
      localPath = decodeURIComponent(source.slice('/api/serve'.length));
    } catch {
      return null;
    }
  } else if (!isLocalFilePath(source)) return null;
  const extension = localPath.slice(localPath.lastIndexOf('.')).toLowerCase();
  const kind = isImageSource(localPath)
    ? 'image'
    : isVideoSource(localPath)
      ? 'video'
      : ['.md', '.markdown'].includes(extension)
        ? 'markdown'
        : extension === '.pdf'
          ? 'pdf'
          : null;
  return kind === null ? null : { kind, src: mediaUrl(localPath) };
}

export function isImageSource(source: string): boolean {
  const path = source.split(/[?#]/)[0].toLowerCase();
  return IMAGE_EXTENSIONS.has(path.slice(path.lastIndexOf('.')));
}

export function isVideoSource(source: string): boolean {
  const path = source.split(/[?#]/)[0].toLowerCase();
  const dot = path.lastIndexOf('.');
  return dot >= 0 && VIDEO_EXTENSIONS.has(path.slice(dot));
}

// Readable one-line text for previews (reply summaries, the thread header).
export function plainChannelText(body: string): string {
  return body
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_whole, alt: string) => `[${alt || 'image'}]`)
    .replace(/\[@([^\]]+)\]\(buddy:[^)]+\)/g, '@$1')
    .replace(/\[([^\]]+)\]\(task:[^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Tasks ──────────────────────────────────────────────────────────────────

/**
 * A Task as a live post chip shows it: from GET /api/buddies/tasks?workspaceId=
 * (every task of the workspace; todos are its child tasks), with the owner's
 * name and todo progress resolved.
 */
export type ChannelTask = {
  id: string;
  title: string;
  status: TaskStatus;
  ownerId: string;
  ownerName: string;
  /** Whether this is a top-level Task rather than a child todo. */
  topLevel: boolean;
  nextAction: string | undefined;
  todosDone: number;
  todosTotal: number;
};

export function channelTasks(
  tasks: readonly Task[],
  buddyNames: Readonly<Record<string, string>>
): ChannelTask[] {
  const children = new Map<string, Task[]>();
  for (const task of tasks) {
    if (task.parentId === undefined) continue;
    children.set(task.parentId, [...(children.get(task.parentId) ?? []), task]);
  }
  return tasks.map((task) => {
    const todos = (children.get(task.id) ?? []).filter((todo) => todo.status !== 'cancelled');
    return {
      id: task.id,
      title: task.title,
      status: task.status,
      ownerId: task.ownerId,
      ownerName: buddyNames[task.ownerId] ?? task.ownerId,
      topLevel: task.parentId === undefined,
      nextAction: task.nextAction,
      todosDone: todos.filter((todo) => todo.status === 'done').length,
      todosTotal: todos.length,
    };
  });
}

/** App links inside a post body: D = Buddy ⊕ Task ⊕ Web. */
export type ChannelLink =
  | { kind: 'buddy'; id: string }
  | { kind: 'task'; id: string }
  | { kind: 'web'; href: string };

export function parseChannelLink(href: string): ChannelLink {
  if (href.startsWith('buddy:')) return { kind: 'buddy', id: href.slice('buddy:'.length) };
  if (href.startsWith('task:')) return { kind: 'task', id: href.slice('task:'.length) };
  return { kind: 'web', href };
}

// ── Mention chip ───────────────────────────────────────────────────────────

// What a mentioned Buddy's reply will run on, as the chip and picker see it.
// `seat` is its latest harness/model/reasoning in this thread (493c1c7: the chip
// showed the profile default there, the wrong baseline for a change). `profile`
// is exact only when the Buddy has no seat here yet. `unreported` is a profile
// whose harness this client's schema does not know (channel-data.ts
// profileExecution); there is nothing honest to open the picker at. `no-agent` is an
// unpinned profile on an install with no agent: the reply would fail, so the chip says so.
// `failed`: the thread's seats could not be read. Not `loading` (that waits forever) and not
// the profile (it may not be the thread's model): the chip offers a retry and the server
// resolves the seat when the post lands.
export type MentionChoice =
  | { kind: 'chosen'; config: ConversationConfig }
  | { kind: 'seat'; config: ConversationConfig }
  | { kind: 'profile'; config: ConversationConfig }
  | { kind: 'loading' }
  | { kind: 'failed' }
  | { kind: 'unreported' }
  | { kind: 'no-agent' };

// A thread's seats as the composer holds them: still loading, read, or unreadable.
export type ThreadSeats =
  | { kind: 'loading' }
  | { kind: 'loaded'; seats: readonly ThreadSeat[] }
  | { kind: 'failed' };

export function mentionChoice(
  buddy: BuddyReference,
  choices: ReadonlyMap<string, ConversationConfig>,
  threadSeats: ThreadSeats
): MentionChoice {
  const chosen = choices.get(buddy.id);
  if (chosen) return { kind: 'chosen', config: chosen };
  switch (threadSeats.kind) {
    case 'loading':
      return { kind: 'loading' };
    case 'failed':
      return { kind: 'failed' };
    case 'loaded':
      return profileOrSeat(buddy, threadSeats.seats);
  }
}

function profileOrSeat(buddy: BuddyReference, seats: readonly ThreadSeat[]): MentionChoice {
  const seat = seats.find((entry) => entry.buddyId === buddy.id);
  if (seat) return { kind: 'seat', config: seat.config };
  switch (buddy.execution.kind) {
    case 'profile':
      return { kind: 'profile', config: buddy.execution.config };
    case 'unreported':
      return { kind: 'unreported' };
    case 'resolving':
      return { kind: 'loading' };
    case 'no-agent':
      return { kind: 'no-agent' };
  }
}

export function choiceLabel(choice: MentionChoice, catalog: ProviderCatalog | null): string {
  switch (choice.kind) {
    case 'loading':
      return 'Loading model…';
    case 'failed':
      return 'Model unavailable · retry';
    case 'unreported':
      return 'default';
    case 'no-agent':
      return 'Needs an agent';
    case 'chosen':
    case 'seat':
    case 'profile':
      return modelSummary(choice.config, catalog);
  }
}
