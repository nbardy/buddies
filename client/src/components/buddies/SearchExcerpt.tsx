import { memo } from 'react';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useMarkdownPipeline } from '../../utils/lazyMarkdownPlugins';
import {
  type MarkdownFlavor,
  defineMarkdownFlavor,
  renderMarkdownLive,
} from '../../utils/markdown-pipeline';
import { remarkBreaks } from '../../utils/remark-breaks';
import { excerptLines, highlightPattern, remarkMarkMatches } from './search-excerpt';

// One search hit's text: markdown rendered (no raw `**`), a few lines around the first match, the
// matched spans in <mark>. The row is a <Link>, so links render as plain spans (an <a> inside an
// <a> is invalid) and images as their alt text. Rendered live, not through the settled-tree
// cache: every keystroke is a new query and would otherwise fill that cache with dead trees.

const PLAIN_FLAVOR = defineMarkdownFlavor([remarkGfm, remarkBreaks]);
const MAX_FLAVORS = 8;
const flavors = new Map<string, MarkdownFlavor>();

/** A flavor is the pipeline cache key, so one per query, shared by all results; recent ones kept. */
function flavorFor(terms: readonly string[]): MarkdownFlavor {
  const pattern = highlightPattern(terms);
  if (pattern === null) return PLAIN_FLAVOR;
  const key = pattern.source;
  const known = flavors.get(key);
  if (known) return known;
  const made = defineMarkdownFlavor([remarkGfm, remarkBreaks, [remarkMarkMatches, pattern]]);
  flavors.set(key, made);
  if (flavors.size > MAX_FLAVORS) flavors.delete(flavors.keys().next().value as string);
  return made;
}

const EXCERPT_COMPONENTS: Components = {
  a: ({ children }) => <span className="search-excerpt__link">{children}</span>,
  img: ({ alt }) => <span>{alt ?? ''}</span>,
};

export const SearchExcerpt = memo(function SearchExcerpt({
  body,
  terms,
}: {
  body: string;
  terms: readonly string[];
}) {
  const pipeline = useMarkdownPipeline(flavorFor(terms));
  return (
    <div className="search-excerpt channel-markdown">
      {renderMarkdownLive(pipeline, excerptLines(body, terms), EXCERPT_COMPONENTS)}
    </div>
  );
});
