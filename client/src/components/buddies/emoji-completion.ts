import data from './emoji-data.json';

export type EmojiChoice = { emoji: string; name: string; aliases: string[]; tags: string[] };

// Pattern: one-definition (docs/patterns.md#one-definition)
// Local GitHub gemoji catalog (MIT; emoji-data.LICENSE), shared by both composer shells.
const catalog: EmojiChoice[] = data.map(([emoji, aliases, tags]) => ({
  emoji: emoji as string,
  name: (aliases as string[])[0],
  aliases: aliases as string[],
  tags: tags as string[],
}));
const favorites = [
  'smile',
  'thumbsup',
  'heart',
  'tada',
  'rocket',
  'eyes',
  'fire',
  'white_check_mark',
];

export function activeEmojiQuery(
  text: string,
  caret: number
): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /(?:^|[\s(\[{]):([a-zA-Z0-9_+\-]*)$/.exec(before);
  if (!match) return null;
  // A colon in unfinished inline/fenced code stays literal; URLs and times fail the boundary above.
  if ((before.match(/`+|~{3,}/g)?.length ?? 0) % 2 !== 0) return null;
  return { start: caret - match[1].length - 1, query: match[1] };
}

export function rankEmoji(
  query: string,
  usage: Readonly<Record<string, number>> = {}
): EmojiChoice[] {
  const needle = query.toLowerCase();
  if (!needle) {
    const used = catalog
      .filter((entry) => usage[entry.emoji] > 0)
      .sort((a, b) => usage[b.emoji] - usage[a.emoji]);
    const defaults = favorites.flatMap((name) =>
      catalog.filter((entry) => entry.aliases.includes(name))
    );
    return [...new Set([...used, ...defaults])].slice(0, 8);
  }
  const score = (entry: EmojiChoice) =>
    entry.aliases.includes(needle)
      ? 0
      : entry.aliases.some((name) => name.startsWith(needle))
        ? 1
        : 2;
  return catalog
    .filter((entry) => [...entry.aliases, ...entry.tags].some((name) => name.includes(needle)))
    .sort((a, b) => score(a) - score(b))
    .slice(0, 8);
}
