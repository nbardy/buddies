import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChannelReference, NamedRef } from '@unleashd/shared';
import {
  activeTrigger,
  copyPayload,
  decodeChannelDraft,
  draftView,
  encodeChannelDraft,
  foreignMentions,
  inputEdit,
  mentionedBuddies,
  pastedBody,
  pickReference,
  sendBody,
  shownOffset,
  spliceDraft,
} from '../src/components/buddies/composer-draft';

const buddy = (id: string, label: string): ChannelReference => ({
  kind: 'buddy',
  id,
  label,
  detail: '',
  execution: { kind: 'unreported' },
});
const lead = buddy('b1', 'Lead');
const leadDesigner = buddy('b2', 'Lead Designer');
const task: ChannelReference = {
  kind: 'task',
  id: 't1',
  label: 'Fix login (v2)',
  detail: '',
  status: 'in_progress',
};
const roster: NamedRef[] = [
  { kind: 'buddy', id: 'b1', name: 'Lead' },
  { kind: 'buddy', id: 'b2', name: 'Lead Designer' },
];

const tokenLead = '[@Lead](buddy:b1)';
const tokenDesigner = '[@Lead Designer](buddy:b2)';

// The textarea holds the display text; the browser reports an edit as (old, new, caret). This is the
// whole round trip the composer's onChange performs.
function type(raw: string, typed: (display: string) => { value: string; caret: number }) {
  const view = draftView(raw, roster);
  const { value, caret } = typed(view.display);
  const change = inputEdit(view.display, value, caret);
  return spliceDraft(view, change.start, change.end, change.replacement);
}

test('a mention is edited as a unit until a keystroke lands inside it', () => {
  const raw = `ask ${tokenLead} now`;
  // Typing after the label keeps the identity.
  const after = type(raw, (d) => ({ value: d.replace('@Lead', '@Lead,'), caret: 10 }));
  assert.equal(after.raw, `ask ${tokenLead}, now`);
  // Backspace inside the label dissolves ONLY that mention to the text the owner saw.
  const inside = type(`${tokenLead} and ${tokenDesigner}`, (d) => ({
    value: d.replace('@Lead and', '@Lea and'),
    caret: 4,
  }));
  assert.equal(inside.raw, `@Lea and ${tokenDesigner}`);
  // Deleting a whole mention leaves its neighbours' identities alone.
  const removed = type(`${tokenLead}${tokenLead}`, () => ({ value: '@Lead', caret: 0 }));
  assert.equal(removed.raw, tokenLead);
});

// The invariant behind every offset map: after any edit that writes no token syntax, the new draft
// shows exactly what the textarea contained. A wrong raw↔display offset breaks it.
test('any edit of a draft with mentions shows the text the textarea held', () => {
  let seed = 7;
  const next = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const alphabet = ['a', ' ', '@', 'Lead', '\n', 'x y', ''];
  for (let round = 0; round < 400; round++) {
    const parts = Array.from(
      { length: 1 + next(5) },
      () => [tokenLead, tokenDesigner, 'word ', ' and ', '@Lead '][next(5)]
    );
    const view = draftView(parts.join(''), roster);
    const start = next(view.display.length + 1);
    const end = start + next(view.display.length - start + 1);
    const insert = alphabet[next(alphabet.length)];
    const edit = spliceDraft(view, start, end, insert);
    const expected = view.display.slice(0, start) + insert + view.display.slice(end);
    const after = draftView(edit.raw, roster);
    assert.equal(after.display, expected, `round ${round}: ${JSON.stringify(view.raw)}`);
    assert.equal(shownOffset(after, edit.caret), start + insert.length, `caret, round ${round}`);
  }
});

test('copy then paste keeps the local id, follows a rename, and never trusts a foreign id', () => {
  const view = draftView(`ask ${tokenLead} about ${tokenDesigner}`, roster);
  const copied = copyPayload(view, 0, view.display.length);
  assert.equal(copied.text, 'ask @Lead about @Lead Designer', 'plain text stays readable');
  assert.equal(
    pastedBody(copied.text, copied.html, roster),
    `ask ${tokenLead} about ${tokenDesigner}`
  );

  // The Buddy was renamed after the draft was written: the id wins, the label is today's.
  const renamed: NamedRef[] = [{ kind: 'buddy', id: 'b1', name: 'Chief' }];
  assert.equal(
    pastedBody(copied.text, copied.html, renamed),
    `ask [@Chief](buddy:b1) about ${tokenDesigner}`
  );

  // Another install's / workspace's id is not a Buddy here. Fix-guard 2026-10-08: it used to dissolve
  // to `@Lead` and retarget to the local Lead by name. The token now stays as written.
  const foreign = copied.html.replace('buddy:b1', 'buddy:elsewhere');
  const kept = pastedBody(copied.text, foreign, roster);
  assert.equal(kept, `ask [@Lead](buddy:elsewhere) about ${tokenDesigner}`);
  assert.equal(pastedBody(kept, '', roster), kept, 'pasting it again changes nothing');
  // Preview, chips and Send agree: the foreign mention is flagged, is no recipient, and wakes nobody.
  const pasted = draftView(kept, roster);
  assert.deepEqual(foreignMentions(pasted), ['@Lead']);
  assert.deepEqual(
    mentionedBuddies(pasted, [lead, leadDesigner]).map((b) => b.id),
    ['b2']
  );
  assert.equal(sendBody(pasted, roster), kept);
  assert.deepEqual(foreignMentions(draftView(`ask ${tokenLead}`, roster)), []);
  // An intentional edit dissolves the identity to plain text, which then reads like any typed name.
  const edited = type(kept, (d) => ({ value: d.replace('@Lead about', '@Lea about'), caret: 8 }));
  assert.equal(edited.raw, `ask @Lea about ${tokenDesigner}`);
  assert.deepEqual(foreignMentions(draftView(edited.raw, roster)), []);
  assert.equal(
    pastedBody(copied.text, foreign, [{ kind: 'buddy', id: 'b9', name: 'Other' }]),
    `ask [@Lead](buddy:elsewhere) about ${tokenDesigner}`,
    'ids stay as written even when no roster Buddy shares the name'
  );
});

