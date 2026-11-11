import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { keyed } from '@unleashd/shared';
import { renderBrief, renderCommand } from '../src/expedition-kernel/brief';
import { type ProviderOf, canonicalise } from '../src/expedition-kernel/canonical';
import { expandHome, parseContract } from '../src/expedition-kernel/contract';
import { staticGate, typecheckGate } from '../src/expedition-kernel/gates';
import type { Authored } from '../src/expedition-kernel/protocol';
import { tempDir } from './fixtures/temp';

const REPO = path.resolve(__dirname, '../..');
const V1 = path.join(REPO, 'docs/expeditions/keyed/v1');
const GTM = path.join(V1, 'gtm');

const GOOD = `---
leader: lead
repo: ~/git/x
budget: { usd: 10, hours: 2 }
autoApply: { usd: 1 }
pools: { claude: 2, codex: 1 }
rules: [be kind]
done:
  - check: ./audit.sh
---

# Goal

Do the thing.
`;

const issuesOf = (md: string): string[] => {
  const r = parseContract(md);
  assert.equal(r.t, 'invalid');
  return r.t === 'invalid' ? r.issues : [];
};
const has = (issues: string[], ...needles: string[]) =>
  assert.ok(
    issues.some((i) => needles.every((n) => i.includes(n))),
    `no issue with ${needles}: ${issues.join(' | ')}`
  );

test('the real GTM contract parses to the expected Contract', () => {
  const r = parseContract(readFileSync(path.join(GTM, 'contract.md'), 'utf8'));
  assert.equal(r.t, 'ok');
  if (r.t !== 'ok') return;
  const c = r.contract;
  assert.deepEqual(
    c.done.map((d) => d.t),
    ['check', 'review', 'owner']
  );
  const review = c.done[1];
  assert.deepEqual(review?.t === 'review' && review.by, {
    t: 'seat',
    provider: 'gemini',
    model: 'gemini-3.1-pro-preview',
    effort: 'high',
  });
  assert.deepEqual(c.pools, { claude: 6, codex: 1, gemini: 2 });
  assert.deepEqual(c.budget, { usd: 60, hours: 8 });
  assert.deepEqual(c.autoApply, { usd: 10 });
  assert.equal(c.repo, '~/git/wave_sim');
  assert.equal(c.rules.length, 4);
  assert.ok(c.goal.startsWith('Follow the raw evidence'));
  assert.ok(c.goal.includes('a buyer test I can run myself'));
  assert.ok(!c.goal.includes('Not yet real'));
  assert.ok(!c.goal.includes('audit_ledger'));
});

test('expandHome only touches a leading ~/', () => {
  assert.equal(expandHome('~/git/x', '/h'), '/h/git/x');
  assert.equal(expandHome('/a/~/b', '/h'), '/a/~/b');
  assert.equal(expandHome('~other/x', '/h'), '~other/x');
});

test('invalid contracts name the field', () => {
  has(issuesOf(GOOD.replace('# Goal', '# Aim')), 'goal');
  has(issuesOf(GOOD.replace('Do the thing.', '')), 'goal', 'empty');
  has(issuesOf(GOOD.replace('done:', 'dones:')), 'dones', 'unknown key');
  has(
    issuesOf(GOOD.replace('- check: ./audit.sh', '- { check: a, owner: b }')),
    'done[0]',
    'exactly one'
  );
  const review = (by: string) =>
    GOOD.replace('- check: ./audit.sh', `- review: { rubric: r, by: '${by}' }`);
  has(issuesOf(review('gemini/pro')), 'done[0].review.by', 'three');
  has(issuesOf(review('a//c')), 'done[0].review.by');
  has(issuesOf(GOOD.replace('codex: 1', 'codex: 1.5')), 'pools.codex');
  has(issuesOf(GOOD.replace('leader: lead\n', '')), 'leader');
  has(issuesOf(GOOD.replace(/^---\n/, '')), 'frontmatter');
});

test('every problem is reported together, once', () => {
  const issues = issuesOf(
    GOOD.replace('# Goal', '# Aim')
      .replace('done:', 'dones:')
      .replace('codex: 1', 'codex: 0.5')
      .replace('leader: lead\n', '')
  );
  has(issues, 'goal');
  has(issues, 'dones');
  has(issues, 'done:');
  has(issues, 'pools.codex');
  has(issues, 'leader');
  assert.equal(issues.filter((i) => i.startsWith('goal')).length, 1);
});

