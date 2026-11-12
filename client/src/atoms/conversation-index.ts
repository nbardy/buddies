import type { ConversationRow, RowKind } from '@unleashd/shared';
import {
  folderGroupKey,
  isWorktreeDirectory,
  normalizeFolderDirectory,
} from '../utils/directories';
import { sameItems, sameMap, sameSet } from './structural';

// Conversation list index (patterns.md#one-store-one-index): one entry per conversation, rebuilt
// only when a touched conversation's list fields change, so non-list events leave the list
// reference untouched. See docs/client-rationale.md#conversation-index.

/** Facts about a working directory that views filter or group on. Computed
 *  once per distinct directory string and cached (regexes are not free at
 *  1,200 rows), so a view pays one map lookup per row. */
export interface DirectoryFacts {
  readonly raw: string;
  /** `normalizeFolderDirectory` — "which directory did the user mean". */
  readonly folder: string;
  /** `folderGroupKey` — the project a conversation groups under. */
  readonly groupKey: string;
  readonly isWorktree: boolean;
  /** Worktrees, oompa iteration dirs and temp dirs: never a user chat. */
  readonly isScratch: boolean;
}

export interface ConversationListEntry {
  readonly id: string;
  readonly activityMs: number;
  readonly createdAtMs: number;
  /** Raw working directory; `directoryFacts(workingDirectory)` for derived facts. */
  readonly workingDirectory: string;
  readonly kind: RowKind['t'];
  readonly buddyId: string | null;
  readonly buddyWorkspaceId: string | null;
  /** A background Buddy run (automation, delegation): not an owner chat. */
  readonly background: boolean;
  readonly isRunning: boolean;
  readonly done: boolean;
  readonly isWorker: boolean;
  readonly parentConversationId: string | null;
}

export interface ConversationIndex {
  readonly byId: ReadonlyMap<string, ConversationListEntry>;
  /** Newest-first by `activityMs`. Ties keep arrival order. */
  readonly list: readonly ConversationListEntry[];
}

export const EMPTY_CONVERSATION_INDEX: ConversationIndex = { byId: new Map(), list: [] };

function isTemporaryDirectory(workingDirectory: string): boolean {
  const directory = workingDirectory.toLowerCase();
  return (
    directory === '/tmp' ||
    directory.startsWith('/tmp/') ||
    directory === '/private/tmp' ||
    directory.startsWith('/private/tmp/') ||
    directory === '/var/tmp' ||
    directory.startsWith('/var/tmp/') ||
    directory.includes('/private/var/folders/') ||
    directory.includes('/var/folders/') ||
    directory.includes('/temporaryitems/') ||
    directory.includes('/temp/')
  );
}

function isNestedWorktreeDirectory(workingDirectory: string): boolean {
  return (
    isWorktreeDirectory(workingDirectory) ||
    /\/\.w[^/]+-i\d+(?:\/|$)/.test(workingDirectory) ||
    /\/\.workers\/worker-\d+(?:\/|$)/.test(workingDirectory) ||
    workingDirectory.includes('/.claude/worktrees/')
  );
}

// Bounded by the number of distinct working directories, which is small
// compared with the conversation count (many chats per folder).
const directoryFactsCache = new Map<string, DirectoryFacts>();

export function directoryFacts(raw: string): DirectoryFacts {
  const cached = directoryFactsCache.get(raw);
  if (cached) return cached;
  const folder = normalizeFolderDirectory(raw);
  const facts: DirectoryFacts = {
    raw,
    folder,
    groupKey: folderGroupKey(raw),
    isWorktree: isWorktreeDirectory(folder),
    isScratch: isNestedWorktreeDirectory(raw) || isTemporaryDirectory(raw),
  };
  directoryFactsCache.set(raw, facts);
  return facts;
}

function buildEntry(row: ConversationRow): ConversationListEntry {
  const buddy = row.kind.t === 'buddy' ? row.kind : null;
  return {
    id: row.id,
    activityMs: row.activityAt,
    createdAtMs: row.createdAt,
    workingDirectory: row.cwd,
    kind: row.kind.t,
    buddyId: buddy?.buddyId ?? null,
    buddyWorkspaceId: buddy?.workspaceId ?? null,
    background: buddy?.visibility === 'background',
    isRunning: row.run === 'running' || row.run === 'streaming',
    done: row.done,
    isWorker: row.kind.t === 'worker',
    parentConversationId: row.parent,
  };
}

