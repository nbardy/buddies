import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CODEX_INSTALLED, buddyFixture, rosterFixture } from './fixtures/buddy-roster';
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
const LOADED_NONE = { kind: 'loaded', seats: [] } as const;

test('an unseated mention follows the model-only profile on its actual harness', () => {
  const buddy = buddyFixture({
    id: 'lead',
    name: 'Lead',
    model: 'claude-opus-5-5',
    reasoningEffort: 'high',
  });
  const ref = workspaceDirectory([rosterFixture([buddy])], 'ws-1', [], CODEX_INSTALLED)
    .references[0];
  assert.equal(ref.kind, 'buddy');
  if (ref.kind !== 'buddy') throw new Error('missing Buddy');
  const choice = mentionChoice(ref, new Map(), LOADED_NONE);
  assert.ok('config' in choice);
  assert.equal(choice.config.provider, 'claude');
  assert.deepEqual(choice.config.model, { mode: 'explicit', modelId: 'claude-opus-5-5' });
  assert.deepEqual(choice.config.reasoning, { mode: 'explicit', effort: 'high' });
  assert.equal(choiceLabel(choice, null), 'claude-opus-5-5 · high');
});

// Fresh-install trial 2026-10-05: the chip of an unpinned Buddy said one model while a
// hardcoded Codex ran. It now resolves from the install's agent, the same value the server
// reads (GET /api/dependencies), and says "Needs an agent" when there is none.
test('an unpinned mention follows the installed agent; a pinned one ignores it', () => {
  const unpinned = buddyFixture({ id: 'dev', name: 'Product Dev' });
  const pinned = buddyFixture({ id: 'rm', name: 'Release Manager', provider: 'codex' });
  const label = (agent: Parameters<typeof workspaceDirectory>[3], index: number) => {
    const ref = workspaceDirectory([rosterFixture([unpinned, pinned])], 'ws-1', [], agent)
      .references[index];
    if (ref.kind !== 'buddy') throw new Error('missing Buddy');
    return choiceLabel(mentionChoice(ref, new Map(), LOADED_NONE), null);
  };
  const claudeOnly = { kind: 'agent', provider: 'claude' } as const;
  assert.match(label(claudeOnly, 0), /^claude/);
  assert.match(label(claudeOnly, 1), /^codex/, 'the owner pin is not the install default');
  assert.equal(label({ kind: 'none' }, 0), 'Needs an agent');
  assert.match(label({ kind: 'none' }, 1), /^codex/);
  assert.equal(label(null, 0), 'Loading model…', 'unknown agent waits, it does not guess');
  assert.match(label(null, 1), /^codex/);
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
