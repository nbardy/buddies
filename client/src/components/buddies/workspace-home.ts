import type { OwnerUnreadTotal } from './channel-data';
import type { BuddyOverview } from './types';

// The workspace home at `/` (port of 6d04860 onto the T19 list index). Pure,
// so mobile may import it (G3) and the sectioning is testable without a DOM.

/** One Buddy conversation's activity: the list index's `buddyEntries`. */
export type BuddyActivity = {
  readonly buddyId: string | null;
  readonly buddyWorkspaceId: string | null;
  readonly activityMs: number;
};

export type RecentBuddy = { id: string; name: string };

/** A workspace whose Buddies have a conversation, and one without. */
export type WorkspaceActivity =
  | { kind: 'active'; lastActiveMs: number; buddies: RecentBuddy[] }
  | { kind: 'quiet' };

export type WorkspaceHomeRow = {
  id: string;
  name: string;
  rootPath: string;
  total: OwnerUnreadTotal;
  activity: WorkspaceActivity;
};

export type WorkspaceHomeSections = { recent: WorkspaceHomeRow[]; rest: WorkspaceHomeRow[] };

/** How many workspaces get an icon tile on the home screen. */
export const RECENT_TILES = 4;
/** Buddy faces shown per workspace, most recently active first. */
export const RECENT_FACES = 3;

const NO_UNREAD: OwnerUnreadTotal = { requests: 0, unreadChannels: 0, unreadThreads: 0 };

/**
 * Most recently active workspace first, then name. The first RECENT_TILES
 * active workspaces are `recent`; everything else, quiet ones included, is
 * `rest`, so every workspace appears exactly once.
 */
export function workspaceHomeSections(
  overview: BuddyOverview,
  totals: ReadonlyMap<string, OwnerUnreadTotal>,
  entries: readonly BuddyActivity[]
): WorkspaceHomeSections {
  const rows = overview
    .map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      rootPath: workspace.rootPath,
      total: totals.get(workspace.id) ?? NO_UNREAD,
      activity: workspaceActivity(
        new Map(workspace.buddies.map((buddy) => [buddy.id, buddy.name])),
        entries.filter((entry) => entry.buddyWorkspaceId === workspace.id)
      ),
    }))
    .sort(
      (a, b) =>
        lastActive(b) - lastActive(a) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
    );
  const recent = rows.filter((row) => row.activity.kind === 'active').slice(0, RECENT_TILES);
  const tiled = new Set(recent.map((row) => row.id));
  return { recent, rest: rows.filter((row) => !tiled.has(row.id)) };
}

function workspaceActivity(
  names: ReadonlyMap<string, string>,
  entries: readonly BuddyActivity[]
): WorkspaceActivity {
  if (entries.length === 0) return { kind: 'quiet' };
  const latest = [...entries].sort((a, b) => b.activityMs - a.activityMs);
  const buddies = new Map<string, RecentBuddy>();
  for (const { buddyId } of latest) {
    const name = buddyId === null ? undefined : names.get(buddyId);
    if (buddies.size === RECENT_FACES) break;
    if (buddyId !== null && name !== undefined && !buddies.has(buddyId))
      buddies.set(buddyId, { id: buddyId, name });
  }
  return { kind: 'active', lastActiveMs: latest[0].activityMs, buddies: [...buddies.values()] };
}

function lastActive(row: WorkspaceHomeRow): number {
  return row.activity.kind === 'active' ? row.activity.lastActiveMs : 0;
}

/**
 * Whether "Create workspace" may submit. PathAutocomplete reports an EMPTY
 * input as valid, so validity alone let an empty folder through (89b27ad);
 * a folder is required on top.
 */
export function createReady(folder: string, pathValid: boolean): boolean {
  return pathValid && folder.trim().length > 0;
}

/** `/?new=1` opens the create form: the channel rail's "New workspace" and onboarding land here. */
export const NEW_WORKSPACE_PATH = '/?new=1';
