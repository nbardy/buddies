import { atom } from 'jotai';
import type { Buddy, WorkspaceRoster } from '../components/buddies/types';
import { archivedBuddyIdsAtom } from './buddy-visibility';
import {
  type ConversationListEntry,
  type CreateCommand,
  commandsAtom,
  listField,
  pendingCreatesOf,
} from './conversations';
import { atomWithPrevious, sameItems } from './structural';

/**
 * The slice of `BuddyOverview` the sidebar reads, declared as Picks over the
 * canonical types so an upstream rename fails here at compile time — and kept
 * minimal so tests can seed rows without fabricating whole Buddy records.
 * `useBuddyOverview()`'s full `BuddyOverview` is assignable to it.
 */
type SidebarBuddy = Pick<Buddy, 'id' | 'name' | 'status'>;
type SidebarWorkspace = Pick<WorkspaceRoster, 'id' | 'name' | 'rootPath'> & {
  buddies: SidebarBuddy[];
};
export type BuddySidebarOverview = readonly SidebarWorkspace[];

// Conversations appear here as list entries (atoms/conversation-index.ts):
// the sidebar needs their ids, order and flags, and each row subscribes to its
// own conversation for everything else.
export interface BuddySidebarItemData {
  buddyId: string;
  buddyName: string;
  conversations: ConversationListEntry[];
  foregroundRunningCount: number;
  backgroundRunningCount: number;
  backgroundConversationCount: number;
  latestConversation: ConversationListEntry | null;
  pendingCreation: CreateCommand | null;
  workspaceId: string;
  workingDirectory: string;
  workspaceName: string;
  lastActiveAt: Date | null;
}

export const buddySidebarOverviewAtom = atom<BuddySidebarOverview | null>(null);

export interface BuddySidebarProject {
  workspaceId: string;
  name: string;
  lastActiveMs: number;
  runningCount: number;
  items: BuddySidebarItemData[];
}

function sameBuddyItem(a: BuddySidebarItemData, b: BuddySidebarItemData): boolean {
  return (
    a.buddyId === b.buddyId &&
    a.buddyName === b.buddyName &&
    a.workspaceId === b.workspaceId &&
    a.workspaceName === b.workspaceName &&
    a.workingDirectory === b.workingDirectory &&
    a.foregroundRunningCount === b.foregroundRunningCount &&
    a.backgroundRunningCount === b.backgroundRunningCount &&
    a.backgroundConversationCount === b.backgroundConversationCount &&
    a.latestConversation === b.latestConversation &&
    a.pendingCreation === b.pendingCreation &&
    a.lastActiveAt?.getTime() === b.lastActiveAt?.getTime() &&
    sameItems(a.conversations, b.conversations)
  );
}

// The projects are rebuilt whenever the list moves (any conversation's
// activity or status); handing back the previous array when nothing a Buddy
// row shows changed keeps the Sidebar from re-rendering on unrelated events.
function sameBuddyProjects(a: BuddySidebarProject[], b: BuddySidebarProject[]): boolean {
  return (
    a.length === b.length &&
    a.every((project, i) => {
      const other = b[i];
      return (
        project.workspaceId === other.workspaceId &&
        project.name === other.name &&
        project.lastActiveMs === other.lastActiveMs &&
        project.runningCount === other.runningCount &&
        project.items.length === other.items.length &&
        project.items.every((item, j) => sameBuddyItem(item, other.items[j]))
      );
    })
  );
}

