import assert from 'node:assert/strict';
import test from 'node:test';
import type { ConversationConfig } from '@unleashd/shared';
import {
  type ChannelReference,
  activeReferenceQuery,
  choiceLabel,
  completesPickedReference,
  composerReferenceMarks,
  decodeChannelDraft,
  encodeChannelDraft,
  encodeReferences,
  insertReference,
  mentionChoice,
  mentionedBuddies,
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
const leadDesigner: ChannelReference = {
  kind: 'buddy',
  id: 'b2',
  label: 'Lead Designer',
  detail: '',
  execution: unreported,
};
const task: ChannelReference = {
  kind: 'task',
  id: 't1',
  label: 'Fix login (v2)',
  detail: '',
  status: 'in_progress',
};

// A mention token is what starts a Buddy's turn server-side, so a wrong
// encoding either wakes the wrong Buddy or silently wakes nobody.
const LOADED_NONE = { kind: 'loaded', seats: [] } as const;
const loaded = (seats: ThreadSeat[]) => ({ kind: 'loaded' as const, seats });

test('encoding prefers the longest picked label and needs a word boundary', () => {
  assert.equal(
    encodeReferences('@Lead Designer and @Lead, see @Fix login (v2).', [lead, leadDesigner, task]),
    '[@Lead Designer](buddy:b2) and [@Lead](buddy:b1), see [Fix login (v2)](task:t1).'
  );
  // "@Leadership" is not a pick of "Lead"; an unpicked "@Dev" stays text.
  assert.equal(encodeReferences('@Leadership @Dev', [lead]), '@Leadership @Dev');
});

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

// Mention chips carry model choices, and the server rejects a post whose
// mentionConfigs name a Buddy the body does not mention. So a chip must vanish
// when its @Label is deleted, and "@Lead Designer" must not grow a Lead chip —
// reading chips straight off the picked list would do both.
test('mention chips follow the text, not the picked list', () => {
  const picked = [lead, leadDesigner, task];
  assert.deepEqual(
    mentionedBuddies('@Lead Designer and @Lead, see @Fix login (v2)', picked).map((b) => b.id),
    ['b2', 'b1']
  );
  assert.deepEqual(
    mentionedBuddies('ask @Lead Designer', picked).map((b) => b.id),
    ['b2']
  );
  assert.deepEqual(mentionedBuddies('never mind', picked), []);
});

test('a restored mention uses the current profile rather than its draft execution snapshot', () => {
  const old = {
    ...lead,
    execution: {
      kind: 'profile' as const,
      config: {
        provider: 'claude' as const,
        model: { mode: 'default' as const },
        reasoning: { mode: 'default' as const },
      },
    },
  };
  const current = {
    ...lead,
    label: 'Renamed Lead',
    execution: {
      kind: 'profile' as const,
      config: { ...old.execution.config, provider: 'codex' as const },
    },
  };
  const [mention] = mentionedBuddies('@Lead', [old], [current]);
  assert.equal(mention.label, 'Lead', 'retain the identity spelled in the draft');
  assert.deepEqual(mentionChoice(mention, new Map(), LOADED_NONE), {
    kind: 'profile',
    config: current.execution.config,
  });
});

// 2026-09-24: after Enter picked a Buddy, "@Product Development Lead " was
// still a live query (queries may hold spaces), so the @ menu never closed and
// covered the mention chip's model picker.
test('a picked reference closes the @ query it completed', () => {
  const trigger = activeReferenceQuery('ask @le', 7);
  assert.ok(trigger);
  const inserted = insertReference('ask @le', trigger, leadDesigner);
  const after = activeReferenceQuery(inserted.text, inserted.caret);
  assert.ok(after);
  const all = [lead, leadDesigner, task];
  assert.equal(completesPickedReference(after.query, [leadDesigner], all), true);
  assert.equal(completesPickedReference('Lead Designer can you', [leadDesigner], all), true);
  // Still typing toward a longer name keeps the menu open.
  assert.equal(completesPickedReference('Lead Des', [lead], all), false);
});

test('a picked @name is marked in the composer exactly where send will tokenise it', () => {
  const text = '@Lead Designer and @Lead, see @Fix login (v2). @Leadership';
  const picked = [lead, leadDesigner, task];
  assert.deepEqual(composerReferenceMarks(text, picked), [
    { start: 0, end: '@Lead Designer'.length, kind: 'buddy' },
    {
      start: text.indexOf('@Lead,'),
      end: text.indexOf('@Lead,') + '@Lead'.length,
      kind: 'buddy',
    },
    {
      start: text.indexOf('@Fix login (v2)'),
      end: text.indexOf('@Fix login (v2)') + '@Fix login (v2)'.length,
      kind: 'task',
    },
  ]);
  assert.deepEqual(composerReferenceMarks('@Leadership', [lead]), []);
});

// A draft must bring its picks back with the text (2026-09-24 draft fix):
// saving the text alone would restore `@Lead` as plain words, and the post
// would then mention nobody and start no reply.
test('a restored draft still encodes its mentions', () => {
  const text = 'hey @Lead can you check this';
  const restored = decodeChannelDraft(encodeChannelDraft({ text, picked: [lead] }));
  assert.equal(
    encodeReferences(restored.text, restored.picked),
    'hey [@Lead](buddy:b1) can you check this'
  );
  // Clearing the text deletes the key rather than storing an empty object,
  // and a blob that is not a draft is discarded whole.
  assert.equal(encodeChannelDraft({ text: '', picked: [lead] }), '');
  assert.deepEqual(decodeChannelDraft('{"text":7}'), { text: '', picked: [] });
  const config: ConversationConfig = {
    provider: 'codex',
    model: { mode: 'explicit', modelId: 'gpt-6.1-sol' },
    reasoning: { mode: 'explicit', effort: 'high' },
  };
  const chosenDraft = decodeChannelDraft(
    encodeChannelDraft({ text, picked: [lead], mentionConfigs: [{ buddyId: lead.id, config }] })
  );
  assert.deepEqual(
    chosenDraft.mentionConfigs,
    [{ buddyId: lead.id, config }],
    'an unsent override survives reload'
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
