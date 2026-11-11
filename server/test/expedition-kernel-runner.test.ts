import assert from 'node:assert/strict';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { keyed } from '@unleashd/shared';
import { z } from 'zod';
import { zodToJsonSchema as zodToJsonSchemaTyped } from 'zod-to-json-schema';
import { parseContract } from '../src/expedition-kernel/contract';
import { turnAccessOf } from '../src/expedition-kernel/gates';
import type { Authored } from '../src/expedition-kernel/protocol';
import { type DryRunResult, dryRun, runPlan } from '../src/expedition-kernel/runner';
import { tempDir } from './fixtures/temp';

// Untyped on purpose: the typed signature made tsc run out of memory (see authoring/index.ts).
const zodToJsonSchema = zodToJsonSchemaTyped as unknown as (schema: unknown) => unknown;

// The plan runner end to end: real child processes running real plan folders under the sandbox.
// Plans are copied to a temp dir first (plans live outside the repo) unless a test says otherwise.

const FIXTURES = path.join(__dirname, 'fixtures', 'expedition-plans');
function copyPlan(name: string): { file: string; root: string } {
  const root = tempDir('expedition-plan-');
  const file = path.join(root, `${path.basename(name)}.expedition.ts`);
  cpSync(path.join(FIXTURES, `${name}.expedition.ts`), file, { recursive: true });
  return { file, root };
}

const ref = (key: string) => keyed.refOf(key, 'h0');
const REPORT = { summary: 'done', files: [] };
const passedReport = (key: string): keyed.Outcome => ({ t: 'passed', ref: ref(key), out: REPORT });

// ---- the GTM case (docs/expeditions/keyed/v1/gtm) ----
const Org = z.object({
  id: z.string(),
  name: z.string(),
  segment: z.enum(['rl-data', 'design-partner']),
  kind: z.enum(['direct', 'substitute', 'comparator']),
});
const ORGS = [
  { id: 'taskus', name: 'TaskUs', segment: 'rl-data', kind: 'direct' },
  { id: 'psi', name: 'PSI', segment: 'design-partner', kind: 'substitute' },
  { id: 'appen', name: 'Appen', segment: 'rl-data', kind: 'comparator' },
  { id: 'labelbox', name: 'Labelbox', segment: 'rl-data', kind: 'comparator' },
];
/** The host's log for version 0: one collect fails its anchor check, and round 2's attack finds
 * no real counterexample, so round 2 has no revise. */
function gtmLog(call: Authored): keyed.Outcome {
  if (call.key === 'scope/scope') return { t: 'passed', ref: ref(call.key), out: ORGS };
  if (call.key === 'collect/collect/labelbox')
    return { t: 'failed', ref: ref(call.key), out: REPORT, why: 'quotes not found in page' };
  if (call.key === 'duel/attack/2')
    return { t: 'failed', ref: ref(call.key), out: REPORT, why: 'not new' };
  return passedReport(call.key);
}
const COVERAGE = 'Is the coverage enough to argue from, or is a kind of source missing?';
const HELD = 'Did the thesis hold, bend or die? Stopping with "no thesis" is a valid result.';

const runGtm = (file: string) => dryRun({ file, known: gtmLog, reviewed: () => true });
const callOf = (result: DryRunResult, key: string) => {
  const call = result.calls.find((c) => c.key === key);
  assert.ok(call, `no call ${key}`);
  return call;
};

