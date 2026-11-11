import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { keyed } from '@unleashd/shared';
import { type ProviderOf, canonicalise, withRules } from '../src/expedition-kernel/canonical';
import { expandHome, parseContract } from '../src/expedition-kernel/contract';
import { staticGate, typecheckGate } from '../src/expedition-kernel/gates';
import type { KernelDeps } from '../src/expedition-kernel/kernel';
import { preview } from '../src/expedition-kernel/launch';
import type { Authored, CastRow } from '../src/expedition-kernel/protocol';
import { dryRun } from '../src/expedition-kernel/runner';
import { tempDir } from './fixtures/temp';

const REPO = path.resolve(__dirname, '../..');
const EXAMPLES = path.join(REPO, 'docs/expeditions/keyed/v1/examples');
const GTM = path.join(EXAMPLES, '01-gtm.expedition.ts');
const GOOD = {
  goal: 'Do the thing.',
  leader: 'buddy:lead',
  repo: '~/git/x',
  budget: { usd: 10, hours: 2 },
  autoApply: { usd: 1 },
  pools: { claude: 2, codex: 1 },
  rules: ['be kind'],
  done: [{ check: './audit.sh' }],
};
const seat = (provider: string) => ({ t: 'seat' as const, provider, model: 'm', effort: 'high' });
const providerOf: ProviderOf = (who) =>
  who.t === 'buddy' && who.id === 'lead'
    ? { t: 'known', provider: 'claude' }
    : { t: 'unknown', why: 'no such buddy' };
function contract(raw: unknown = GOOD): keyed.Contract {
  const result = parseContract(raw);
  if (result.t !== 'ok') assert.fail(result.issues.join('; '));
  return result.contract;
}
function issuesOf(raw: unknown): string[] {
  const r = parseContract(raw);
  assert.equal(r.t, 'invalid');
  return r.t === 'invalid' ? r.issues : [];
}
const has = (issues: readonly string[], ...needles: string[]) =>
  assert.ok(
    issues.some((s) => needles.every((n) => s.includes(n))),
    issues.join('; ')
  );

