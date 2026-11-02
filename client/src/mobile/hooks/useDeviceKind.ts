/**
 * DeviceKind — the only sum type at the shell (§3).
 * Canonical type owns branching (T1): 'mobile'|'desktop' not boolean.
 * A boolean isMobile leaks `if(isMobile)` downstream and loses exhaustiveness.
 */

/** The one phone breakpoint: the shell's sticky choice and the expedition modal's live one. */
export const MOBILE_QUERY = '(max-width: 768px)';

/** Sum type for shell dispatch. No 'unknown' variant — every target browser has matchMedia (T4). */
export type DeviceKind = 'mobile' | 'desktop';

/**
 * κ: matchMedia('(max-width: 768px)') → DeviceKind
 *
 * Classifies the viewport once per page load (sticky, not resize-reactive).
 * A live resize swap would remount the whole tree mid-session and lose
 * component-local state (composer drafts). A desktop window resized to phone
 * width keeps the desktop tree until reload — acceptable (§3, §5 #3).
 *
 * matchMedia missing → typed Error (T4, never silent desktop default).
 */
function classifyDeviceKind(): DeviceKind {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    throw new Error(
      'useDeviceKind: window.matchMedia is unavailable — cannot classify DeviceKind. ' +
        'This environment does not support matchMedia; refusing silent fallback per T4.'
    );
  }
  return window.matchMedia(MOBILE_QUERY).matches ? 'mobile' : 'desktop';
}

// Evaluated ONCE per page load at module import — sticky for the session.
// Module-level evaluation is the simplest sticky guarantee; the hook below
// just returns the cached value without re-querying matchMedia.
let cachedDeviceKind: DeviceKind | null = null;

function getDeviceKind(): DeviceKind {
  if (cachedDeviceKind === null) {
    cachedDeviceKind = classifyDeviceKind();
  }
  return cachedDeviceKind;
}

/**
 * Returns the DeviceKind for this page load. Single call site is App.tsx:
 *   const device = useDeviceKind();
 * Mobile and desktop leaf handlers never re-ask isMobile — AppRoutes δ owns dispatch.
 */
export function useDeviceKind(): DeviceKind {
  return getDeviceKind();
}
