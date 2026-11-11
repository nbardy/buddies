import { useAtomValue } from 'jotai';
import { useCallback, useRef } from 'react';
import {
  buddyBackgroundWorkersAtomFamily,
  buddyWorkerReadRowsFamily,
  workerDetailsResource,
} from '../atoms/buddy-background';
import { createConversation } from '../atoms/commands';
import { findWorkspace } from '../components/buddies/roster';
import type { BuddyDetail, BuddyOverview } from '../components/buddies/types';
import { isRowRunning } from '../utils/conversation-row';
import { type UsePolledFetchResult, usePolledFetch } from './usePolledFetch';

// =============================================================================
// Buddy read models — the ONE place each Buddy page request is described.
//
// Desktop (BuddiesDashboard, Sidebar, SearchPalette) and mobile (BuddiesMobile,
// BuddyDetailMobile) all read through these hooks, so they share cache keys:
// the overview the Sidebar polls is the overview the mobile list renders, and
// opening a Buddy on either shell hits the same `/api/buddies/:id` entry.
// =============================================================================

export const BUDDY_OVERVIEW_URL = '/api/buddies/overview';

export function useBuddyOverview(
  intervalMs = 0,
  enabled = true
): UsePolledFetchResult<BuddyOverview> {
  return usePolledFetch<BuddyOverview>(BUDDY_OVERVIEW_URL, intervalMs, enabled);
}

export const buddyDetailUrl = (buddyId: string): string =>
  `/api/buddies/${encodeURIComponent(buddyId)}`;

/** One Buddy with its tasks, schedules and recent runs; the URL is the cache key. */
export function useBuddyDetail(buddyId: string | undefined): UsePolledFetchResult<BuddyDetail> {
  return usePolledFetch<BuddyDetail>(buddyId ? buddyDetailUrl(buddyId) : null, 0);
}

/**
 * What both Buddy pages read: the detail, the Buddy's home workspace (from the
 * overview; a Buddy belongs to exactly one) and `talk`, which starts a new
 * foreground chat with the Buddy there. `openConversation` is the shell's own
 * navigation; it is read through a ref so an inline arrow cannot churn `talk`.
 */
export function useBuddyPage(
  buddyId: string | undefined,
  openConversation: (conversationId: string) => void
) {
  const detail = useBuddyDetail(buddyId);
  const overview = useBuddyOverview();
  const buddy = detail.data?.buddy ?? null;
  const workspace =
    buddy && overview.data ? (findWorkspace(overview.data, buddy.workspaceId) ?? null) : null;
  const openRef = useRef(openConversation);
  openRef.current = openConversation;

  const talk = useCallback(() => {
    if (!buddy || !workspace) return;
    const id = createConversation({
      workingDirectory: workspace.rootPath,
      config: {
        provider: (buddy.provider ?? 'codex') as 'codex',
        model: buddy.model ? { mode: 'explicit', modelId: buddy.model } : { mode: 'default' },
        reasoning: buddy.reasoningEffort
          ? { mode: 'explicit', effort: buddy.reasoningEffort }
          : { mode: 'default' },
      },
      kind: {
        t: 'buddy',
        context: { buddyId: buddy.id, workspaceId: workspace.id, buddyProjectId: null },
      },
    });
    openRef.current(id);
  }, [buddy, workspace]);

  return { detail, overview, buddy, workspace, talk };
}

/** Badges load live parents only; the workers screen explicitly opts into historical details. */
export function useBuddyWorkerRead(
  buddyId: string,
  workspaceId: string | null = null,
  includeHistory = false
) {
  const scope = { buddyId, workspaceId, includeHistory };
  const rows = useAtomValue(buddyWorkerReadRowsFamily(scope));
  return usePolledFetch(
    workerDetailsResource(scope),
    rows.some(isRowRunning) ? 5_000 : 30_000,
    rows.length > 0
  );
}

export function useBuddyWorkers(buddyId: string, workspaceId: string | null = null) {
  const read = useBuddyWorkerRead(buddyId, workspaceId, true);
  const workers = useAtomValue(buddyBackgroundWorkersAtomFamily({ buddyId, workspaceId }));
  return { workers, read };
}
