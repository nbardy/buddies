import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { buddyFixture, rosterFixture } from './fixtures/buddy-roster';
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
const { workspaceDirectory } = await import('../src/components/buddies/channel-data');
const { choiceLabel, mentionChoice } = await import('../src/components/buddies/channel-text');
const { loadResource } = await import('../src/atoms/resources');
const { jotaiStore } = await import('../src/atoms/store');
const { Provider } = await import('jotai');

// Model-only profiles used to display Codex while server inference launched Claude.
test('an unseated mention follows the model-only profile on its actual harness', () => {
  const buddy = buddyFixture({
    id: 'lead',
    name: 'Lead',
    model: 'claude-opus-5-5',
    reasoningEffort: 'high',
  });
  const ref = workspaceDirectory([rosterFixture([buddy])], 'ws-1', []).references[0];
  assert.equal(ref.kind, 'buddy');
  if (ref.kind !== 'buddy') throw new Error('missing Buddy');
  const choice = mentionChoice(ref, new Map(), []);
  assert.ok('config' in choice);
  assert.equal(choice.config.provider, 'claude');
  assert.deepEqual(choice.config.model, { mode: 'explicit', modelId: 'claude-opus-5-5' });
  assert.deepEqual(choice.config.reasoning, { mode: 'explicit', effort: 'high' });
  assert.equal(choiceLabel(choice, null), 'claude-opus-5-5 · high');
});

// The weekly-limit reply gate used a different error envelope and lost the retry button.
test('failed should-reply checks and unavailable models show the model retry action', () => {
  for (const body of [
    "Couldn’t reply: You've hit your weekly limit · resets 7pm (Asia/Makassar)",
    'Couldn’t reply: You’ve hit your weekly limit · resets 7pm (Asia/Makassar)',
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

test('retry waits for the authoritative thread selection instead of seeding an arbitrary model', async () => {
  const post = postFixture({
    id: 'retry-waits',
    rootId: 'thread-retry-waits',
    author: { kind: 'buddy', id: 'lead' },
    purpose: 'reply_failed',
    body: "Couldn’t reply: You've hit your weekly limit",
  });
  const render = () =>
    renderToStaticMarkup(
      <Provider store={jotaiStore}>
        <ReplyRetry post={post} />
      </Provider>
    );
  assert.match(render(), /disabled=""/);
  await loadResource({
    key: '/api/buddies/posts/thread-retry-waits/thread',
    load: async () => ({
      seats: [
        {
          buddyId: 'lead',
          config: {
            provider: 'codex',
            model: { mode: 'explicit', modelId: 'gpt-6.1-sol' },
            reasoning: { mode: 'explicit', effort: 'high' },
          },
        },
      ],
    }),
  });
  assert.doesNotMatch(render(), /disabled=""/);
});
