import { atomWithStorage, createJSONStorage } from 'jotai/utils';
import { jotaiStore } from './store';

export type EmojiUsage = Record<string, number>;
const EMPTY: EmojiUsage = {};
// Pattern: one-definition (docs/patterns.md#one-definition)
// Personal frequency is a device preference; both composer and reaction picker read this atom.
const absentStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const storage = createJSONStorage<EmojiUsage>(() =>
  typeof localStorage === 'undefined' ? absentStorage : localStorage
);
export const emojiUsageAtom = atomWithStorage<EmojiUsage>(
  'unleashd-emoji-usage',
  EMPTY,
  {
    ...storage,
    getItem(key, initial) {
      const value = storage.getItem(key, initial);
      return value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.values(value).every((count) => Number.isSafeInteger(count) && count > 0)
        ? value
        : initial;
    },
    setItem(key, value) {
      try {
        storage.setItem(key, value);
      } catch {
        /* Private mode: retain in-memory counts. */
      }
    },
  },
  { getOnInit: true }
);

export function recordEmojiUse(emoji: string): void {
  const held = jotaiStore.get(emojiUsageAtom);
  const entries = Object.entries({ ...held, [emoji]: (held[emoji] ?? 0) + 1 })
    .filter(([, count]) => Number.isSafeInteger(count) && count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 100);
  jotaiStore.set(emojiUsageAtom, Object.fromEntries(entries));
}
