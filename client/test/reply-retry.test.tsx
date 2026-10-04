import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { postFixture } from './fixtures/channel-posts';

register(
  `data:text/javascript,${encodeURIComponent(`
    export async function load(url, context, nextLoad) {
      if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
      return nextLoad(url, context);
    }
  `)}`,
  import.meta.url
);
const { ReplyRetry } = await import('../src/components/buddies/HarnessPicker');

// The weekly-limit reply gate used a different error envelope and lost the retry button.
test('failed should-reply checks and unavailable models show the model retry action', () => {
  for (const body of [
    "Couldn’t reply: could not decide whether to reply (gate run ended: error (You've hit your weekly limit))",
    'Couldn’t reply: could not decide whether to reply (no answer within 90s)',
    'Couldn’t reply: Model is unavailable for codex: claude-opus-5-5',
    'Couldn’t reply: Out of tokens: usage limit',
  ]) {
    const html = renderToStaticMarkup(
      <ReplyRetry post={postFixture({ id: 'failed-reply', purpose: 'reply_failed', body })} />
    );
    assert.match(html, /Retry with model…/);
  }
});

test('non-model failures and ordinary prose have no model retry action', () => {
  for (const post of [
    postFixture({
      id: 'failed-reply',
      purpose: 'reply_failed',
      body: 'Couldn’t reply: Buddy is not active',
    }),
    postFixture({
      id: 'failed-reply',
      purpose: 'reply',
      body: 'could not decide whether to reply',
    }),
  ])
    assert.equal(renderToStaticMarkup(<ReplyRetry post={post} />), '');
});