function sameEntry(a: ConversationListEntry, b: ConversationListEntry): boolean {
  return (
    a.activityMs === b.activityMs &&
    a.createdAtMs === b.createdAtMs &&
    a.workingDirectory === b.workingDirectory &&
    a.kind === b.kind &&
    a.buddyId === b.buddyId &&
    a.buddyWorkspaceId === b.buddyWorkspaceId &&
    a.background === b.background &&
    a.isRunning === b.isRunning &&
    a.done === b.done &&
    a.isWorker === b.isWorker &&
    a.parentConversationId === b.parentConversationId
  );
}

/** First index whose entry is strictly older than `activityMs`. */
function insertionIndex(list: readonly ConversationListEntry[], activityMs: number): number {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (list[mid].activityMs >= activityMs) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Position of `entry` (by identity) in the sorted list. */
function indexOfEntry(
  list: readonly ConversationListEntry[],
  entry: ConversationListEntry
): number {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (list[mid].activityMs > entry.activityMs) low = mid + 1;
    else high = mid;
  }
  for (let i = low; i < list.length && list[i].activityMs === entry.activityMs; i++) {
    if (list[i] === entry) return i;
  }
  throw new Error(`conversation index out of sync for ${entry.id}`);
}

// Past this many replaced entries, one sort beats that many splices (init,
// reconnect and load-complete replace everything at once).
const REBUILD_THRESHOLD = 64;

function sortedList(byId: ReadonlyMap<string, ConversationListEntry>): ConversationListEntry[] {
  return Array.from(byId.values()).sort((a, b) => b.activityMs - a.activityMs);
}

/**
 * Apply the conversations a write touched. `changed` lists every id whose
 * record in `conversations` may differ from the one the index last saw
 * (including removed ids). Untouched ids are never visited.
 */
export function updateConversationIndex(
  index: ConversationIndex,
  conversations: ReadonlyMap<string, ConversationRow>,
  changed: Iterable<string>
): ConversationIndex {
  const replaced: Array<{
    previous: ConversationListEntry | undefined;
    next: ConversationListEntry | undefined;
  }> = [];
  for (const id of new Set(changed)) {
    const previous = index.byId.get(id);
    const conversation = conversations.get(id);
    const built = conversation ? buildEntry(conversation) : undefined;
    const next = previous && built && sameEntry(previous, built) ? previous : built;
    if (next !== previous) replaced.push({ previous, next });
  }
  if (replaced.length === 0) return index;

  const byId = new Map(index.byId);
  for (const { previous, next } of replaced) {
    if (next) byId.set(next.id, next);
    else if (previous) byId.delete(previous.id);
  }
  if (replaced.length > REBUILD_THRESHOLD) return { byId, list: sortedList(byId) };

  const list = index.list.slice();
  for (const { previous, next } of replaced) {
    if (previous) list.splice(indexOfEntry(list, previous), 1);
    if (next) list.splice(insertionIndex(list, next.activityMs), 0, next);
  }
  return { byId, list };
}

// Every collection view, built in ONE pass when the list moves; unchanged fields keep identity
// (guard: conversation-event-isolation.test.tsx). See docs/client-rationale.md#list-index.

export interface SidebarFolderGroup {
  /** `folderGroupKey` of the group's conversations. */
  directory: string;
  /** Not-done conversation ids, newest-first. A group whose conversations are
   *  all done stays (empty) so its position does not jump when one is marked. */
  activeIds: readonly string[];
}

export interface SidebarFolderView {
  /** Folders active in the last week, newest-first. */
  recent: readonly SidebarFolderGroup[];
  /** Not-done conversations older than a week, newest-first. */
  olderIds: readonly string[];
}

export interface ChatConversationInbox {
  /** Recent conversation ids, newest-first and capped for rendering. */
  ids: readonly string[];
  /** All user chat conversations before the render cap is applied. */
  total: number;
}

