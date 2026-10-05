import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';

register(
  `data:text/javascript,${encodeURIComponent(`
  export async function load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    return nextLoad(url, context);
  }
`)}`,
  import.meta.url
);
const { SearchExcerpt } = await import('../src/components/buddies/SearchExcerpt');
const { excerptLines, searchTerms } = await import('../src/components/buddies/search-excerpt');

const html = (body: string, query: string) =>
  renderToStaticMarkup(<SearchExcerpt body={body} terms={searchTerms(query)} />);

// Owner report 2026-10-05: results showed raw `**` and no highlight. A hit renders as markdown,
// marks the matched word and its word forms, and never nests an <a> (the row is already a link).
test('an excerpt renders markdown with the matched word forms marked', () => {
  const out = html(
    '**Go to market** plan: see [the marketing site](https://x.test) and ![logo](/a.png)',
    'market'
  );
  assert.ok(!out.includes('**'), out);
  assert.match(out, /<strong>Go to <mark>market<\/mark><\/strong>/);
  assert.match(out, /<mark>marketing<\/mark>/);
  assert.ok(!out.includes('<a '), 'a link inside the result link would be invalid HTML');
  assert.ok(!out.includes('<img'), out);
});

test('a plural query marks the singular and a query with no words marks nothing', () => {
  assert.match(html('one post here', 'posts'), /<mark>post<\/mark>/);
  assert.ok(!html('one post here', '@lead -draft OR').includes('<mark>'));
});

test('the excerpt starts a line above the first match, is bounded, and keeps fences closed', () => {
  const body = ['a', 'b', 'c', 'the needle line', 'e', 'f', 'g', 'h', 'i'].join('\n');
  assert.equal(excerptLines(body, ['needle']), '…\n\nc\nthe needle line\ne\nf\ng\nh\n\n…');
  const fenced = ['intro', '```ts', 'let market = 1;', 'x', 'y', 'z', 'w', 'v'].join('\n');
  assert.ok(
    excerptLines(fenced, ['market']).endsWith('w\n```\n\n…'),
    'a fence the window cut open is closed'
  );
  const long = `${'word '.repeat(200)}market ${'tail '.repeat(200)}`;
  const clipped = excerptLines(long, ['market']);
  assert.ok(clipped.includes('market') && clipped.length < 400, `${clipped.length}`);
});
