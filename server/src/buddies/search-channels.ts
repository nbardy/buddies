import type { Channel } from '@unleashd/buddies-core';

// A search that names a channel ("market" → #marketing-website) shows that channel as a result
// row above the posts. Channel names are not in the post index, so the match lives here, on the
// rows the owner's inbox already returns (every public channel of the workspace).

/** The plain words of a search text: no `@author`, `-exclusion`, `OR` or quotes. */
export function searchWords(text: string): string[] {
  return text
    .split(/\s+/)
    .filter(
      (word) => word !== '' && word !== 'OR' && !word.startsWith('@') && !word.startsWith('-')
    )
    .map((word) => word.replace(/"/g, '').toLowerCase())
    .filter((word) => word !== '');
}

/**
 * Public channels (callers pass the inbox, which holds live ones only) whose name matches EVERY word: a word matches when a hyphen/space
 * separated part of the name starts with it (`market` → `marketing-website`). A text with no
 * plain words (just `@author`) names no channel.
 */
export function channelsNamed(channels: readonly Channel[], text: string): Channel[] {
  const words = searchWords(text);
  if (words.length === 0) return [];
  return channels.filter((channel) => {
    if (channel.kind.type !== 'public') return false;
    const parts = channel.kind.name.toLowerCase().split(/[^a-z0-9]+/);
    return words.every((word) => parts.some((part) => part.startsWith(word)));
  });
}
