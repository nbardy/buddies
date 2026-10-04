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
 * The composer never shows raw tokens: picking from the universal @ menu
 * inserts `@Label` and records the reference; `encodeReferences` swaps the
 * labels for tokens on send.
 */
import {
  type ChannelComposerDraft,
  ChannelComposerDraftSchema,
  type ChannelReference,
  type ConversationConfig,
  type ProviderCatalog,
} from '@unleashd/shared';
import { modelSummary } from '../../views/config/config-options';
import type { Task, TaskStatus, ThreadSeat } from './types';

// A Buddy carries what its turn runs on by default, so the composer's mention
// chip can show it and open the harness/model picker from it. The type is the
// shared schema's, because composer drafts persist picks (see Drafts below).
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

// Finished Tasks stay findable but sink below live ones with a similar match.
const SETTLED_TASK_PENALTY = 12;

function referenceScore(query: string, reference: ChannelReference): number | null {
  const score = fuzzyScore(query, reference.label);
  if (score === null) return null;
  switch (reference.kind) {
    case 'buddy':
      return score;
    case 'task':
      return reference.status === 'done' || reference.status === 'cancelled'
        ? score - SETTLED_TASK_PENALTY
        : score;
  }
}

export function rankReferences(
  query: string,
  references: readonly ChannelReference[],
  limit = 8
): ChannelReference[] {
  return references
    .map((reference) => ({ reference, score: referenceScore(query, reference) }))
    .filter(
      (entry): entry is { reference: ChannelReference; score: number } => entry.score !== null
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.reference);
}

// ── The @ trigger ──────────────────────────────────────────────────────────

const MAX_QUERY_LENGTH = 40;

/**
 * The @-query under the caret, if the caret sits in one: an `@` at the start
 * of the text or after whitespace, followed by up to 40 characters with no
 * newline. Spaces are allowed so Task titles can be typed ("@fix login").
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

/**
 * True when the @ query is a reference the owner already picked: picking
 * inserts `@Label `, and because a query may contain spaces that text is
 * itself a live query that still fuzzy-matches everything, so the menu stayed
 * open after Enter and covered the mention chip's model picker (2026-09-24).
 * A query that is still the start of some label ("Lead Des" toward "Lead
 * Designer" after picking "Lead") keeps the menu open.
 */
export function completesPickedReference(
  query: string,
  picked: readonly ChannelReference[],
  references: readonly ChannelReference[]
): boolean {
  const typed = query.toLowerCase();
  return (
    picked.some((reference) => query.startsWith(`${reference.label} `)) &&
    !references.some((reference) => reference.label.toLowerCase().startsWith(typed))
  );
}

export function insertReference(
  text: string,
  trigger: { start: number; query: string },
  reference: ChannelReference
): { text: string; caret: number } {
  const inserted = `@${reference.label} `;
  const end = trigger.start + 1 + trigger.query.length;
  return {
    text: text.slice(0, trigger.start) + inserted + text.slice(end),
    caret: trigger.start + inserted.length,
  };
}

// ── Encoding ───────────────────────────────────────────────────────────────

function linkText(label: string): string {
  return label.replace(/[[\]]/g, '');
}

export function referenceToken(reference: ChannelReference): string {
  switch (reference.kind) {
    case 'buddy':
      return `[@${linkText(reference.label)}](buddy:${reference.id})`;
    case 'task':
      return `[${linkText(reference.label)}](task:${reference.id})`;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The same match `encodeReferences` turns into a token: longer labels first,
 * and a label must end at a boundary. The composer highlight uses these
 * ranges so `@Lead` is marked in the input exactly when send will mention Lead.
 */
function pickedReferencePattern(references: readonly ChannelReference[]): {
  pattern: RegExp;
  byLabel: Map<string, ChannelReference>;
} | null {
  const unique = new Map(
    references.map((reference) => [`${reference.kind}:${reference.id}`, reference])
  );
  const ordered = [...unique.values()].sort((a, b) => b.label.length - a.label.length);
  if (ordered.length === 0) return null;
  return {
    pattern: new RegExp(
      `(^|\\s)@(${ordered.map((reference) => escapeRegExp(reference.label)).join('|')})(?=$|[\\s.,:;!?)])`,
      'g'
    ),
    byLabel: new Map(ordered.map((reference) => [reference.label, reference])),
  };
}

/**
 * Replace every `@Label` the user picked with its token. Longer labels go
 * first and a label must end at a word boundary, so picking both "Lead" and
 * "Lead Designer" never turns "@Lead Designer" into "[@Lead](…) Designer".
 * References whose label was deleted from the text simply do not appear.
 */
export function encodeReferences(text: string, references: readonly ChannelReference[]): string {
  const matched = pickedReferencePattern(references);
  if (!matched) return text;
  const { pattern, byLabel } = matched;
  return text.replace(pattern, (_whole, lead: string, label: string) => {
    const reference = byLabel.get(label);
    return reference ? `${lead}${referenceToken(reference)}` : _whole;
  });
}

export type ComposerReferenceMark = {
  start: number;
  end: number;
  kind: ChannelReference['kind'];
};

/** `@Label` spans in the composer that send will turn into mention or Task tokens. */
export function composerReferenceMarks(
  text: string,
  references: readonly ChannelReference[]
): ComposerReferenceMark[] {
  const matched = pickedReferencePattern(references);
  if (!matched) return [];
  const { pattern, byLabel } = matched;
  const marks: ComposerReferenceMark[] = [];
  for (const match of text.matchAll(pattern)) {
    const lead = match[1] ?? '';
    const label = match[2];
    const reference = label ? byLabel.get(label) : undefined;
    if (!reference || match.index === undefined || !label) continue;
    const start = match.index + lead.length;
    marks.push({ start, end: start + 1 + label.length, kind: reference.kind });
  }
  return marks;
}

export type BuddyReference = Extract<ChannelReference, { kind: 'buddy' }>;

const MENTION_TOKEN = /\]\(buddy:([A-Za-z0-9_-]+)\)/g;

/** Whether a post body @mentions a Buddy: its reply (or a notice) will land in the post's thread. */
export const mentionsABuddy = (body: string) => /\]\(buddy:[A-Za-z0-9_-]+\)/.test(body);