test('a dry run of the GTM plan with nothing known asks for scope only and waits', async () => {
  // In place (inside server/, a CommonJS package scope); the other runs use copies outside the repo.
  const result = await dryRun({
    file: path.join(FIXTURES, 'gtm.expedition.ts'),
    known: () => undefined,
    reviewed: () => false,
  });
  assert.deepEqual(
    result.calls.map((c) => c.key),
    ['scope/scope']
  );
  const scope = result.calls[0];
  assert.equal(scope.t, 'agent');
  assert.deepEqual(scope.t === 'agent' && scope.output, zodToJsonSchema(z.array(Org)));
  assert.deepEqual(result.end, { t: 'waiting', calls: ['scope/scope'], reviews: [] });

  // CONNECT_PLAN §10 (second real run): the preview reported limits only for the calls the dry run
  // reached, so the checkout calls behind the first wave were never previewed. The plan sends its
  // cast table before any call; every step is reported from it, the unreached `collect` and
  // `packet` checkouts and their judges included.
  const parsed = parseContract(result.contract);
  if (parsed.t !== 'ok') throw new Error(JSON.stringify(parsed));
  const access = turnAccessOf(parsed.contract, result.cast, [], () => ({
    t: 'known',
    provider: 'claude',
  }));
  assert.deepEqual(
    access.filter((a) => a.from === 'cast-table').map((a) => [a.label, a.turn]),
    [
      ['scope', 'call'],
      ['collect', 'checkout'],
      ['thesis', 'call'],
      ['thesis', 'judge'],
      ['attack', 'call'],
      ['attack', 'judge'],
      ['revise', 'call'],
      ['revise', 'judge'],
      ['packet', 'checkout'],
    ]
  );
});

test('scripted answers drive the GTM plan to its candidate, identically in a fresh process', async () => {
  const { file } = copyPlan('gtm');
  const first = await runGtm(file);

  assert.deepEqual(
    first.calls.map((c) => c.key),
    [
      'scope/scope',
      'collect/collect/taskus',
      'collect/collect/psi',
      'collect/collect/appen',
      'collect/collect/labelbox',
      'synthesize/thesis',
      'duel/attack/1',
      'duel/revise/1',
      'duel/attack/2',
      'duel/attack/3',
      'duel/revise/3',
      'packet/packet',
    ]
  );
  assert.deepEqual(first.reviews, [COVERAGE, HELD]);
  const edges = (name: string) => [
    { name, edge: 'open' },
    { name, edge: 'close' },
  ];
  assert.deepEqual(
    first.phases,
    ['scope', 'collect', 'synthesize', 'duel', 'packet'].flatMap(edges)
  );
  assert.deepEqual(first.end, { t: 'candidate', ref: ref('packet/packet') });

  // The thesis reads only the collects that passed; each revise continues the current thesis.
  const inputs = (key: string) => {
    const call = callOf(first, key);
    return call.t === 'agent' ? call.inputs : [];
  };
  const refs = (...keys: string[]) => keys.map((key) => ({ t: 'ref', ref: ref(key) }));
  assert.deepEqual(
    inputs('synthesize/thesis'),
    refs('collect/collect/taskus', 'collect/collect/psi', 'collect/collect/appen')
  );
  assert.deepEqual(inputs('duel/revise/1'), refs('synthesize/thesis', 'duel/attack/1'));
  const context = (key: string) => {
    const call = callOf(first, key);
    return call.t === 'agent' ? call.context : undefined;
  };
  assert.deepEqual(context('duel/attack/1'), { t: 'cold' });
  assert.deepEqual(context('duel/revise/1'), { t: 'continue', of: ref('synthesize/thesis') });
  assert.deepEqual(context('duel/revise/3'), { t: 'continue', of: ref('duel/revise/1') });

  // The host hashes authored calls to recognise finished work: a fresh process must author the
  // same bytes for the same answers.
  const second = await runGtm(file);
  assert.equal(JSON.stringify(second.calls), JSON.stringify(first.calls));
});