export interface BuddyThreads {
  /** Foreground top-level chats, running first, then newest. */
  foreground: readonly string[];
  /** Background runs (automations, delegations), running first, then newest. */
  background: readonly string[];
}

export interface ListIndex {
  /** Every conversation id, newest activity first. */
  readonly order: readonly string[];
  /** "Does the client still hold this conversation?" (AGENTS.md Link rule). */
  readonly idSet: ReadonlySet<string>;
  /** Distinct real project folders (worktrees excluded), newest-first. */
  readonly recentDirs: readonly string[];
  readonly latestCwd: string | null;
  /** Mobile chat inbox: no background runs, workers, children or scratch dirs. */
  readonly inbox: ChatConversationInbox;
  /** Desktop gallery: top-level conversations, newest-CREATED first. */
  readonly gallery: readonly ConversationListEntry[];
  /** Parent id → child ids, oldest first. */
  readonly childrenOf: ReadonlyMap<string, readonly string[]>;
  /** Desktop sidebar folder rows. */
  readonly folders: SidebarFolderView;
  /** Running folder rows per `folderGroupKey`. */
  readonly runningByFolder: ReadonlyMap<string, number>;
  /** Buddy-kind entries, newest-first (the Buddy sidebar joins these with the roster). */
  readonly buddyEntries: readonly ConversationListEntry[];
  /** Builder threads (not hidden workers, not listed children), newest-first. */
  readonly builders: readonly ConversationListEntry[];
  /** Per Buddy: its foreground chats and background runs. */
  readonly buddyThreads: ReadonlyMap<string, BuddyThreads>;
  /** Latest Buddy activity per workspace. */
  readonly workspaceActivity: ReadonlyMap<string, number>;
}

const CHAT_INBOX_LIMIT = 50;
const RECENT_CUTOFF_MS = 7 * 24 * 60 * 60 * 1000;

function runningFirst(a: ConversationListEntry, b: ConversationListEntry): number {
  return Number(b.isRunning) - Number(a.isRunning) || b.activityMs - a.activityMs;
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key);
  if (values) values.push(value);
  else map.set(key, [value]);
}

/**
 * One pass over the newest-first list. `now` dates the sidebar's "recent" cutoff.
 */
