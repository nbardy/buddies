import {
  type DeviceUiPrefs,
  DeviceUiPrefsSchema,
  type RetiredHomePins,
  RetiredHomePinsSchema,
  SeenMessageIndexSchema,
} from '@unleashd/shared';
import { atomWithStorage } from 'jotai/utils';
import type { SyncStorage } from 'jotai/vanilla/utils/atomWithStorage';
import { jotaiStore } from './store';

// Device UI state in localStorage: prefs ('unleashd-ui-local') and seen ('unleashd-seen-message-
// index'). Done lives on the server record, not here. Mutate only via the exported actions (gate
// G1). See docs/client-rationale.md#device-ui-state.

export const LOCAL_STORAGE_KEY = 'unleashd-ui-local';
const SEEN_STORAGE_KEY = 'unleashd-seen-message-index';

const PREFS_DEFAULTS: DeviceUiPrefs = {
  galleryExpandedProjects: [],
  galleryCollapsedProjects: [],
  showTempSessions: false,
  showDoneConversations: false,
  showWorkerConversations: false,
  lastWorkingDirectory: null,
  promotedWorkers: [],
};

// ---------------------------------------------------------------------------
// External Keys (raw localStorage, outside any store — documented here)
//
// draft:{conversationId}   — Written from uncontrolled textarea via refs in
//                            Chat.tsx. Must bypass React render cycle.
// pendingFiles:{conversationId} — Serialized array of files awaiting send
//                            (images only, previewUrl omitted — object URL).
// restartRecovery:{conversationId} — Last server queue mirror retained across
//                            restart so interrupted work can be optionally replayed.
// ---------------------------------------------------------------------------
export const DRAFT_KEY_PREFIX = 'draft:';
export const PENDING_FILES_KEY_PREFIX = 'pendingFiles:';

// ---------------------------------------------------------------------------
// Validated storage. An invalid blob is discarded whole and defaults are used
// (no half-merge).
// ---------------------------------------------------------------------------

function validatedStorage<T>(parse: (raw: unknown, initialValue: T) => T | null): SyncStorage<T> {
  return {
    getItem: (key, initialValue) => {
      try {
        if (typeof localStorage === 'undefined') return initialValue;
        const raw = localStorage.getItem(key);
        if (!raw) return initialValue;
        const parsed = parse(JSON.parse(raw), initialValue);
        if (parsed === null) {
          localStorage.removeItem(key);
          return initialValue;
        }
        return parsed;
      } catch {
        return initialValue;
      }
    },
    setItem: (key, value) => {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(value));
      } catch {
        // quota / private-mode failure — in-memory state still updates
      }
    },
    removeItem: (key) => {
      try {
        if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
      } catch {
        // ignore
      }
    },
  };
}

// Partial parse over defaults so a blob written before a field existed still
// loads; zod strips keys that are no longer prefs.
const prefsStorage = validatedStorage<DeviceUiPrefs>((raw, initialValue) => {
  const result = DeviceUiPrefsSchema.partial().safeParse(raw);
  return result.success ? { ...initialValue, ...result.data } : null;
});

const seenStorage = validatedStorage<Record<string, number>>((raw) => {
  const result = SeenMessageIndexSchema.safeParse(raw);
  return result.success ? result.data : null;
});

// ---------------------------------------------------------------------------
// Retired Home pins ('unleashd-retired-home-pins'). Until 2026-09-30 Home pins lived in the prefs
// blob (`projectPins`); they are now `Task.pin` on the server, shared with Buddies. The prefs
// schema no longer has the field, and zod strips it on read, so the NEXT prefs write (any toggle)
// would silently delete a device's saved pins. They move to their own key before any prefs read,
// and Home offers Import (append them as server pins) or Discard. Nothing is applied on its own.
// ---------------------------------------------------------------------------
const RETIRED_PINS_KEY = 'unleashd-retired-home-pins';

const retiredPinsStorage = validatedStorage<RetiredHomePins>((raw) => {
  const result = RetiredHomePinsSchema.safeParse(raw);
  return result.success ? result.data : null;
});

/** κ, once per load: lift `projectPins` out of the prefs blob into its own key (merged, in order). */
function retireDevicePins(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return;
    const { projectPins, ...prefs } = JSON.parse(raw) as { projectPins?: unknown };
    if (projectPins === undefined) return;
    const found = RetiredHomePinsSchema.safeParse(projectPins);
    if (found.success) {
      const kept = retiredPinsStorage.getItem(RETIRED_PINS_KEY, {});
      const merged: RetiredHomePins = { ...kept };
      for (const [workspaceId, ids] of Object.entries(found.data)) {
        const next = [...new Set([...(kept[workspaceId] ?? []), ...ids])];
        if (next.length > 0) merged[workspaceId] = next;
      }
      retiredPinsStorage.setItem(RETIRED_PINS_KEY, merged);
    }
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // unreadable blob: prefsStorage discards it whole on its own read
  }
}
retireDevicePins();