test("the rewrite re-issues version 0's calls for the orgs it still studies and adds only mine/*", async () => {
  const v0 = await runGtm(copyPlan('gtm').file);
  const authoredV0 = new Map(v0.calls.map((c) => [c.key, JSON.stringify(c)]));
  // Reconcile by key and hash: only a byte-identical call is answered from version 0's log.
  const sameAsV0 = (call: Authored) => authoredV0.get(call.key) === JSON.stringify(call);

  const v1 = await dryRun({
    file: copyPlan('gtm-rewrite').file,
    known: (call) => (sameAsV0(call) ? gtmLog(call) : undefined),
    reviewed: () => true,
  });

  const mine = [
    'mine/mine/rl-forums',
    'mine/mine/vendor-work',
    'mine/mine/cfd-forums',
    'mine/mine/naval-forums',
  ];
  assert.deepEqual(
    v1.calls.filter((c) => !sameAsV0(c)).map((c) => c.key),
    mine
  );
  assert.deepEqual(
    v1.calls.filter(sameAsV0).map((c) => c.key),
    ['scope/scope', 'collect/collect/taskus', 'collect/collect/psi']
  );
  const asked = new Set(v1.calls.map((c) => c.key));
  const v0BeforeReview = v0.calls.slice(0, 5).map((c) => c.key);
  assert.deepEqual(
    v0BeforeReview.filter((key) => !asked.has(key)),
    ['collect/collect/appen', 'collect/collect/labelbox']
  );
  assert.deepEqual(v1.end, { t: 'waiting', calls: mine, reviews: [] });
});

// ---- how a plan ends ----
test('need() on a failed result ends with a gap carrying its ref as evidence', async () => {
  const result = await dryRun({
    file: copyPlan('need-gap').file,
    known: (call) => ({ t: 'failed', ref: ref(call.key), out: REPORT, why: 'nothing there' }),
    reviewed: () => false,
  });
  assert.equal(result.end.t, 'gap');
  assert.equal(result.end.t === 'gap' && result.end.why, 'The probe found nothing.');
  assert.deepEqual(result.end.t === 'gap' && result.end.evidence[0], {
    t: 'ref',
    ref: ref('probe'),
  });
});

test('an exception in plan code ends with threw', async () => {
  const result = await dryRun({
    file: copyPlan('throws').file,
    known: () => undefined,
    reviewed: () => false,
  });
  assert.equal(result.end.t, 'threw');
  assert.match(result.end.t === 'threw' ? result.end.message : '', /boom from plan code/);
});

test('a key issued twice in one evaluation ends with threw naming the key', async () => {
  const result = await dryRun({
    file: copyPlan('duplicate').file,
    known: () => undefined,
    reviewed: () => false,
  });
  assert.equal(result.end.t, 'threw');
  assert.match(
    result.end.t === 'threw' ? result.end.message : '',
    /Duplicate key "twice\/probe\/same"/
  );
});

test("an answer that violates the step's schema reaches plan code as errored, never as a value", async () => {
  const seen = async (n: unknown) => {
    const result = await dryRun({
      file: copyPlan('schema').file,
      known: (call) =>
        call.key === 'count'
          ? { t: 'passed', ref: ref('count'), out: { n } }
          : { t: 'passed', ref: ref('echo'), out: { tail: '' } },
      reviewed: () => false,
    });
    assert.equal(result.end.t, 'candidate');
    const echo = callOf(result, 'echo');
    assert.notEqual(echo.t, 'ask');
    return echo.t === 'command'
      ? (JSON.parse(echo.command.slice('echo '.length)) as Record<string, unknown>)
      : {};
  };
  const bad = await seen('three');
  assert.equal(bad.t, 'errored');
  assert.match(String(bad.why), /count does not match its schema/);
  assert.deepEqual(await seen(3), { t: 'passed', n: 3 });
});

// 2026-11-11: nothing static catches a plan call left un-awaited (Biome cannot resolve the bare
// `expedition` import; tsc does not report floating promises). Returning while a call or review is
// still unanswered ends the plan as threw, naming what was pending. The phases test below proves
// that calls awaited through parallel and Promise.all still end as a candidate.
test('a plan that returns while calls it issued are unanswered ends with threw naming them', async () => {
  const result = await dryRun({
    file: copyPlan('unawaited').file,
    known: (call) => (call.key === 'probe/kept' ? passedReport(call.key) : undefined),
    reviewed: () => false,
  });
  assert.equal(result.end.t, 'threw');
  assert.equal(
    result.end.t === 'threw' ? result.end.message : '',
    'The plan returned while 2 calls were still pending: probe/forgotten, review "Was the forgotten probe any good?" (a call was not awaited).'
  );
});

