import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { keyed } from '@unleashd/shared';
import { whoOf } from '../src/expedition-kernel/authoring/who';
import { parseContract } from '../src/expedition-kernel/contract';
import type { KernelDeps } from '../src/expedition-kernel/kernel';
import { preview, previewView } from '../src/expedition-kernel/launch';
import { dryRun } from '../src/expedition-kernel/runner';
import { proposedPreview } from '../src/expeditions-v1/proposal';
import { tempDir } from './fixtures/temp';

const CONTRACT = {
  goal: 'Probe',
  leader: 'buddy:lead',
  repo: '/tmp/repo',
  budget: { usd: 10, hours: 2 },
  rules: [],
  done: [{ owner: 'Accept?' }],
};
const REPORT = { summary: 'done', files: [] };
function file(steps: string, plan: string, extra = ''): string {
  const f = path.join(tempDir('authoring-'), 'plan.expedition.ts');
  writeFileSync(
    f,
    `import {expedition,step} from 'expedition';import {z} from 'zod';
export default expedition({contract:${JSON.stringify(CONTRACT)},agents:{worker:'claude:claude-sonnet-5-5:medium'},${extra}steps:${steps},plan:async(s,x)=>{${plan}}});`
  );
  return f;
}
const dry = (f: string, outcome: keyed.Outcome | undefined = undefined) =>
  dryRun({ file: f, known: () => outcome, reviewed: () => false });
const reason = (r: Awaited<ReturnType<typeof dry>>) =>
  r.end.t === 'threw' ? r.end.message : JSON.stringify(r.end);
const agent = "{by:'worker',brief:'Probe'}";

test('required calls hold with step, reason and evidence; try preserves every non-pass outcome', async () => {
  for (const outcome of [
    { t: 'failed', why: 'judge found a gap', out: REPORT, ref: 'saved' },
    { t: 'errored', why: 'no answer' },
    { t: 'cancelled', partial: 'partial' },
    { t: 'refused', reason: 'budget' },
  ] satisfies keyed.Outcome[]) {
    const held = await dry(file(`{probe:${agent}}`, 'return s.probe();'), outcome);
    assert.equal(held.end.t, 'gap');
    if (held.end.t === 'gap') {
      assert.match(held.end.why, new RegExp(`Step probe.*${outcome.t}`));
      if (outcome.t === 'failed')
        assert.deepEqual(held.end.evidence[0], { t: 'ref', ref: 'saved' });
      if (outcome.t === 'cancelled')
        assert.deepEqual(held.end.evidence[0], { t: 'ref', ref: 'partial' });
    }
    const tried = await dry(
      file(`{probe:${agent}}`, 'const r=await s.probe.try();throw Error(JSON.stringify(r));'),
      outcome
    );
    assert.equal(tried.end.t, 'threw');
    assert.match(reason(tried), new RegExp(`"t":"${outcome.t}"`));
  }
});

test('strict definitions and unknown names fail before issuing work, including unreachable steps', async () => {
  for (const [steps, issue] of [
    [`{probe:${agent},later:{by:'typo',brief:'Later'}}`, /later.*unknown agent name/],
    ["{probe:{by:'worker',brief:'Probe',chekout:true}}", /chekout/],
    ["{probe:{run:'echo x',web:true}}", /Step probe/],
    ["{probe:{by:'worker',brief:item=>item.id}}", /item schema is required/],
    ["{probe:{by:'worker',brief:item=>item.id,item:z.object({id:z.number()})}}", /string id/],
    ["{probe:{by:'claude:invented:high',brief:'Probe'}}", /probe.*Unknown model/],
    [
      "{probe:{by:'worker',brief:'Probe',judge:{review:'Rubric',by:'missing'}}}",
      /probe.judge.*unknown agent/,
    ],
  ] as const) {
    const result = await dry(file(steps, 'return s.probe();'));
    assert.equal(result.end.t, 'threw', reason(result));
    assert.match(reason(result), issue);
    assert.deepEqual(result.calls, []);
  }
});

test('an item transform cannot erase the identity used by durable keys', async () => {
  const r = await dry(
    file(
      "{probe:{by:'worker',brief:'Probe',item:z.object({id:z.string()}).transform(()=>({}))}}",
      "return s.probe({id:'a'});"
    )
  );
  assert.equal(r.end.t, 'threw');
  assert.match(reason(r), /Step probe.*parsed item must have a string id/);
  assert.deepEqual(r.calls, []);
});

test('native map arity is rejected for both call forms with actionable instructions', async () => {
  for (const call of ['s.collect', 's.collect.try']) {
    const result = await dry(
      file(
        "{collect:step({by:'worker',item:z.object({id:z.string()}),brief:org=>org.id})}",
        `return Promise.all([{id:'a'}].map(${call}));`
      )
    );
    assert.equal(result.end.t, 'threw');
    assert.match(reason(result), /second argument must be an options object/);
    assert.match(reason(result), /\(org\) => collect\(org\)/);
    assert.deepEqual(result.calls, []);
  }
});

