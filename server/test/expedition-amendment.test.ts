import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createExpeditions, hash } from '../src/expedition/engine';

test('owner amends a waiting run after restart; its old final prompt, spend and later rewrites replay correctly', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expedition-amendment-'));
  const root = path.join(dir, 'runs'),
    file = path.join(dir, 'source.ts');
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', [
    '-C',
    dir,
    '-c',
    'user.name=test',
    '-c',
    'user.email=test@example.org',
    'commit',
    '--allow-empty',
    '-qm',
    'base',
  ]);
  const work: string[] = [];
  const host = () =>
    createExpeditions({
      root,
      gate: { t: 'enabled' },
      wake: async () => {},
      cancelTurn: async () => {},
      resolve: async () => ({ provider: 'codex', model: 'gpt-6.2-sol', effort: 'low' }),
      runTurn: async (r) => {
        work.push(r.title);
        return {
          t: 'complete',
          text: '{"summary":"ok","files":[]}',
          usage: { t: 'unreported', why: 'fixture', requests: [] },
          conversationId: r.key,
        };
      },
    });
  let h = host();
  t.after(async () => {
    await h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const original = {
    goal: 'Inspect',
    repo: dir,
    leader: 'buddy:manager',
    budget: { usd: 2, hours: 1 },
    autoApply: { usd: 0 },
    rules: [] as string[],
    done: [{ owner: 'Accept first report?' }] as { owner: string }[],
  };
  const next = { ...original, goal: 'Inspect and repair', autoApply: { usd: 2 }, done: [] };
  const source = (
    contract: typeof original,
    body: string
  ) => `import {expedition} from 'expedition';
export default expedition({contract:${JSON.stringify(contract)},steps:{
first:{by:'codex:gpt-6.2-sol:low',usd:0.4,brief:'first'}, second:{by:'codex:gpt-6.2-sol:low',usd:0.3,brief:'second'}},
plan:async(s,x)=>{const a=await s.first();${body}}});`;
  const before = source(original, 'return a;');
  fs.writeFileSync(file, before);
  const { id } = await h.launch({ workspaceId: 'test', hash: hash(before), file });
  const live = path.join(root, id, 'plan.expedition.ts');
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 400; i++) {
      if (ok()) return;
      await delay(25);
    }
    assert.fail(JSON.stringify(h.view(id)));
  };
  await until(() => h.view(id).questions.some((q) => q.key.startsWith('done/')));
  const finalKey = h.view(id).questions[0]!.key;
  const amend = (src: string) => {
    fs.writeFileSync(live, src);
    return h.act(id, 'manager', 'rewrite', 'Revise in place');
  };
  await amend(source(next, "await x.ask('optional label');return a;"));
  const decision = h.view(id).questions.find((q) => q.key.startsWith('rewrite/'))!;
  assert.match(decision.question, /\$2 ceiling/);
  assert.match(decision.question, /autoApply/);
  assert.equal(h.view(id).goal, original.goal);
  assert.equal(h.view(id).spend, 0.4);
  // Replaying after a restart must not depend on the live editable file or the submitting tool call.
  fs.writeFileSync(live, 'unsubmitted edits');
  await h.close();
  h = host();
  await h.boot();
  h.answer(id, decision.key, true);
  await until(() => h.view(id).questions.some((q) => q.kind === 'text'));
  assert.equal(h.view(id).goal, next.goal);
  assert.throws(() => h.answer(id, finalKey, true), /closed/);
  const refused = await amend(source({ ...next, budget: { usd: 3, hours: 1 } }, 'return a;'));
  assert.ok('issues' in refused);
  const after = source(next, 'return s.second();');
  await amend(after);
  await until(() => h.view(id).status === 'met');
  assert.deepEqual(work, ['Expedition first', 'Expedition second']);
  const v = h.view(id);
  assert.deepEqual(v.budget, original.budget);
  assert.deepEqual(v.questions, []);
  assert.deepEqual(v.versions, [1, 2, 3]);
  assert.equal(v.spend, 0.7);
  await h.close();
  h = host();
  await h.boot();
  assert.deepEqual(h.view(id), v);
});
