import assert from 'node:assert/strict';
import test from 'node:test';
import { type NamedRef, bodyPieces, mentionedIds, resolveReferences } from '@unleashd/shared';

const roster: NamedRef[] = [
  { kind: 'buddy', id: 'b1', name: 'Lead' },
  { kind: 'buddy', id: 'b2', name: 'Wave_sim CEO' },
  { kind: 'buddy', id: 'b3', name: 'Wave_sim' },
];

test('names resolve longest-first, exactly, and ambiguity is never guessed', () => {
  const out = resolveReferences('@wave_sim ceo and @Wave_sim, @Lead.', roster);
  assert.equal(out.body, '[@Wave_sim CEO](buddy:b2) and [@Wave_sim](buddy:b3), [@Lead](buddy:b1).');
  assert.deepEqual(
    out.mentioned.map((m) => m.id),
    ['b2', 'b3', 'b1']
  );
  const twins = resolveReferences('@Lead', [...roster, { kind: 'buddy', id: 'x', name: 'lead' }]);
  assert.equal(twins.body, '@Lead');
  assert.deepEqual(twins.ambiguous, ['@Lead']);
  assert.deepEqual(resolveReferences('@Leader @owner @"Lead"', roster).unresolved, ['@Leader']);
});

test('code, links and e-mail are never read', () => {
  const body = 'mail a@Lead.com `@Lead` ```\n@Lead\n``` [@Lead](https://x.test) ![@Lead](/a.png)';
  assert.equal(resolveReferences(body, roster).body, body);
  assert.deepEqual(mentionedIds('`[@Lead](buddy:b1)` and ```[@Lead](buddy:b1)```'), []);
});

test('tokens are trusted only for ids on the roster, and take the current name', () => {
  assert.equal(resolveReferences('[@Old name](buddy:b1) hi', roster).body, '[@Lead](buddy:b1) hi');
  // Fix-guard 2026-10-08: an unknown explicit id used to dissolve to `@Lead` and then resolve by NAME
  // to the local Lead, silently retargeting a removed/foreign Buddy. It now stays as written and is
  // reported as rejected; nobody is mentioned.
  const stranger = resolveReferences('[@Lead](buddy:elsewhere) and [@Ghost](buddy:g1)', roster);
  assert.equal(stranger.body, '[@Lead](buddy:elsewhere) and [@Ghost](buddy:g1)');
  assert.deepEqual(stranger.rejected, [
    { id: 'elsewhere', label: 'Lead' },
    { id: 'g1', label: 'Ghost' },
  ]);
  assert.deepEqual(stranger.mentioned, []);
  assert.deepEqual(resolveReferences(stranger.body, roster), stranger, 'a fixpoint');
  // Task tokens pass through untouched; their text is not read for names.
  assert.equal(resolveReferences('[@Lead task](task:t1)', roster).body, '[@Lead task](task:t1)');
});

// resolveReferences runs in the composer, again before send, and again on the server: it must be a fixpoint.
test('resolving an already-canonical body changes nothing', () => {
  const messy = 'x @Lead, [@Old](buddy:b2) `@Lead` [@Zed](buddy:q) @Wave_sim CEO\n@"Wave_sim"';
  const once = resolveReferences(messy, roster).body;
  assert.equal(resolveReferences(once, roster).body, once);
  assert.equal(
    bodyPieces(once)
      .map((p) => p.raw)
      .join(''),
    once
  );
});