export function buildListIndex(list: readonly ConversationListEntry[], now: number): ListIndex {
  const order: string[] = [];
  const idSet = new Set<string>();
  for (const entry of list) {
    order.push(entry.id);
    idSet.add(entry.id);
  }
  const listedChild = (entry: ConversationListEntry) =>
    entry.parentConversationId !== null && idSet.has(entry.parentConversationId);

  const dirs = new Set<string>();
  const inboxIds: string[] = [];
  let inboxTotal = 0;
  const gallery: ConversationListEntry[] = [];
  const children = new Map<string, ConversationListEntry[]>();
  const recent = new Map<string, string[]>();
  const olderIds: string[] = [];
  const runningByFolder = new Map<string, number>();
  const buddyEntries: ConversationListEntry[] = [];
  const builders: ConversationListEntry[] = [];
  const foreground = new Map<string, ConversationListEntry[]>();
  const background = new Map<string, ConversationListEntry[]>();
  const workspaceActivity = new Map<string, number>();
  const cutoff = now - RECENT_CUTOFF_MS;

  for (const entry of list) {
    const directory = directoryFacts(entry.workingDirectory);
    const child = listedChild(entry);
    if (!directory.isWorktree) dirs.add(directory.folder);
    if (!child) gallery.push(entry);
    if (entry.parentConversationId !== null) pushTo(children, entry.parentConversationId, entry);
    if (
      !entry.background &&
      !entry.isWorker &&
      !entry.parentConversationId &&
      !directory.isScratch
    ) {
      inboxTotal += 1;
      if (inboxIds.length < CHAT_INBOX_LIMIT) inboxIds.push(entry.id);
    }
    if (entry.buddyWorkspaceId !== null && !workspaceActivity.has(entry.buddyWorkspaceId)) {
      workspaceActivity.set(entry.buddyWorkspaceId, entry.activityMs);
    }
    if (entry.kind === 'buddy' && entry.buddyId !== null) {
      buddyEntries.push(entry);
      if (entry.background) pushTo(background, entry.buddyId, entry);
      else if (!entry.isWorker && entry.parentConversationId === null)
        pushTo(foreground, entry.buddyId, entry);
    }
    if (entry.isWorker || child) continue;
    if (entry.kind === 'builder') builders.push(entry);
    // Folder rows: not Buddy threads (own section), not Builder (own folder).
    if (entry.kind === 'buddy' || entry.kind === 'builder') continue;
    if (entry.isRunning) {
      runningByFolder.set(directory.groupKey, (runningByFolder.get(directory.groupKey) ?? 0) + 1);
    }
    if (entry.activityMs <= cutoff) {
      if (!entry.done) olderIds.push(entry.id);
      continue;
    }
    let group = recent.get(directory.groupKey);
    if (!group) {
      group = [];
      recent.set(directory.groupKey, group);
    }
    if (!entry.done) group.push(entry.id);
  }

  const childrenOf = new Map<string, readonly string[]>();
  for (const [parentId, siblings] of children) {
    childrenOf.set(
      parentId,
      siblings.sort((a, b) => a.createdAtMs - b.createdAtMs).map((entry) => entry.id)
    );
  }
  const buddyThreads = new Map<string, BuddyThreads>();
  const ids = (entries: ConversationListEntry[] | undefined) =>
    (entries ?? []).sort(runningFirst).map((entry) => entry.id);
  for (const buddyId of new Set([...foreground.keys(), ...background.keys()])) {
    buddyThreads.set(buddyId, {
      foreground: ids(foreground.get(buddyId)),
      background: ids(background.get(buddyId)),
    });
  }
  return {
    order,
    idSet,
    recentDirs: Array.from(dirs),
    latestCwd: list[0]?.workingDirectory ?? null,
    inbox: { ids: inboxIds, total: inboxTotal },
    gallery: gallery.sort((a, b) => b.createdAtMs - a.createdAtMs),
    childrenOf,
    folders: {
      recent: Array.from(recent, ([directory, activeIds]) => ({ directory, activeIds })),
      olderIds,
    },
    runningByFolder,
    buddyEntries,
    builders,
    buddyThreads,
    workspaceActivity,
  };
}

function sameFolders(a: SidebarFolderView, b: SidebarFolderView): boolean {
  return (
    sameItems(a.olderIds, b.olderIds) &&
    a.recent.length === b.recent.length &&
    a.recent.every(
      (group, i) =>
        group.directory === b.recent[i].directory &&
        sameItems(group.activeIds, b.recent[i].activeIds)
    )
  );
}

function sameThreads(a: BuddyThreads, b: BuddyThreads): boolean {
  return sameItems(a.foreground, b.foreground) && sameItems(a.background, b.background);
}

const FIELD_EQUALS: { [K in keyof ListIndex]: (a: ListIndex[K], b: ListIndex[K]) => boolean } = {
  order: sameItems,
  idSet: sameSet,
  recentDirs: sameItems,
  latestCwd: Object.is,
  inbox: (a, b) => a.total === b.total && sameItems(a.ids, b.ids),
  gallery: sameItems,
  childrenOf: (a, b) => sameMap(a, b, sameItems),
  folders: sameFolders,
  runningByFolder: (a, b) => sameMap(a, b),
  buddyEntries: sameItems,
  builders: sameItems,
  buddyThreads: (a, b) => sameMap(a, b, sameThreads),
  workspaceActivity: (a, b) => sameMap(a, b),
};

/** Keep each field of `previous` whose content `next` did not change. */
export function reuseUnchangedFields(previous: ListIndex, next: ListIndex): ListIndex {
  let same = true;
  const merged = { ...next } as Record<keyof ListIndex, unknown>;
  for (const key of Object.keys(FIELD_EQUALS) as Array<keyof ListIndex>) {
    const equals = FIELD_EQUALS[key] as (a: unknown, b: unknown) => boolean;
    if (equals(previous[key], next[key])) merged[key] = previous[key];
    else same = false;
  }
  return same ? previous : (merged as unknown as ListIndex);
}
