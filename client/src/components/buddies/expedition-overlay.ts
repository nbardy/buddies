import type { ExpeditionRetiredView, ExpeditionView } from '@unleashd/shared';
import { useAtomValue } from 'jotai';
import { type Location, useLocation, useNavigate } from 'react-router-dom';
import { useBuddyOverview } from '../../hooks/useBuddyData';
import { type PolledState, usePolledFetch } from '../../hooks/usePolledFetch';
import { channelsHref } from './channels-view';
import { expeditionHref, expeditionRead, expeditionUrl, summaryOf } from './expedition-view';
import { buddyWorkspaceActivityAtom, overviewWorkspaces } from './workspace-order';

// The expedition modal is route-addressable (/expeditions/:id) and opens OVER the view it was
// opened from: the opener pushes the URL with `state.background`, and App.tsx renders its routes
// at that background location with the modal on top. A direct load or reload has no background,
// so the modal opens over its workspace's expedition index in the channels view (owner,
// 2026-11-01: expeditions belong to the channels view, never the old conversations shell).

const EXPEDITION_PATH = /^\/expeditions\/([^/]+)\/?$/;

/** What the router shows for a location: no modal, the modal over its opener, or over home. */
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

/** The background to keep when opening a modal: a modal opened from inside another keeps the
 * original view underneath, never the first modal's URL. */
export function backgroundOf(location: Location): Location {
  return backgroundIn(location.state) ?? location;
}

/** Opens the live expedition modal over the current view. */
export function useOpenExpedition(): (id: string) => void {
  const navigate = useNavigate();
  const location = useLocation();
  return (id) => navigate(expeditionHref(id), { state: { background: backgroundOf(location) } });
}

/** Where the routes render under the modal, and where closing it goes. */
export type OverlayBase = { t: 'page'; routes: Location } | ModalBase;

/** The bases that carry a modal (every overlay but 'none'), with the expedition it shows. */
export type ModalBase =
  | { t: 'over'; id: string; routes: Location }
  /** A direct load whose workspace is known: the channels view's expedition index. */
  | { t: 'landed'; id: string; routes: string }
  /** A direct load still reading its expedition: nothing under the modal yet (App.tsx renders an
   * empty route at this path), so the old shell never flashes behind it. */
  | { t: 'pending'; id: string; routes: Location }
  /** A direct load whose expedition could not be read (unknown/deleted id, HTTP error): the
   * modal shows the error over the channels expedition index of the workspace /expeditions would
   * pick (or /expeditions itself when there is none), and closing lands there instead of on an
   * empty page. Never /expeditions while a workspace exists: its redirect REPLACES the URL, which
   * dropped the modal and its not-found message (2026-11-02 visual pass: /expeditions/nope
   * showed the bare index). */
  | { t: 'unresolved'; id: string; routes: string };

/** The workspace an unreadable expedition lands in: still loading, the one /expeditions picks,
 * or none at all. */
type Landing = { t: 'loading' } | { t: 'workspace'; id: string } | { t: 'none' };

/** The channels-view expedition index for an unknown workspace (App.tsx routes it). */
export const EXPEDITIONS_INDEX_PATH = '/expeditions';

export function useOverlayBase(location: Location, overlay: ExpeditionOverlay): OverlayBase {
  // The modal reads the same key, so a direct load fetches the expedition once.
  // The answer is either view (a retired expedition is its frozen summary): typed as the union,
  // as ExpeditionLive reads it. Typed as the live view alone, a retired deep link read
  // `workspaceId` off the wrong shape and landed on an empty rail (2026-11-03 e2e).
  const direct = usePolledFetch<ExpeditionView | ExpeditionRetiredView>(
    overlay.t === 'direct' ? expeditionUrl(overlay.id) : null,
    0
  );
  const overview = useBuddyOverview(0, overlay.t === 'direct');
  const [first] = overviewWorkspaces(overview.data, useAtomValue(buddyWorkspaceActivityAtom));
  const landing: Landing =
    overview.data === null
      ? { t: 'loading' }
      : first
        ? { t: 'workspace', id: first.id }
        : { t: 'none' };
  switch (overlay.t) {
    case 'none':
      return { t: 'page', routes: location };
    case 'over':
      return { t: 'over', id: overlay.id, routes: overlay.background };
    case 'direct':
      return directBase(overlay.id, direct, landing, location);
  }
}

/** δ over the direct load's fetch state: one base per cache variant. */
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
        routes: channelsHref(summaryOf(expeditionRead(direct.data)).workspaceId, {
          kind: 'expeditions',
        }),
      };
    case 'failed':
      return unresolvedBase(id, landing, location);
  }
}

/** δ over where an unreadable expedition lands: nothing under it until the workspace is known. */
function unresolvedBase(id: string, landing: Landing, location: Location): ModalBase {
  switch (landing.t) {
    case 'loading':
      return { t: 'pending', id, routes: location };
    case 'workspace':
      return { t: 'unresolved', id, routes: channelsHref(landing.id, { kind: 'expeditions' }) };
    case 'none':
      return { t: 'unresolved', id, routes: EXPEDITIONS_INDEX_PATH };
  }
}