test('a valid contract passes through parse unchanged', () => {
  const r = parseContract(GOOD);
  assert.deepEqual(r.t === 'ok' && r.contract.done, [{ t: 'check', command: './audit.sh' }]);
});

// ---- briefs ----
function folderWith(briefs: Record<string, string>): string {
  const folder = tempDir('expedition-folder-');
  mkdirSync(path.join(folder, 'briefs'));
  for (const [name, body] of Object.entries(briefs))
    writeFileSync(path.join(folder, 'briefs', `${name}.md`), body);
  return folder;
}

test('renderBrief fills slots and appends the rules once', () => {
  const folder = folderWith({ s: 'Study {{name}} ({{ n }}) for {{name}}.\n' });
  const r = renderBrief(folder, 's', { name: 'Acme', n: 3 }, ['r1', 'r2']);
  assert.equal(r.t, 'ok');
  const text = r.t === 'ok' ? r.text : '';
  assert.ok(text.startsWith('Study Acme (3) for Acme.'));
  assert.equal(text.split('Rules from the contract').length, 2);
  assert.ok(text.includes('- r1\n- r2'));
});

test('renderBrief reports, never blanks', () => {
  const folder = folderWith({ s: 'Hi {{who}} {{obj}}' });
  const slot = renderBrief(folder, 's', { obj: { a: 1 } }, []);
  assert.equal(slot.t, 'invalid');
  if (slot.t === 'invalid') {
    has(slot.issues, 'briefs/s.md', '{{who}}');
    has(slot.issues, '{{obj}}', 'object');
  }
  const missing = renderBrief(folder, 'nope', {}, []);
  assert.deepEqual(missing, { t: 'invalid', issues: ['brief briefs/nope.md not found'] });
  writeFileSync(path.join(folder, 'secret.md'), 'x');
  for (const name of ['../secret', 'a/b', '..', ''])
    assert.equal(renderBrief(folder, name, {}, []).t, 'invalid');
});

test('a slot value that looks like a slot is not expanded again', () => {
  const r = renderCommand('echo {{a}}', { a: '{{b}}', b: 'x' });
  assert.deepEqual(r, { t: 'ok', text: 'echo {{b}}' });
});

// ---- canonicalise ----
const contract = (): keyed.Contract => {
  const r = parseContract(GOOD);
  assert.equal(r.t, 'ok');
  return (r as { contract: keyed.Contract }).contract;
};
const providerOf: ProviderOf = (who) =>
  who.t === 'buddy' && who.id === 'lead'
    ? { t: 'known', provider: 'claude' }
    : { t: 'unknown', why: `no such buddy ${who.t === 'buddy' ? who.id : ''}` };
const seat = (provider: string) => ({ t: 'seat' as const, provider, model: 'm', effort: 'high' });
const agent = (over: Partial<Extract<Authored, { t: 'agent' }>> = {}): Authored => ({
  t: 'agent',
  key: 'collect/a',
  step: 's',
  item: { id: 'a' },
  by: seat('claude'),
  inputs: [],
  output: {},
  tree: 'none',
  base: { t: 'launch' },
  grant: { reads: [], web: false },
  context: { t: 'cold' },
  needs: ['codex'],
  max: { usd: 1, minutes: 5 },
  judge: { t: 'none' },
  ...over,
});

test('canonicalise puts the provider pool before needs and yields a valid Call', () => {
  const folder = folderWith({ s: 'Do {{id}}' });
  const r = canonicalise(agent({ judge: { t: 'check', command: 'chk {{id}}' } }), {
    contract: contract(),
    folder,
    providerOf,
  });
  assert.equal(r.t, 'ok');
  if (r.t !== 'ok' || r.call.t !== 'agent') return;
  assert.deepEqual(r.call.pools, ['claude', 'codex']);
  assert.deepEqual(r.call.judge, { t: 'check', command: 'chk a' });
  assert.ok(r.call.brief.includes('Do a') && r.call.brief.includes('be kind'));
  assert.equal(keyed.Call.safeParse(r.call).success, true);
});