function buildProjects(
  overview: BuddySidebarOverview | null,
  /** Not on the roster: archived Buddies and expedition crews. */
  hidden: ReadonlySet<string>,
  all: readonly ConversationListEntry[],
  ids: ReadonlySet<string>,
  pendingCreates: readonly CreateCommand[]
): BuddySidebarProject[] {
  const projects = new Map<string, BuddySidebarProject>();
  const entries = new Map<string, BuddySidebarItemData>();
  const entryKey = (buddyId: string, workspaceId: string) => JSON.stringify([workspaceId, buddyId]);
  const ensure = (buddy: SidebarBuddy, workspace: SidebarWorkspace) => {
    let project = projects.get(workspace.id);
    if (!project) {
      project = {
        workspaceId: workspace.id,
        name: workspace.name,
        lastActiveMs: 0,
        runningCount: 0,
        items: [],
      };
      projects.set(workspace.id, project);
    }
    const item: BuddySidebarItemData = {
      buddyId: buddy.id,
      buddyName: buddy.name,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workingDirectory: workspace.rootPath,
      conversations: [],
      foregroundRunningCount: 0,
      backgroundRunningCount: 0,
      backgroundConversationCount: 0,
      latestConversation: null,
      pendingCreation: null,
      lastActiveAt: null,
    };
    entries.set(entryKey(buddy.id, workspace.id), item);
    project.items.push(item);
  };
  const touch = (item: BuddySidebarItemData, ms: number) => {
    if (!Number.isFinite(ms)) return;
    if (ms > (item.lastActiveAt?.getTime() ?? 0)) item.lastActiveAt = new Date(ms);
    const project = projects.get(item.workspaceId)!;
    project.lastActiveMs = Math.max(project.lastActiveMs, ms);
  };
  // Only the roster creates navigable workspace/member rows. Imported transcripts
  // (including live-test sessions) can outlive their Buddy store; keep their
  // history in the conversation store without inventing UUID folders, unnamed
  // Buddies, or creation targets from those IDs.
  for (const workspace of overview ?? []) {
    for (const buddy of workspace.buddies) {
      if (buddy.status === 'active' && !hidden.has(buddy.id)) ensure(buddy, workspace);
    }
  }
  // `all` is newest-first, so the first foreground entry per item is its latest
  // and pushing in order keeps each item's list sorted.
  for (const conversation of all) {
    if (conversation.kind !== 'buddy' || conversation.buddyId === null) continue;
    const workspaceId = conversation.buddyWorkspaceId ?? '';
    const item = entries.get(entryKey(conversation.buddyId, workspaceId));
    if (!item) continue;
    touch(item, conversation.activityMs);
    // Background conversations have their own destination, including tasks
    // linked to a foreground parent. Count them before hiding nested chat rows.
    if (conversation.background) {
      item.backgroundConversationCount += 1;
      if (conversation.isRunning) {
        item.backgroundRunningCount += 1;
        projects.get(workspaceId)!.runningCount += 1;
      }
      continue;
    }
    if (conversation.parentConversationId && ids.has(conversation.parentConversationId)) continue;
    if (conversation.isRunning) {
      item.foregroundRunningCount += 1;
      projects.get(workspaceId)!.runningCount += 1;
    }
    item.latestConversation ??= conversation;
    if (!conversation.done) item.conversations.push(conversation);
  }
  for (const pending of pendingCreates) {
    if (pending.args.kind.t !== 'buddy') continue;
    const context = pending.args.kind.context;
    const item = entries.get(entryKey(context.buddyId, context.workspaceId));
    if (!item) continue;
    item.pendingCreation ??= pending;
    touch(item, pending.createdAt);
  }
  for (const project of projects.values()) {
    project.items.sort(
      (a, b) =>
        (b.lastActiveAt?.getTime() ?? 0) - (a.lastActiveAt?.getTime() ?? 0) ||
        a.buddyName.localeCompare(b.buddyName)
    );
  }
  return [...projects.values()].sort(
    (a, b) =>
      b.lastActiveMs - a.lastActiveMs ||
      a.name.localeCompare(b.name) ||
      a.workspaceId.localeCompare(b.workspaceId)
  );
}

export type BuddySidebarGroup =
  | { kind: 'project'; key: string; lastActiveMs: number; project: BuddySidebarProject }
  | { kind: 'builder'; key: string; lastActiveMs: number };

function sameBuddyGroups(a: BuddySidebarGroup[], b: BuddySidebarGroup[]): boolean {
  return (
    a.length === b.length &&
    a.every((group, i) => {
      const other = b[i];
      if (group.key !== other.key || group.lastActiveMs !== other.lastActiveMs) return false;
      return (
        group.kind === 'builder' || (other.kind === 'project' && group.project === other.project)
      );
    })
  );
}

function buildGroups(
  projects: BuddySidebarProject[],
  builders: readonly ConversationListEntry[]
): BuddySidebarGroup[] {
  const groups: BuddySidebarGroup[] = projects.map((project) => ({
    kind: 'project',
    key: `buddy-project:${project.workspaceId}`,
    lastActiveMs: project.lastActiveMs,
    project,
  }));
  if (builders.length) {
    groups.push({ kind: 'builder', key: '__builder__', lastActiveMs: builders[0].activityMs });
  }
  return groups.sort((a, b) => b.lastActiveMs - a.lastActiveMs);
}

export interface BuddySidebar {
  projects: BuddySidebarProject[];
  /** Buddy projects and the Builder folder, by recency. */
  groups: BuddySidebarGroup[];
  /** Distinct Buddies listed. */
  buddyCount: number;
  /** Workspaces with a channel browser: one top-level Channels row each. */
  channels: ReadonlyArray<{ workspaceId: string; name: string }>;
}

/**
 * The Buddy sidebar: the roster (overview) joined with the list index's Buddy
 * entries and in-flight Buddy creates. One derived atom replaces the five it
 * had until T19 (projects, groups, count, channels, builders). It hands back
 * its previous value when nothing a Buddy row shows changed, so the Sidebar
 * does not re-render on unrelated list moves.
 */
export const buddySidebarAtom = atomWithPrevious((get, previous: BuddySidebar | undefined) => {
  const projects = buildProjects(
    get(buddySidebarOverviewAtom),
    get(archivedBuddyIdsAtom),
    get(listField('buddyEntries')),
    get(listField('idSet')),
    pendingCreatesOf(get(commandsAtom))
  );
  if (previous && sameBuddyProjects(previous.projects, projects)) {
    const groups = buildGroups(previous.projects, get(listField('builders')));
    return sameBuddyGroups(previous.groups, groups) ? previous : { ...previous, groups };
  }
  const channels = projects.map((project) => ({
    workspaceId: project.workspaceId,
    name: project.name,
  }));
  return {
    projects,
    groups: buildGroups(projects, get(listField('builders'))),
    buddyCount: new Set(projects.flatMap((p) => p.items.map((i) => i.buddyId))).size,
    channels:
      previous &&
      previous.channels.length === channels.length &&
      previous.channels.every(
        (row, i) => row.workspaceId === channels[i].workspaceId && row.name === channels[i].name
      )
        ? previous.channels
        : channels,
  };
});
