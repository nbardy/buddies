import type { Parent, Root, Text } from 'mdast';
import type { Plugin } from 'unified';

// The channel Search panel shows each hit as a few lines of rendered markdown around the first
// match, with the matched spans marked. The server matches by prefix, stem and typo; the client
// only has the words the owner typed, so it marks words that START with a typed word (or with
// its stem, so "posts" marks "post"). A typo hit has nothing to mark and still shows its lines.

const CONTEXT_BEFORE = 1;
const MAX_LINES = 6;
const MAX_LINE_CHARS = 320;

/** The plain words of a search text: no `@author`, `-exclusion`, `OR` or quote marks. */
export function searchTerms(query: string): string[] {
  return query
    .split(/\s+/)
    .filter((word) => word !== 'OR' && !word.startsWith('@') && !word.startsWith('-'))
    .map((word) => word.replace(/"/g, '').toLowerCase())
    .filter((word) => word.length >= 2);
}

const SUFFIXES = ['ing', 'ed', 'es', 's'];

/** "posts" → "post", "marketing" → "market"; a word never stems below four letters. */
function stem(word: string): string {
  for (const suffix of SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 4)
      return word.slice(0, -suffix.length);
  }
  return word;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Words that start with any typed word's stem; null when nothing was typed to mark. */
export function highlightPattern(terms: readonly string[]): RegExp | null {
  if (terms.length === 0) return null;
  const starts = [...new Set(terms.map(stem))].map(escapeRegExp).join('|');
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${starts})[\\p{L}\\p{N}]*`, 'giu');
}

/** A long line clipped around `at` so the match stays on screen. */
function clipLine(line: string, at: number): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  const from = Math.max(0, at - Math.floor(MAX_LINE_CHARS / 3));
  const to = Math.min(line.length, from + MAX_LINE_CHARS);
  return `${from > 0 ? '…' : ''}${line.slice(from, to)}${to < line.length ? '…' : ''}`;
}

/**
 * Up to MAX_LINES lines of `body` starting one line above the first match (or at the top when
 * nothing matches), as markdown source. A code fence the window cuts open is closed again so
 * the rest of the result does not render as code.
 */
export function excerptLines(body: string, terms: readonly string[]): string {
  const lines = body.trim().split('\n');
  const pattern = highlightPattern(terms);
  // `highlightPattern` is global (for matchAll); a search needs the same source without state.
  const probe = pattern && new RegExp(pattern.source, 'iu');
  const first = probe ? lines.findIndex((line) => probe.test(line)) : -1;
  const start = first < 0 ? 0 : Math.max(0, first - CONTEXT_BEFORE);
  const end = Math.min(lines.length, start + MAX_LINES);
  const window = lines
    .slice(start, end)
    .map((line, index) =>
      clipLine(line, start + index === first && probe ? line.search(probe) : 0)
    );
  const fences = window.filter((line) => line.trimStart().startsWith('```')).length;
  const closed = fences % 2 === 1 ? [...window, '```'] : window;
  return `${start > 0 ? '…\n\n' : ''}${closed.join('\n')}${end < lines.length ? '\n\n…' : ''}`;
}

/**
 * Remark plugin: wraps each match in text nodes as a `<mark>` (an emphasis node with hName).
 * Code and inline code keep their value untouched. Runs after remarkBreaks, which only rewrites
 * text and breaks.
 */
export const remarkMarkMatches: Plugin<[RegExp], Root> = (pattern) => (tree) => {
  const visit = (node: Parent) => {
    const next: Parent['children'] = [];
    for (const child of node.children) {
      if (child.type !== 'text') {
        if ('children' in child) visit(child as Parent);
        next.push(child);
        continue;
      }
      let last = 0;
      for (const match of child.value.matchAll(pattern)) {
        const at = match.index ?? 0;
        if (at > last) next.push({ type: 'text', value: child.value.slice(last, at) } as Text);
        next.push({
          type: 'emphasis',
          data: { hName: 'mark' },
          children: [{ type: 'text', value: match[0] } as Text],
        });
        last = at + match[0].length;
      }
      if (last === 0) next.push(child);
      else if (last < child.value.length)
        next.push({ type: 'text', value: child.value.slice(last) } as Text);
    }
    node.children = next;
  };
  visit(tree);
};