test('a buddy whose provider is unknown is an issue', () => {
  const folder = folderWith({ s: 'x' });
  const r = canonicalise(agent({ by: { t: 'buddy', id: 'ghost' } }), {
    contract: contract(),
    folder,
    providerOf,
  });
  assert.equal(r.t, 'invalid');
  if (r.t === 'invalid') has(r.issues, 'ghost');
  const ok = canonicalise(agent({ by: { t: 'buddy', id: 'lead' } }), {
    contract: contract(),
    folder,
    providerOf,
  });
  assert.deepEqual(ok.t === 'ok' && ok.call.t === 'agent' && ok.call.pools, ['claude', 'codex']);
});

test('command and ask canonicalise', () => {
  const folder = folderWith({});
  const cmd: Authored = {
    t: 'command',
    key: 'c/1',
    step: 'run',
    command: 'go {{id}}',
    item: { id: 7 },
    on: { t: 'launch' },
    output: null,
    needs: ['codex'],
    maxMinutes: 3,
  };
  const r = canonicalise(cmd, { contract: contract(), folder, providerOf });
  assert.deepEqual(r.t === 'ok' && r.call.t === 'command' && [r.call.command, r.call.pools], [
    'go 7',
    ['codex'],
  ]);
  const bad = canonicalise({ ...cmd, item: {} }, { contract: contract(), folder, providerOf });
  assert.equal(bad.t, 'invalid');
  const ask = canonicalise(
    { t: 'ask', key: 'k', question: 'ok?', answer: 'confirm' },
    { contract: contract(), folder, providerOf }
  );
  assert.equal(ask.t, 'ok');
});

// ---- typecheck gate ----
const TSC = path.join(REPO, 'server/node_modules/.bin/tsc');
const gateOpts = {
  zodEntry: path.join(REPO, 'server/node_modules/zod'),
  tscBin: TSC,
};
function planFolder(edit: (src: string) => string = (s) => s): string {
  const folder = tempDir('expedition-plan-');
  const src = readFileSync(path.join(GTM, 'plan.ts'), 'utf8').replace(
    "'../expedition'",
    "'expedition'"
  );
  writeFileSync(path.join(folder, 'plan.ts'), edit(src));
  return folder;
}

test('typecheckGate passes the real GTM plan and writes nothing into the folder', async () => {
  const folder = planFolder();
  assert.deepEqual(await typecheckGate(folder, gateOpts), { t: 'ok' });
  assert.deepEqual(require('node:fs').readdirSync(folder), ['plan.ts']);
});

test('typecheckGate fails readably on a type error and on an unknown step', async () => {
  const narrowing = planFolder((s) =>
    s.replace(
      "need(await x.phase('scope', () => scope()), 'No list of organizations.')",
      "(await x.phase('scope', () => scope())).out"
    )
  );
  const a = await typecheckGate(narrowing, gateOpts);
  assert.equal(a.t, 'failed');
  if (a.t === 'failed') has(a.errors, path.join(narrowing, 'plan.ts'), 'TS2339');

  const unknownStep = planFolder((s) => s.replace('await attack({', 'await attak({'));
  const b = await typecheckGate(unknownStep, gateOpts);
  assert.equal(b.t, 'failed');
  if (b.t === 'failed') has(b.errors, 'attak');
});

test('typecheckGate reports a missing tsc as a failure, not a throw', async () => {
  const r = await typecheckGate(planFolder(), { ...gateOpts, tscBin: '/nonexistent/tsc' });
  assert.equal(r.t, 'failed');
});

