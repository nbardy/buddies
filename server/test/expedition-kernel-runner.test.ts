import assert from 'node:assert/strict';
import { cpSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { z } from 'zod';
import { zodToJsonSchema as zodToJsonSchemaTyped } from 'zod-to-json-schema';
import type { Authored } from '../src/expedition-kernel/protocol';
import { type DryRunResult, dryRun, runPlan } from '../src/expedition-kernel/runner';
import { type Outcome, refOf } from '../src/expedition-kernel/types';
import { tempDir } from './fixtures/temp';

// Untyped on purpose: the typed signature made tsc run out of memory (see authoring/index.ts).
const zodToJsonSchema = zodToJsonSchemaTyped as unknown as (schema: unknown) => unknown;

// The plan runner end to end: real child processes running real plan folders under the sandbox.
// Plans are copied to a temp dir first (plans live outside the repo) unless a test says otherwise.

const FIXTURES = path.join(__dirname, 'fixtures', 'expedition-plans');
function copyPlan(name: string): { folder: string; root: string } {
  const root = tempDir('expedition-plan-');
  const folder = path.join(root, name);
  cpSync(path.join(FIXTURES, name), folder, { recursive: true });
  return { folder, root };
}

const ref = (key: string) => refOf(key, 'h0');
const REPORT = { summary: 'done', files: [] };
const passedReport = (key: string): Outcome => ({ t: 'passed', ref: ref(key), out: REPORT });

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
function gtmLog(call: Authored): Outcome {
  if (call.key === 'scope/scope') return { t: 'passed', ref: ref(call.key), out: ORGS };
  if (call.key === 'collect/collect/labelbox')
    return { t: 'failed', ref: ref(call.key), out: REPORT, why: 'quotes not found in page' };
  if (call.key === 'duel/attack/2')
    return { t: 'failed', ref: ref(call.key), out: REPORT, why: 'not new' };
  return passedReport(call.key);
}
const COVERAGE = 'Is the coverage enough to argue from, or is a kind of source missing?';
const HELD = 'Did the thesis hold, bend or die? Stopping with "no thesis" is a valid result.';

const runGtm = (folder: string) => dryRun({ folder, known: gtmLog, reviewed: () => true });
const callOf = (result: DryRunResult, key: string) => {
  const call = result.calls.find((c) => c.key === key);
  assert.ok(call, `no call ${key}`);
  return call;
};

test('a dry run of the GTM plan with nothing known asks for scope only and waits', async () => {
  // In place (inside server/, a CommonJS package scope); the other runs use copies outside the repo.
  const result = await dryRun({
    folder: path.join(FIXTURES, 'gtm'),
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
});

test('scripted answers drive the GTM plan to its candidate, identically in a fresh process', async () => {
  const { folder } = copyPlan('gtm');
  const first = await runGtm(folder);

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
  const second = await runGtm(folder);
  assert.equal(JSON.stringify(second.calls), JSON.stringify(first.calls));
});

test("the rewrite re-issues version 0's calls for the orgs it still studies and adds only mine/*", async () => {
  const v0 = await runGtm(copyPlan('gtm').folder);
  const authoredV0 = new Map(v0.calls.map((c) => [c.key, JSON.stringify(c)]));
  // Reconcile by key and hash: only a byte-identical call is answered from version 0's log.
  const sameAsV0 = (call: Authored) => authoredV0.get(call.key) === JSON.stringify(call);

  const v1 = await dryRun({
    folder: copyPlan('gtm-rewrite').folder,
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
    folder: copyPlan('need-gap').folder,
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
    folder: copyPlan('throws').folder,
    known: () => undefined,
    reviewed: () => false,
  });
  assert.equal(result.end.t, 'threw');
  assert.match(result.end.t === 'threw' ? result.end.message : '', /boom from plan code/);
});

test('a key issued twice in one evaluation ends with threw naming the key', async () => {
  const result = await dryRun({
    folder: copyPlan('duplicate').folder,
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
      folder: copyPlan('schema').folder,
      known: (call) =>
        call.key === 'count'
          ? { t: 'passed', ref: ref('count'), out: { n } }
          : { t: 'passed', ref: ref('echo'), out: { tail: '' } },
      reviewed: () => false,
    });
    assert.equal(result.end.t, 'candidate');
    const echo = callOf(result, 'echo');
    assert.notEqual(echo.t, 'ask');
    return echo.t === 'ask' ? {} : echo.item;
  };
  const bad = await seen('three');
  assert.equal(bad.t, 'errored');
  assert.match(String(bad.why), /count does not match its schema/);
  assert.deepEqual(await seen(3), { t: 'passed', n: 3 });
});

test('concurrent calls inside parallel inside phases keep their own phase prefix', async () => {
  const result = await dryRun({
    folder: copyPlan('phases').folder,
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
  const handle = runPlan({
    folder: copyPlan('need-gap').folder,
    onCall: () => {},
    onReview: () => {},
    onPhase: () => {},
    onWaiting: (seqs) => waiting(seqs),
    onEnd: () => {},
  });
  assert.deepEqual(await quiet, [0]);
  await handle.kill();
  assert.deepEqual(await handle.ended, { t: 'killed' });
  assert.throws(() => process.kill(handle.pid, 0), { code: 'ESRCH' });
  assert.throws(() => process.kill(-handle.pid, 0), { code: 'ESRCH' });
});

test('the sandbox lets a plan read its own folder and nothing else, write nothing, spawn nothing', async () => {
  const { folder, root } = copyPlan('sandbox');
  writeFileSync(path.join(root, 'secret.txt'), 'outside the plan folder');
  const result = await dryRun({
    folder,
    known: (call) => passedReport(call.key),
    reviewed: () => false,
  });
  assert.equal(result.end.t, 'candidate');
  const first = result.calls[0];
  assert.deepEqual(first.t === 'ask' ? {} : first.item, {
    brief: 'inside the plan folder',
    sibling: 'ERR_ACCESS_DENIED',
    etcHosts: 'ERR_ACCESS_DENIED',
    write: 'ERR_ACCESS_DENIED',
    spawn: 'ERR_ACCESS_DENIED',
  });
});
