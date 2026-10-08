import assert from 'node:assert/strict';
import { test } from 'node:test';
import { draftView, sendBody, spliceDraft } from '../src/components/buddies/composer-draft';
import { activeEmojiQuery, rankEmoji } from '../src/components/buddies/emoji-completion';

test('colon opens suggestions, names filter, URLs/times/code stay literal', () => {
  assert.deepEqual(activeEmojiQuery(':', 1), { start: 0, query: '' });
  assert.deepEqual(activeEmojiQuery('Hi :smile', 9), { start: 3, query: 'smile' });
  for (const text of ['https:', '12:30', '`code :smile', '```\n:smile', '~~~\n:smile', '::smile'])
    assert.equal(activeEmojiQuery(text, text.length), null, text);
  assert.ok(rankEmoji('').length > 0);
  assert.equal(rankEmoji('smile')[0].emoji, '😄');
  assert.equal(rankEmoji('+1')[0].emoji, '👍');
  assert.equal(rankEmoji('rocket')[0].emoji, '🚀');
  assert.deepEqual(rankEmoji('unknown_emoji_name'), []);
});

test('emoji edit preserves canonical mention identity and surrounding draft text', () => {
  const roster = [{ kind: 'buddy' as const, id: 'buddy_lead', name: 'Lead' }];
  const view = draftView('[@Lead](buddy:buddy_lead) :rocket after', roster);
  const caret = view.display.indexOf(' after');
  const trigger = activeEmojiQuery(view.display, caret);
  assert.ok(trigger);
  const choice = rankEmoji(trigger.query)[0];
  const edit = spliceDraft(view, trigger.start, caret, choice.emoji);
  assert.equal(sendBody(draftView(edit.raw, roster), roster), '[@Lead](buddy:buddy_lead) 🚀 after');
});