/** Pins this device saved before server pins, per workspace; empty once imported or discarded. */
export const retiredHomePinsAtom = atomWithStorage<RetiredHomePins>(
  RETIRED_PINS_KEY,
  {},
  retiredPinsStorage,
  { getOnInit: true }
);

// getOnInit — read synchronously at first get so the first render sees the
// persisted prefs.
// Read with `useAtomValue(prefsAtom).field`: prefs change only on a user
// action, so one atom replaces the nine per-field ones it had until T19.
export const prefsAtom = atomWithStorage<DeviceUiPrefs>(
  LOCAL_STORAGE_KEY,
  PREFS_DEFAULTS,
  prefsStorage,
  { getOnInit: true }
);

/** Last seen message index per conversation; rows read it through `unreadFamily`. */
export const seenAtom = atomWithStorage<Record<string, number>>(SEEN_STORAGE_KEY, {}, seenStorage, {
  getOnInit: true,
});

// ---------------------------------------------------------------------------
// Actions — the only mutation surface.
// ---------------------------------------------------------------------------

function setPrefs(patch: Partial<DeviceUiPrefs>): void {
  jotaiStore.set(prefsAtom, { ...jotaiStore.get(prefsAtom), ...patch });
}

export function setLastWorkingDirectory(dir: string): void {
  setPrefs({ lastWorkingDirectory: dir });
}

function toggleInList(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export function toggleGalleryExpanded(dir: string): void {
  setPrefs({
    galleryExpandedProjects: toggleInList(jotaiStore.get(prefsAtom).galleryExpandedProjects, dir),
  });
}

export function toggleGalleryCollapsed(dir: string): void {
  setPrefs({
    galleryCollapsedProjects: toggleInList(jotaiStore.get(prefsAtom).galleryCollapsedProjects, dir),
  });
}

export function setShowTempSessions(show: boolean): void {
  setPrefs({ showTempSessions: show });
}

export function setShowDoneConversations(show: boolean): void {
  setPrefs({ showDoneConversations: show });
}

export function setShowWorkerConversations(show: boolean): void {
  setPrefs({ showWorkerConversations: show });
}

export function promoteWorker(conversationId: string): void {
  const promoted = jotaiStore.get(prefsAtom).promotedWorkers;
  if (!promoted.includes(conversationId)) {
    setPrefs({ promotedWorkers: [...promoted, conversationId] });
  }
}

// No bulk "mark seen" on row updates: it ran on every poller batch and hid
// NEW for exactly the external updates the badge exists to show (03 §6.2 #9).
export function markMessagesSeen(conversationId: string, messageIndex: number): void {
  const current = jotaiStore.get(seenAtom);
  if (current[conversationId] === messageIndex) return;
  jotaiStore.set(seenAtom, { ...current, [conversationId]: messageIndex });
}

/** Drop the seen-index entry for a deleted conversation. */
export function removeSeenIndex(conversationId: string): void {
  const current = jotaiStore.get(seenAtom);
  if (!(conversationId in current)) return;
  const { [conversationId]: _removed, ...rest } = current;
  jotaiStore.set(seenAtom, rest);
}

/** Home imported or discarded this workspace's retired device pins: forget them. */
export function forgetRetiredHomePins(workspaceId: string): void {
  const { [workspaceId]: _gone, ...rest } = jotaiStore.get(retiredHomePinsAtom);
  jotaiStore.set(retiredHomePinsAtom, rest);
}

// ---------------------------------------------------------------------------
// Upstream update prompt ('unleashd-upstream-handled') — the upstream `main`
// sha this device already answered, by [Later] or [Update]. The prompt
// (UpstreamUpdatePrompt) returns only when upstream moves to a new sha. Its
// own key: it is one string, unrelated to the prefs blob. Null means never
// answered on this device.
// ---------------------------------------------------------------------------

const upstreamHandledStorage = validatedStorage<string | null>((raw) =>
  typeof raw === 'string' && raw ? raw : null
);
export const upstreamHandledShaAtom = atomWithStorage<string | null>(
  'unleashd-upstream-handled',
  null,
  upstreamHandledStorage,
  { getOnInit: true }
);

export function markUpstreamHandled(sha: string): void {
  jotaiStore.set(upstreamHandledShaAtom, sha);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** NEW badge: messages past the last one this device saw. No index means
 *  never opened here, which is not "unseen". */
export function hasUnseenAfter(lastSeen: number | undefined, totalMessages: number): boolean {
  if (totalMessages === 0 || lastSeen === undefined) return false;
  return lastSeen < totalMessages - 1;
}
