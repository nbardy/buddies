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