// ---- static gate ----
test('staticGate: clean calls pass; each defect is its own issue', () => {
  const c: keyed.Contract = {
    ...contract(),
    pools: { claude: 2, codex: 1, gemini: 1 },
    done: [
      {
        t: 'review',
        rubric: 'rub',
        by: { t: 'seat', provider: 'gemini', model: 'm', effort: 'h' },
      },
    ],
  };
  const folder = folderWith({ s: 'x', rub: 'r' });
  const judged = { t: 'review' as const, rubric: 'rub', by: seat('gemini') };
  const clean = [agent({ judge: judged }), agent({ key: 'collect/b' })];
  const ok = staticGate({ contract: c, folder, calls: clean, providerOf });
  assert.equal(ok.t, 'ok');
  // Every turn the plan and contract would run, with its limits on its harness (access.ts):
  // claude enforces them all here; gemini has no mapping, so a gemini judge is told, not held.
  const held = (a: keyed.TurnAccess) =>
    a.harness.t === 'known'
      ? `${a.harness.provider}:${Object.values(a.harness.grants).every((g) => g.t === 'enforced') ? 'enforced' : 'advisory'}`
      : 'unknown';
  assert.deepEqual(ok.t === 'ok' ? ok.access.map((a) => [a.label, a.turn, held(a)]) : [], [
    ['collect/a', 'call', 'claude:enforced'],
    ['collect/a', 'judge', 'gemini:advisory'],
    ['collect/b', 'call', 'claude:enforced'],
    ['leader', 'leader', 'claude:enforced'],
    ['done/0', 'judge', 'gemini:advisory'],
  ]);

  const run = (calls: Authored[], contract: keyed.Contract = c, dir = folder) => {
    const r = staticGate({ contract, folder: dir, calls, providerOf });
    assert.equal(r.t, 'failed');
    return r.t === 'failed' ? r.issues : [];
  };
  has(run([agent({ step: 'nostep' })]), 'collect/a', 'briefs/nostep.md', 'not found');
  has(run([agent({ judge: { ...judged, rubric: 'norub' } })]), 'rubric', 'briefs/norub.md');
  has(run([agent({ judge: { ...judged, by: seat('claude') } })]), 'reviewer', 'producer', 'claude');
  has(
    run([agent({ by: { t: 'buddy', id: 'ghost' }, judge: judged })]),
    'producer provider unknown'
  );
  has(run([agent({ needs: ['gpu'] })]), "pool 'gpu'");
  has(run([agent(), agent()]), 'collect/a', 'more than once');
  has(run([agent()], c, folderWith({ s: 'x' })), 'contract done', 'briefs/rub.md');
  has(run([agent()], c, folderWith({ s: '{{missing}}', rub: 'r' })), 'collect/a', '{{missing}}');
});

test('a contract without wake and review caps gets the budget rule, marked defaulted; given caps are marked given', () => {
  const ok = (md: string) => {
    const r = parseContract(md);
    assert.equal(r.t, 'ok');
    return r.t === 'ok' ? r.contract : assert.fail('invalid');
  };
  // $10: 10% is $1.00 (the ceiling); 2 h: 10% is 12 min.
  const plain = ok(GOOD);
  assert.deepEqual(plain.leaderWake, { t: 'defaulted', usd: 1, minutes: 12 });
  assert.deepEqual(plain.doneReview, plain.leaderWake);
  // $3 (the 2026-11-11 run): 10% is $0.30, so a wake no longer holds $2 of it.
  const small = ok(GOOD.replace('usd: 10, hours: 2', 'usd: 3, hours: 1'));
  assert.deepEqual(small.leaderWake, { t: 'defaulted', usd: 0.3, minutes: 6 });
  // The floor, but never more than the budget allows.
  assert.equal(ok(GOOD.replace('usd: 10, hours: 2', 'usd: 1, hours: 1')).leaderWake.usd, 0.25);
  assert.equal(ok(GOOD.replace('usd: 10, hours: 2', 'usd: 0.2, hours: 1')).leaderWake.usd, 0.2);
  const given = ok(
    GOOD.replace(
      'rules:',
      'leaderWake: { usd: 0.4, minutes: 3 }\ndoneReview: { usd: 1.5, minutes: 9 }\nrules:'
    )
  );
  assert.deepEqual(given.leaderWake, { t: 'given', usd: 0.4, minutes: 3 });
  assert.deepEqual(given.doneReview, { t: 'given', usd: 1.5, minutes: 9 });
  has(issuesOf(GOOD.replace('rules:', 'leaderWake: { usd: 0 }\nrules:')), 'leaderWake');
});

test('a launched entry written before the caps existed still parses, at the $2 / 20 min it ran under', () => {
  const launched = keyed.Entry.parse({
    t: 'launched',
    at: '2026-11-11T00:00:00.000Z',
    id: 'x',
    baseSha: 'abc',
    contract: {
      goal: 'g',
      done: [{ t: 'owner', question: 'q' }],
      budget: { usd: 3, hours: 1 },
      pools: {},
      rules: [],
      leader: 'lead',
      repo: '/r',
      autoApply: { usd: 0 },
    },
  });
  assert.equal(launched.t === 'launched' && launched.contract.leaderWake.usd, 2);
  assert.equal(launched.t === 'launched' && launched.contract.leaderWake.t, 'defaulted');
});