/**
 * The picked Buddies whose mention survives in the text, in mention order:
 * the composer's mention chips. Derived from the same encoding as send, so a
 * chip exists exactly when the post will start that Buddy's turn — and a model
 * choice is never sent for a Buddy the post no longer mentions (the server
 * rejects that post).
 */
export function mentionedBuddies(
  text: string,
  picked: readonly ChannelReference[],
  directory: readonly ChannelReference[] = picked
): BuddyReference[] {
  const byId = new Map(
    picked
      .filter((reference): reference is BuddyReference => reference.kind === 'buddy')
      .map((reference) => [reference.id, reference])
  );
  const ids = new Set([...encodeReferences(text, picked).matchAll(MENTION_TOKEN)].map((m) => m[1]));
  return [...ids].flatMap((id) => {
    const reference = byId.get(id);
    if (!reference) return [];
    // Drafts retain mention identity, not a second owner of the Buddy's current default.
    // Guard: restored mention uses current profile rather than its stored execution snapshot.
    const current = directory.find((entry) => entry.kind === 'buddy' && entry.id === id);
    return [
      {
        ...reference,
        execution: current?.kind === 'buddy' ? current.execution : { kind: 'unreported' as const },
      },
    ];
  });
}

// ── Drafts ─────────────────────────────────────────────────────────────────

/**
 * The composer's draft id for `useConversationDraft` (the chat's draft hook,
 * stored at `draft:<id>`): one per channel and one per thread.
 */
export function channelDraftId(channelId: string, rootId: string | null): string {
  return rootId === null ? `channel:${channelId}` : `channel:${channelId}:thread:${rootId}`;
}

export const EMPTY_CHANNEL_DRAFT: ChannelComposerDraft = { text: '', picked: [] };

/** Empty text stores '' so the draft hook deletes the key instead of keeping `{}`. */
export function encodeChannelDraft(draft: ChannelComposerDraft): string {
  return draft.text === '' ? '' : JSON.stringify(draft);
}

/**
 * A stored draft back into composer state. Local storage is outside the type
 * system: a blob that is not a draft (hand-edited, or an older shape) is
 * discarded whole, the same policy as atoms/ui.ts validatedStorage.
 */
export function decodeChannelDraft(stored: string): ChannelComposerDraft {
  if (stored === '') return EMPTY_CHANNEL_DRAFT;
  try {
    const parsed = ChannelComposerDraftSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : EMPTY_CHANNEL_DRAFT;
  } catch {
    return EMPTY_CHANNEL_DRAFT;
  }
}

// ── Media ──────────────────────────────────────────────────────────────────

const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov']);

export function mediaMarkdown(file: { originalName: string; absolutePath: string }): string {
  const alt = linkText(file.originalName.replace(/\.[^.]+$/, ''));
  return `![${alt}](${file.absolutePath})`;
}

/** Local absolute paths render through the authenticated file route. */
export function mediaUrl(source: string): string {
  return source.startsWith('/') && !source.startsWith('/api/')
    ? `/api/files?path=${encodeURIComponent(source)}`
    : source;
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
 * A Task as a chip and the @ menu show it: from GET /api/buddies/tasks?workspaceId=
 * (every task of the workspace; todos are its child tasks), with the owner's
 * name and todo progress resolved.
 */
export type ChannelTask = {
  id: string;
  title: string;
  status: TaskStatus;
  ownerId: string;
  ownerName: string;
  /** A todo (child task) is false: it never appears in the @ menu. */
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
// profileExecution); there is nothing honest to open the picker at.
export type MentionChoice =
  | { kind: 'chosen'; config: ConversationConfig }
  | { kind: 'seat'; config: ConversationConfig }
  | { kind: 'profile'; config: ConversationConfig }
  | { kind: 'loading' }
  | { kind: 'unreported' };

export function mentionChoice(
  buddy: BuddyReference,
  choices: ReadonlyMap<string, ConversationConfig>,
  seats: readonly ThreadSeat[] | undefined
): MentionChoice {
  const chosen = choices.get(buddy.id);
  if (chosen) return { kind: 'chosen', config: chosen };
  if (seats === undefined) return { kind: 'loading' };
  const seat = seats.find((entry) => entry.buddyId === buddy.id);
  if (seat) return { kind: 'seat', config: seat.config };
  switch (buddy.execution.kind) {
    case 'profile':
      return { kind: 'profile', config: buddy.execution.config };
    case 'unreported':
      return { kind: 'unreported' };
  }
}

export function choiceLabel(choice: MentionChoice, catalog: ProviderCatalog | null): string {
  if (choice.kind === 'loading') return 'Loading model…';
  return choice.kind === 'unreported' ? 'default' : modelSummary(choice.config, catalog);
}
