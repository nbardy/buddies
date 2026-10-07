import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConversationConfig } from '@unleashd/shared';
import {
  type ChannelReference,
  activeReferenceQuery,
  choiceLabel,
  mentionChoice,
  rankReferences,
} from '../src/components/buddies/channel-text';
import type { ThreadSeat } from '../src/components/buddies/types';

const unreported = { kind: 'unreported' } as const;
const lead: ChannelReference = {
  kind: 'buddy',
  id: 'b1',
  label: 'Lead',
  detail: '',
  execution: unreported,
};
const LOADED_NONE = { kind: 'loaded', seats: [] } as const;
const loaded = (seats: ThreadSeat[]) => ({ kind: 'loaded' as const, seats });

test('the @ trigger needs a word start and stops at newlines', () => {
  assert.deepEqual(activeReferenceQuery('ask @fix lo', 11), { start: 4, query: 'fix lo' });
  assert.equal(activeReferenceQuery('mail me@example.com', 19), null);
  assert.equal(activeReferenceQuery('@lead\nnext', 10), null);
});

test('fuzzy ranking favours word-start matches', () => {
  const references: ChannelReference[] = [
    { kind: 'task', id: 'x', label: 'Upload deadline', detail: '', status: 'ready' },
    {
      kind: 'buddy',
      id: 'y',
      label: 'Product Development Lead',
      detail: '',
      execution: unreported,
    },
  ];
  assert.deepEqual(
    rankReferences('pdl', references).map((reference) => reference.id),
    ['y', 'x']
  );
  assert.deepEqual(rankReferences('zzz', references), []);
});

// Live workspaces carry dozens of done Tasks; without the penalty they crowd
// the eight picker slots ahead of the live work you are trying to mention.
test('finished Tasks sink below live ones with the same match', () => {
  const task = (id: string, status: string): ChannelReference => ({
    kind: 'task',
    id,
    label: 'Preserve context',
    detail: '',
    status,
  });
  assert.deepEqual(
    rankReferences('pres', [task('done', 'done'), task('live', 'in_progress')]).map(
      (reference) => reference.id
    ),
    ['live', 'done']
  );
});

// 493c1c7: an un-picked mention in a thread showed the Buddy's PROFILE default even though its
// seat there runs an earlier pick, so the chip lied and a change started from the wrong baseline.
test('a mention chip opens on the thread seat; the profile applies only without one', () => {
  const profile: ConversationConfig = {
    provider: 'codex',
    model: { mode: 'explicit', modelId: 'gpt-5.6-sol' },
    reasoning: { mode: 'default' },
  };
  const seat: ConversationConfig = {
    provider: 'claude',
    model: { mode: 'explicit', modelId: 'opus' },
    reasoning: { mode: 'explicit', effort: 'high' },
  };
  const buddy = { ...lead, execution: { kind: 'profile', config: profile } } as const;
  assert.equal(
    choiceLabel(mentionChoice(buddy, new Map(), { kind: 'loading' }), null),
    'Loading model…',
    'an unread thread must not advertise its profile as the next model'
  );
  const none = mentionChoice(buddy, new Map(), LOADED_NONE);
  assert.deepEqual('config' in none ? none.config : null, profile);
  assert.equal(choiceLabel(none, null), 'gpt-5.6-sol');

  const seated = mentionChoice(buddy, new Map(), loaded([{ buddyId: 'b1', config: seat }]));
  assert.deepEqual('config' in seated ? seated.config : null, seat);
  assert.equal(choiceLabel(seated, null), 'opus · high');

  const chosen = mentionChoice(
    buddy,
    new Map([['b1', profile]]),
    loaded([{ buddyId: 'b1', config: seat }])
  );
  assert.equal(chosen.kind, 'chosen', 'a pick in this composer beats the seat');
  assert.deepEqual(chosen.config, profile);
});