test('command default output is a report while the kernel still returns stdout tail', async () => {
  const r = await dry(
    file(
      "{run:{run:'echo hello'}}",
      "const r=await s.run();if(r.out.summary!=='hello'||r.out.files.length)throw Error('bad report');return r;"
    ),
    { t: 'passed', ref: 'stdout', out: { tail: 'hello' } }
  );
  assert.equal(r.end.t, 'candidate', reason(r));
  assert.equal(r.calls[0]?.t === 'command' && r.calls[0].output, null);
});

test('preview resolves every policy and unreached step cap with field-level provenance', async () => {
  const f = file(
    `{first:${agent},step:{by:'bounded',brief:'Later',usd:3},agent:{by:'bounded',brief:'Later'},contract:{by:'worker',brief:'Later'},defaulted:{run:'echo hi'}}`,
    'return s.first();'
  );
  // The contract and agent caps are intentionally partial: each field resolves independently.
  const fs = await import('node:fs');
  fs.writeFileSync(
    f,
    fs
      .readFileSync(f, 'utf8')
      .replace('"rules":[]', '"call":{"usd":2},"rules":[]')
      .replace(
        "worker:'claude:claude-sonnet-5-5:medium'",
        "worker:'claude:claude-sonnet-5-5:medium',bounded:{use:'codex:gpt-6.1-sol:low',usd:4,minutes:30}"
      )
  );
  const forbidden = (): never => assert.fail('preview cannot execute work');
  const deps: KernelDeps = {
    gates: {
      zodEntry: path.resolve('server/node_modules/zod'),
      tscBin: path.resolve('server/node_modules/.bin/tsc'),
    },
    providerOf: () => ({ t: 'known', provider: 'claude' }),
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
  const p = previewView(await preview(deps, f));
  assert.equal(p.t, 'clean', JSON.stringify(p));
  if (p.t !== 'clean') return;
  assert.deepEqual(keyed.KeyedPreview.parse(p), p);
  assert.ok(p.defaults, 'a server-built preview always reports its defaults');
  assert.deepEqual(p.defaults.autoApply, { t: 'defaulted', value: { usd: 0 } });
  assert.equal(p.defaults.pools.t, 'defaulted');
  assert.equal(p.defaults.pools.value.codex, 1);
  assert.deepEqual(p.defaults.leaderWake, { t: 'defaulted', usd: 1, minutes: 12 });
  assert.deepEqual(p.defaults.doneReview, p.defaults.leaderWake);
  assert.deepEqual(p.defaults.call, {
    usd: { t: 'contract', value: 2 },
    minutes: { t: 'defaulted', value: 20 },
  });
  assert.equal(p.defaults.steps.length, 5);
  const caps = Object.fromEntries(p.defaults.steps.map((r) => [r.step, r]));
  assert.deepEqual(caps.step?.usd, { t: 'step', value: 3 });
  assert.deepEqual(caps.step?.minutes, { t: 'agent', value: 30 });
  assert.deepEqual(caps.agent?.usd, { t: 'agent', value: 4 });
  assert.deepEqual(caps.contract?.usd, { t: 'contract', value: 2 });
  assert.deepEqual(caps.defaulted?.minutes, { t: 'defaulted', value: 20 });
  fs.writeFileSync(
    f,
    fs.readFileSync(f, 'utf8').replace('claude:claude-sonnet-5-5:medium', 'gemini:gemini-2.5-pro')
  );
  const noEffort = await preview(deps, f);
  assert.equal(noEffort.t, 'clean', JSON.stringify(noEffort));
  if (noEffort.t === 'clean')
    assert.equal(proposedPreview(noEffort).firstWave[0]?.who, 'gemini · gemini-2.5-pro');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('buddy:lead', 'missing'));
  const refused = await preview(deps, f);
  assert.equal(refused.t, 'rejected');
  if (refused.t === 'rejected')
    assert.match(refused.issues.join(' '), /contract.leader.*unknown agent name.*missing/);
});

test('models without reasoning omit effort rather than inventing a provider value', () => {
  assert.deepEqual(whoOf('gemini:gemini-2.5-pro', 'probe'), {
    t: 'seat',
    provider: 'gemini',
    model: 'gemini-2.5-pro',
    effort: '',
  });
  assert.deepEqual(whoOf('claude:sonnet', 'probe'), {
    t: 'seat',
    provider: 'claude',
    model: 'claude-sonnet-5-5',
    effort: 'medium',
  });
});

test('owner call defaults remain in the canonical contract for the rewrite equality gate', () => {
  const a = parseContract(CONTRACT),
    b = parseContract({ ...CONTRACT, call: { usd: 2 } });
  assert.equal(a.t, 'ok');
  assert.equal(b.t, 'ok');
  if (a.t === 'ok' && b.t === 'ok') assert.notDeepEqual(a.contract, b.contract);
  for (const over of [
    { leader: 'codex:gpt-6.1-sol:low' },
    { done: [{ review: 'Rubric', by: 'buddy:lead' }] },
  ]) {
    const r = parseContract({ ...CONTRACT, ...over });
    assert.equal(r.t, 'invalid');
    if (r.t === 'invalid') assert.match(r.issues.join(' '), /kernel requires/);
  }
});
