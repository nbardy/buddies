import type { ExpeditionView } from '@unleashd/shared';
import { type Location, useLocation, useNavigate } from 'react-router-dom';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { channelsHref } from './channels-view';
import { expeditionHref, expeditionUrl } from './expedition-view';

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
export type OverlayBase =
  | { t: 'page'; routes: Location }
  | { t: 'over'; routes: Location }
  /** A direct load whose workspace is known: the channels view's expedition index. */
  | { t: 'landed'; routes: string }
  /** A direct load still reading its expedition: nothing under the modal yet (App.tsx renders an
   * empty route at this path), so the old shell never flashes behind it. */
  | { t: 'pending'; routes: Location };

export function useOverlayBase(location: Location, overlay: ExpeditionOverlay): OverlayBase {
  // The modal reads the same key, so a direct load fetches the expedition once.
  const direct = usePolledFetch<ExpeditionView>(
    overlay.t === 'direct' ? expeditionUrl(overlay.id) : null,
    0
  );
  switch (overlay.t) {
    case 'none':
      return { t: 'page', routes: location };
    case 'over':
      return { t: 'over', routes: overlay.background };
    case 'direct':
      return direct.data
        ? {
            t: 'landed',
            routes: channelsHref(direct.data.workspaceId, { kind: 'expeditions' }),
          }
        : { t: 'pending', routes: location };
  }
}