test('concurrent calls inside parallel inside phases keep their own phase prefix', async () => {
  const result = await dryRun({
    file: copyPlan('phases').file,
    known: (call) => passedReport(call.key),
    reviewed: () => false,
  });
  assert.equal(result.end.t, 'candidate');
  assert.deepEqual(result.calls.map((c) => c.key).sort(), [
    'left/inner/probe/a',
    'left/inner/probe/b',
    'left/inner/probe/c',
    'left/probe/first',
    'right/probe/a',
    'right/probe/b',
    'right/probe/c',
    'right/probe/first',
  ]);
});

test('kill() during a pending call leaves no process behind', async () => {
  let waiting: (seqs: readonly number[]) => void = () => {};
  const quiet = new Promise<readonly number[]>((resolve) => {
    waiting = resolve;
  });
  let sawContract = false;
  const handle = runPlan({
    file: copyPlan('need-gap').file,
    onContract: () => {
      sawContract = true;
    },
    onCast: () => {
      assert.equal(sawContract, true);
    },
    onCall: () => {
      assert.equal(sawContract, true);
    },
    onReview: () => {},
    onPhase: () => {},
    onWaiting: (seqs) => waiting(seqs),
    onEnd: () => {},
  });
  const waitingOrEnd = await Promise.race([quiet, handle.ended]);
  assert.deepEqual(waitingOrEnd, [0]);
  await handle.kill();
  assert.deepEqual(await handle.ended, { t: 'killed' });
  assert.throws(() => process.kill(handle.pid, 0), { code: 'ESRCH' });
  assert.throws(() => process.kill(-handle.pid, 0), { code: 'ESRCH' });
});

test('the sandbox lets a plan read its own file and nothing else, write nothing, spawn nothing', async () => {
  const { file, root } = copyPlan('sandbox');
  const secret = path.join(root, 'secret.txt');
  writeFileSync(secret, 'outside the plan file');
  writeFileSync(
    file,
    readFileSync(file, 'utf8').replace(
      "readFileSync('secret.txt')",
      `readFileSync(${JSON.stringify(secret)})`
    )
  );
  const result = await dryRun({
    file,
    known: (call) => passedReport(call.key),
    reviewed: () => false,
  });
  assert.equal(result.end.t, 'candidate');
  const first = result.calls[0];
  assert.deepEqual(first.t === 'agent' ? JSON.parse(first.brief) : {}, {
    own: true,
    sibling: 'ERR_ACCESS_DENIED',
    etcHosts: 'ERR_ACCESS_DENIED',
    write: 'ERR_ACCESS_DENIED',
    spawn: 'ERR_ACCESS_DENIED',
  });
});

// Guard: the protocol must not silently stringify away owner data or execute extra imports.
test('non-JSON contracts and extra imports fail before any call', async () => {
  for (const [source, issue] of [
    [
      "import { expedition } from 'expedition'; export default expedition({ contract: { rules: [() => 'x'] } as never, plan: async () => { throw Error('should not run'); } });",
      /contract.rules.0.*plain JSON/,
    ],
    ["import 'node:fs'; export default {};", /may import only expedition and zod/],
  ] as const) {
    const file = path.join(tempDir('invalid-plan-'), 'bad.expedition.ts');
    writeFileSync(file, source);
    const dry = await dryRun({ file, known: () => undefined, reviewed: () => false });
    assert.deepEqual(dry.calls, []);
    assert.equal(dry.end.t, 'threw');
    assert.match(dry.end.t === 'threw' ? dry.end.message : '', issue);
  }
});
