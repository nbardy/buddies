import type { ExpeditionRetiredView, ExpeditionView } from '@unleashd/shared';
import { useAtomValue } from 'jotai';
import { type Location, useLocation, useNavigate } from 'react-router-dom';
import { useBuddyOverview } from '../../hooks/useBuddyData';
import { type PolledState, usePolledFetch } from '../../hooks/usePolledFetch';
import { channelsHref } from './channels-view';
import { expeditionHref, expeditionRead, expeditionUrl, summaryOf } from './expedition-view';
import { buddyWorkspaceActivityAtom, overviewWorkspaces } from './workspace-order';

// /expeditions/:id opens OVER its opener (`state.background`; App.tsx renders routes there). A
// direct load has none: it opens over its workspace's channels-view expedition index (owner, 2026-11-01).

const EXPEDITION_PATH = /^\/expeditions\/([^/]+)\/?$/;

export type ExpeditionOverlay =
  | { t: 'none' }
  | { t: 'over'; id: string; background: Location }
  | { t: 'direct'; id: string };

/** κ: router state is untyped history data; only a location-shaped `background` counts. */
function backgroundIn(state: unknown): Location | null {
  if (typeof state !== 'object' || state === null || !('background' in state)) return null;
  const background = (state as { background: unknown }).background;
  return typeof background === 'object' && background !== null && 'pathname' in background
    ? (background as Location)
    : null;
}

export function expeditionOverlay(location: Location): ExpeditionOverlay {
  const match = EXPEDITION_PATH.exec(location.pathname);
  if (!match) return { t: 'none' };
  const id = decodeURIComponent(match[1]);
  const background = backgroundIn(location.state);
  return background ? { t: 'over', id, background } : { t: 'direct', id };
}

/** A modal opened from inside another keeps the original view underneath, never the first modal. */
export function backgroundOf(location: Location): Location {
  return backgroundIn(location.state) ?? location;
}

export function useOpenExpedition(): (id: string) => void {
  const navigate = useNavigate();
  const location = useLocation();
  return (id) => navigate(expeditionHref(id), { state: { background: backgroundOf(location) } });
}

export type OverlayBase = { t: 'page'; routes: Location } | ModalBase;

/** `unresolved` lands on a workspace index, never /expeditions while one exists: its redirect
 * REPLACES the URL and dropped the modal (2026-11-02, /expeditions/nope). */
export type ModalBase =
  | { t: 'over'; id: string; routes: Location }
  | { t: 'landed'; id: string; routes: string }
  | { t: 'pending'; id: string; routes: Location }
  | { t: 'unresolved'; id: string; routes: string };

/** Where an unreadable expedition lands: unknown until the overview loads. */
type Landing = { t: 'loading' } | { t: 'known'; routes: string };

export const EXPEDITIONS_INDEX_PATH = '/expeditions';
const indexOf = (workspaceId: string) => channelsHref(workspaceId, { kind: 'expeditions' });

export function useOverlayBase(location: Location, overlay: ExpeditionOverlay): OverlayBase {
  // Same key as the modal (one fetch). Typed as the union: as the live view alone, a retired deep
  // link read `workspaceId` off the wrong shape and landed on an empty rail (2026-11-03 e2e).
  const direct = usePolledFetch<ExpeditionView | ExpeditionRetiredView>(
    overlay.t === 'direct' ? expeditionUrl(overlay.id) : null,
    0
  );
  const overview = useBuddyOverview(0, overlay.t === 'direct');
  const [first] = overviewWorkspaces(overview.data, useAtomValue(buddyWorkspaceActivityAtom));
  const landing: Landing =
    overview.data === null
      ? { t: 'loading' }
      : { t: 'known', routes: first ? indexOf(first.id) : EXPEDITIONS_INDEX_PATH };
  switch (overlay.t) {
    case 'none':
      return { t: 'page', routes: location };
    case 'over':
      return { t: 'over', id: overlay.id, routes: overlay.background };
    case 'direct':
      return directBase(overlay.id, direct, landing, location);
  }
}

function directBase(
  id: string,
  direct: PolledState<ExpeditionView | ExpeditionRetiredView>,
  landing: Landing,
  location: Location
): ModalBase {
  switch (direct.kind) {
    case 'idle':
    case 'loading':
      return { t: 'pending', id, routes: location };
    case 'ready':
    case 'stale':
      return {
        t: 'landed',
        id,
        routes: indexOf(summaryOf(expeditionRead(direct.data)).workspaceId),
      };
    case 'failed':
      return landing.t === 'known'
        ? { t: 'unresolved', id, routes: landing.routes }
        : { t: 'pending', id, routes: location };
  }
}
