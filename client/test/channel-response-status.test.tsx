import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';
import type { ChannelResponse, LiveReach } from '@unleashd/shared';
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
const { Replying } = await import('../src/components/buddies/ChannelRows');
import { respondingText } from '../src/components/buddies/channel-data';

// Busy seats were called "at the run limit" even for owner posts that bypass capacity.
// Render the actual indicator; only an actual pool_full row may claim a run limit.
test('a busy thread names its delivery boundary; only capacity names the run limit', () => {
  const row: ChannelResponse = {
    channelId: 'channel',
    threadRootId: 'root',
    buddyId: 'buddy',
    startedAt: '',
    state: 'queued',
    waiting: { kind: 'conversation_busy' },
  };
  const render = (response: ChannelResponse) =>
    renderToStaticMarkup(
      <Replying text={respondingText([response], { buddy: 'Ada' }).get('root')!} />
    );
  const cases: Array<[LiveReach | undefined, RegExp]> = [
    [{ kind: 'next_step' }, /next step/],
    [{ kind: 'buddy_tool_only', harness: 'gemini' }, /gemini.*next Buddy tool call/],
    [{ kind: 'spawned_before_live_delivery' }, /started before live delivery/],
    [{ kind: 'model_pick' }, /picked model after this turn/],
    [{ kind: 'turn_not_live' }, /after its current turn ends/],
    [undefined, /after its current turn ends/],
  ];
  for (const [reach, expected] of cases) {
    const html = render({ ...row, reach });
    assert.match(html, expected);
    assert.doesNotMatch(html, /waiting|run limit/);
    assert.match(html, /aria-live="polite"/);
  }
  assert.match(
    render({ ...row, waiting: { kind: 'pool_full', active: 5, max: 5 } }),
    /run limit \(5\/5\)/
  );
});

// Owner, 2026-10-12: 15 posts queued behind Game Designer's busy turn named it 15 times.
test('a Buddy with many waiting posts is named once, with the count', () => {
  const row = (buddyId: string, state: ChannelResponse['state']): ChannelResponse => ({
    channelId: 'channel',
    threadRootId: 'root',
    buddyId,
    startedAt: '',
    state,
    ...(state === 'queued'
      ? { waiting: { kind: 'conversation_busy' as const }, reach: { kind: 'next_step' as const } }
      : {}),
  });
  const rows = [
    row('designer', 'background'),
    ...Array.from({ length: 15 }, () => row('designer', 'queued')),
    row('engineer', 'replying'),
    row('ceo', 'queued'),
  ];
  const text = respondingText(rows, { designer: 'Game Designer', engineer: 'Eng', ceo: 'CEO' }).get(
    'root'
  );
  assert.equal(
    text,
    'Game Designer is running background work… · Game Designer (15 posts) and CEO are taking new messages at its next step… · Eng is replying…'
  );
});