test('the real GTM file sends its owner contract before its calls', async () => {
  const dry = await dryRun({ file: GTM, known: () => undefined, reviewed: () => false });
  const c = contract(dry.contract);
  assert.deepEqual(
    c.done.map((d) => d.t),
    ['check', 'review', 'owner']
  );
  assert.equal(c.done[1]?.t === 'review' && c.done[1].by.provider, 'codex');
  assert.deepEqual(c.pools, { claude: 6, codex: 1 });
  assert.deepEqual(c.budget, { usd: 60, hours: 8 });
  assert.deepEqual(c.autoApply, { usd: 10 });
  assert.equal(c.repo, '~/git/wave_sim');
  assert.equal(c.rules.length, 4);
  assert.ok(c.goal.startsWith('Follow the raw evidence'));
  assert.ok(c.goal.includes('a buyer test I can run myself'));
  assert.ok(!c.goal.includes('Not yet real'));
});
test('expandHome only touches a leading ~/', () => {
  assert.equal(expandHome('~/git/x', '/h'), '/h/git/x');
  assert.equal(expandHome('/a/~/b', '/h'), '/a/~/b');
  assert.equal(expandHome('~other/x', '/h'), '~other/x');
});
test('invalid literals name all bad fields; unknown and ambiguous criteria are refused', () => {
  has(issuesOf({ ...GOOD, goal: '', leader: '', pools: { codex: 0.5 } }), 'goal');
  has(issuesOf({ ...GOOD, extra: true }), 'Unrecognized');
  has(issuesOf({ ...GOOD, done: [{ check: 'a', owner: 'b' }] }), 'done');
  has(issuesOf({ ...GOOD, done: [{ review: { rubric: 'r', by: 'codex/m/h' } }] }), 'done');
  const issues = issuesOf({ ...GOOD, goal: '', leader: '', pools: { codex: 0.5 } });
  for (const field of ['goal', 'leader', 'pools.codex']) has(issues, field);
  assert.deepEqual(contract().done, [{ t: 'check', command: './audit.sh' }]);
});
test('contracts must be plain JSON data, with no lossy serialization or code', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const bad of [
    undefined,
    () => 1,
    Symbol('x'),
    NaN,
    Infinity,
    1n,
    new Date(),
    cyclic,
    { toJSON: () => GOOD },
    Object.defineProperty({}, 'goal', { get: () => 'g', enumerable: true }),
    { [Symbol('x')]: 'hidden' },
    Array(2),
  ]) {
    assert.equal(parseContract({ ...GOOD, extra: bad }).t, 'invalid');
  }
});
test('caps default from the budget once, and owner-supplied caps are marked given', () => {
  assert.deepEqual(contract().leaderWake, { t: 'defaulted', usd: 1, minutes: 12 });
  assert.deepEqual(contract().doneReview, contract().leaderWake);
  const budget = (usd: number) => contract({ ...GOOD, budget: { usd, hours: 1 } });
  assert.deepEqual(budget(3).leaderWake, { t: 'defaulted', usd: 0.3, minutes: 6 });
  assert.equal(budget(1).leaderWake.usd, 0.25);
  assert.equal(budget(0.2).leaderWake.usd, 0.2);
  const c = contract({
    ...GOOD,
    leaderWake: { usd: 0.4, minutes: 3 },
    doneReview: { usd: 1.5, minutes: 9 },
  });
  assert.deepEqual(c.leaderWake, { t: 'given', usd: 0.4, minutes: 3 });
  assert.deepEqual(c.doneReview, { t: 'given', usd: 1.5, minutes: 9 });
  has(issuesOf({ ...GOOD, leaderWake: { usd: 0 } }), 'leaderWake');
});
test('an older launched entry retains the caps it ran under', () => {
  const launched = keyed.Entry.parse({
    t: 'launched',
    at: '2026-11-11T00:00:00.000Z',
    id: 'x',
    baseSha: 'abc',
    contract: { ...contract(), leaderWake: undefined, doneReview: undefined },
  });
  assert.equal(launched.t === 'launched' && launched.contract.leaderWake.usd, 2);
});
const agent = (
  over: Partial<Extract<Authored, { t: 'agent' }>> = {}
): Extract<Authored, { t: 'agent' }> => ({
  t: 'agent',
  key: 'collect/a',
  step: 's',
  brief: 'Do a',
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
test('canonical calls include rendered prose and rules once, with provider pool first', () => {
  const r = canonicalise(agent({ judge: { t: 'check', command: 'chk a' } }), {
    contract: contract(),
    providerOf,
  });
  assert.equal(r.t, 'ok');
  if (r.t !== 'ok' || r.call.t !== 'agent') return;
  assert.deepEqual(r.call.pools, ['claude', 'codex']);
  assert.deepEqual(r.call.judge, { t: 'check', command: 'chk a' });
  assert.equal(r.call.brief, withRules('Do a', ['be kind']));
  assert.equal(r.call.brief.split('Rules from the contract').length, 2);
  assert.equal(keyed.Call.safeParse(r.call).success, true);
  assert.equal(
    canonicalise(agent({ by: { t: 'buddy', id: 'ghost' } }), { contract: contract(), providerOf })
      .t,
    'invalid'
  );
  assert.equal(
    canonicalise(agent({ by: { t: 'buddy', id: 'lead' } }), { contract: contract(), providerOf }).t,
    'ok'
  );
  const reviewed = canonicalise(
    agent({ judge: { t: 'review', rubric: 'Pass if sourced.', by: seat('codex') } }),
    { contract: contract(), providerOf }
  );
  assert.equal(
    reviewed.t === 'ok' &&
      reviewed.call.t === 'agent' &&
      reviewed.call.judge.t === 'review' &&
      reviewed.call.judge.brief,
    withRules('Pass if sourced.', ['be kind'])
  );
});
test('rendered commands and asks canonicalise without file reads', () => {
  const cmd: Authored = {
    t: 'command',
    key: 'c/1',
    step: 'run',
    command: 'go 7',
    on: { t: 'launch' },
    output: null,
    needs: ['codex'],
    maxMinutes: 3,
  };
  const ctx = { contract: contract(), providerOf };
  const r = canonicalise(cmd, ctx);
  assert.deepEqual(r.t === 'ok' && r.call.t === 'command' && [r.call.command, r.call.pools], [
    'go 7',
    ['codex'],
  ]);
  assert.equal(
    canonicalise({ t: 'ask', key: 'k', question: 'ok?', answer: 'confirm' }, ctx).t,
    'ok'
  );
});
const gateOpts = {
  zodEntry: path.join(REPO, 'server/node_modules/zod'),
  tscBin: path.join(REPO, 'server/node_modules/.bin/tsc'),
};

// Fix-guard: eight design cases had no launchable example. The real preview gates below
// keep future API changes from silently breaking the tool's copyable examples; no work executes.
test('every documented one-file example passes the real launch gates without executing work', async (t) => {
  const forbidden = (): never => assert.fail('preview must never execute work or ask an owner');
  // Example Buddy slugs are placeholders, not live-store lookups. Before launch the owner
  // substitutes actual ids; these explicit provider assumptions also appear in the headers.
  const buddies = new Map([
    ['market-research', 'claude'],
    ['game-design', 'claude'],
    ['wave-simulation-lead', 'claude'],
    ['simulation-research', 'claude'],
    ['product-dev', 'claude'],
    ['document-model-lead', 'claude'],
  ]);
  const deps: KernelDeps = {
    gates: gateOpts,
    providerOf: (who) => {
      const provider = who.t === 'buddy' ? buddies.get(who.id) : undefined;
      return provider === undefined
        ? { t: 'unknown', why: 'No declared example Buddy provider' }
        : { t: 'known', provider };
    },
    executor: {
      start: forbidden,
      cancel: forbidden,
      close: forbidden,
      status: forbidden,
      onSettled: forbidden,
    },
    leader: { wake: forbidden, dispose: forbidden },
    owner: { approve: forbidden },
    clock: { now: forbidden, wakeAt: forbidden },
  };
  const files = readdirSync(EXAMPLES)
    .filter((name) => name.endsWith('.expedition.ts'))
    .sort();
  assert.equal(files.length, 10, 'nine cases plus the GTM rewrite; never silently skip a case');
  for (const file of files) {
    await t.test(file, async () => {
      const result = await preview(deps, path.join(EXAMPLES, file));
      assert.equal(result.t, 'clean', JSON.stringify(result));
      if (result.t === 'clean') assert.ok(result.asked.length > 0, 'a real first wave is declared');
      assert.deepEqual(
        await typecheckGate(path.join(EXAMPLES, file), {
          ...gateOpts,
          tscBin: path.join(REPO, 'node_modules/.bin/tsrs'),
        }),
        { t: 'ok' }
      );
    });
  }
});
function planFile(edit: (s: string) => string = (s) => s): string {
  const file = path.join(tempDir('expedition-plan-'), 'test.expedition.ts');
  writeFileSync(file, edit(readFileSync(GTM, 'utf8')));
  return file;
}
test('the gate typechecks only the real file against the authoring API and writes nothing beside it', async () => {
  const file = planFile();
  assert.deepEqual(await typecheckGate(file, gateOpts), { t: 'ok' });
  assert.deepEqual(readdirSync(path.dirname(file)), ['test.expedition.ts']);
});
const TYPED_PLAN = `import {expedition,step} from 'expedition';
import {z} from 'zod';
const Org=z.object({id:z.string(),name:z.string()});
export default expedition({
 contract:{goal:'Probe',leader:'buddy:lead',repo:'/tmp/x',budget:{usd:5,hours:1},rules:[],done:[{owner:'Accept?'}]},
 agents:{scout:'claude:claude-sonnet-5-5:medium'},
 steps:{scope:{by:'scout',brief:'Scope',returns:z.array(Org)},collect:step({by:'scout',item:Org,brief:org=>org.name,returns:z.number(),judge:{check:org=>'echo '+org.id}})},
 plan:async({scope,collect})=>{
   const orgs=await scope();
   const org=orgs.out[0]!;
   const found=await collect(org);
   found.out.toFixed();
   return found;
 }
});`;
const compilerBins = [gateOpts.tscBin, path.join(REPO, 'node_modules/.bin/tsrs')];
function typedFile(source: string): string {
  const file = path.join(tempDir('typed-plan-'), 'plan.expedition.ts');
  writeFileSync(file, source);
  return file;
}
test('both checkers infer schema outputs, callback items and agent names without any', async () => {
  for (const tscBin of compilerBins) {
    assert.deepEqual(await typecheckGate(typedFile(TYPED_PLAN), { ...gateOpts, tscBin }), {
      t: 'ok',
    });
    // The expected-error directives would become TS2578 if returns or callback items decayed to any.
    const guarded = TYPED_PLAN.replace(
      'found.out.toFixed();',
      `found.out.toFixed();
   // @ts-expect-error a number has no invented output field
   found.out.invented;
   // @ts-expect-error item name remains a string
   org.name.toFixed();`
    );
    assert.deepEqual(await typecheckGate(typedFile(guarded), { ...gateOpts, tscBin }), { t: 'ok' });
    for (const [from, to, issue] of [
      ['await scope()', 'await scope.try()', 'out'],
      ['collect(org)', 'collect()', 'argument'],
      ['collect(org)', 'collect({id:7,name:"x"})', 'number'],
      ['collect(org)', 'collect(org, 7)', 'StepInput'],
      ['scope()', 'scope({item:{id:"x"}})', 'item'],
      ["by:'scout',brief:'Scope'", "by:'scuot',brief:'Scope'", 'TS2322'],
      ['org=>org.name', 'org=>org.missing', 'missing'],
      ['found.out.toFixed()', 'found.out.toUpperCase()', 'toUpperCase'],
    ]) {
      const r = await typecheckGate(typedFile(TYPED_PLAN.replace(from!, to!)), {
        ...gateOpts,
        tscBin,
      });
      assert.equal(r.t, 'failed', `${tscBin}: ${from} -> ${to}`);
      if (r.t === 'failed') has(r.errors, issue!);
    }
  }
  assert.equal(
    (await typecheckGate(planFile(), { ...gateOpts, tscBin: '/nonexistent/tsc' })).t,
    'failed'
  );
});
test('static checks cover every cast step, even beyond the first wave, and retain per-step access', () => {
  const judge = { t: 'review' as const, rubric: 'Pass if sourced.', by: seat('codex') };
  const cast: CastRow[] = [
    {
      t: 'agent',
      step: 'later',
      by: seat('claude'),
      tree: 'checkout',
      grant: { reads: [], web: false },
      judge,
      hasBrief: true,
      caps: { usd: { t: 'step', value: 1 }, minutes: { t: 'step', value: 5 } },
      needs: [],
    },
  ];
  const run = (rows: CastRow[], calls: Authored[] = [agent()]) =>
    staticGate({ contract: contract(), cast: rows, calls, providerOf });
  const ok = run(cast);
  assert.equal(ok.t, 'ok');
  assert.deepEqual(
    ok.t === 'ok' && ok.access.filter((a) => a.from === 'cast-table').map((a) => [a.label, a.turn]),
    [
      ['later', 'checkout'],
      ['later', 'judge'],
    ]
  );
  const bad = (rows: CastRow[], calls?: Authored[]) => {
    const r = run(rows, calls);
    assert.equal(r.t, 'failed');
    return r.t === 'failed' ? r.issues : [];
  };
  const row = cast[0]!;
  if (row.t !== 'agent') return;
  has(bad([{ ...row, hasBrief: false }]), 'later', 'no brief');
  has(bad([{ ...row, judge: { ...judge, by: seat('claude') } }]), 'later', 'reviewer', 'producer');
  has(bad([{ ...row, needs: ['gpu'] }]), "pool 'gpu'");
  has(bad([], [agent({ judge: { ...judge, by: seat('claude') } })]), 'reviewer', 'producer');
  has(bad([], [agent({ by: { t: 'buddy', id: 'ghost' }, judge })]), 'producer provider unknown');
  has(bad([], [agent({ needs: ['gpu'] })]), "pool 'gpu'");
  has(bad([], [agent(), agent()]), 'more than once');
  has(bad([], [agent({ max: { usd: -1, minutes: 1 } })]), 'max.usd');
});