test('a rendered Task chip pastes with its id; Task identity survives a copy from the composer', () => {
  // ChannelMarkdown puts the attribute on the chip's title span, beside a decorative glyph.
  const html =
    '<span class="channel-task-chip"><span class="glyph">◇</span><span class="channel-task-chip-title" data-unleashd-ref="task:t1">Fix login (v2)</span></span>';
  assert.equal(
    pastedBody('◇ Fix login (v2) is blocked', html, roster),
    '◇ [Fix login (v2)](task:t1) is blocked'
  );
  const view = draftView('see [Fix login (v2)](task:t1) now', roster);
  const copied = copyPayload(view, 0, view.display.length);
  assert.equal(pastedBody(copied.text, copied.html, roster), view.raw);
});

test('a partial selection copies the readable text, not half an identity', () => {
  const view = draftView(`${tokenLead} please`, roster);
  const half = copyPayload(view, 2, view.display.length);
  assert.equal(half.text, 'ead please');
  assert.ok(!half.html.includes('data-unleashd-ref'));
  const whole = copyPayload(view, 0, 5);
  assert.ok(whole.html.includes('data-unleashd-ref="buddy:b1"'));
});

test('a rendered mention pastes with its id; another app’s text resolves only exact unique names', () => {
  // What Chrome puts on the clipboard for a selected rendered mention (ChannelMarkdown's link).
  const html =
    '<meta charset="utf-8"><a class="channel-mention" href="http://localhost:5173/buddies/b2">@Lead Designer</a>, thanks';
  assert.equal(pastedBody('@Lead Designer, thanks', html, roster), `${tokenDesigner}, thanks`);

  // Slack-style plain text carries no ids: exact names resolve, everything else stays text.
  const slack = 'cc @Lead and @LeadX; mail me@lead.example; `@Lead` stays code';
  assert.equal(
    pastedBody(slack, '', roster),
    `cc ${tokenLead} and @LeadX; mail me@lead.example; \`@Lead\` stays code`
  );
  const twins: NamedRef[] = [...roster, { kind: 'buddy', id: 'b3', name: 'Lead' }];
  assert.equal(pastedBody('cc @Lead', '', twins), 'cc @Lead', 'a duplicate name is never guessed');
});

test('picking inserts a token, closes the menu, and the chip follows the text', () => {
  const typed = draftView('ask @le', roster);
  const trigger = activeTrigger(typed, 7);
  assert.deepEqual(trigger, { start: 4, query: 'le' });
  assert.ok(trigger);
  const edit = pickReference(typed, trigger, leadDesigner);
  assert.equal(edit.raw, `ask ${tokenDesigner} `);
  const picked = draftView(edit.raw, roster);
  // 2026-09-24: the menu stayed open after a pick and covered the model chip.
  assert.equal(activeTrigger(picked, shownOffset(picked, edit.caret)), null);
  // Typing the exact name of a Buddy is still a live query, and still a mention.
  const exact = draftView('ask @Lead', roster);
  assert.ok(activeTrigger(exact, 9));
  assert.deepEqual(
    mentionedBuddies(exact, [lead, task]).map((b) => b.id),
    ['b1']
  );
  // Deleting the label removes the chip (the server rejects a model choice for an unmentioned Buddy).
  const gone = draftView(spliceDraft(picked, 0, picked.display.length, '').raw, roster);
  assert.deepEqual(mentionedBuddies(gone, [lead]), []);
  // "@Lead Designer" is one mention, not Lead plus text.
  assert.deepEqual(
    mentionedBuddies(picked, [lead, leadDesigner]).map((b) => b.id),
    ['b2']
  );
});

test('send serializes once; code and e-mail stay text', () => {
  const view = draftView('@Lead Designer, see `@Lead` or a@Lead.com  ', roster);
  assert.equal(sendBody(view, roster), `${tokenDesigner}, see \`@Lead\` or a@Lead.com`);
});

test('drafts store Markdown; a pre-2026-10-08 draft folds its picks into tokens once', () => {
  const config = {
    provider: 'codex' as const,
    model: { mode: 'explicit' as const, modelId: 'gpt-6.1-sol' },
    reasoning: { mode: 'explicit' as const, effort: 'high' },
  };
  const stored = encodeChannelDraft({
    text: `hey ${tokenLead}`,
    mentionConfigs: [{ buddyId: 'b1', config }],
  });
  assert.deepEqual(decodeChannelDraft(stored), {
    text: `hey ${tokenLead}`,
    mentionConfigs: [{ buddyId: 'b1', config }],
  });

  const legacy = JSON.stringify({
    text: 'hey @Lead Designer and @Lead, see @Fix login (v2). @Leadership',
    picked: [lead, leadDesigner, lead, task],
    mentionConfigs: [{ buddyId: 'b1', config }],
  });
  const migrated = decodeChannelDraft(legacy);
  assert.equal(
    migrated.text,
    `hey ${tokenDesigner} and ${tokenLead}, see [Fix login (v2)](task:t1). @Leadership`
  );
  assert.equal(migrated.mentionConfigs?.[0].buddyId, 'b1', 'an unsent model choice survives');
  assert.equal(encodeChannelDraft({ text: '' }), '');
  assert.deepEqual(decodeChannelDraft('{"text":7}'), { text: '' });
});
