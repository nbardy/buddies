import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readAnswer } from '../src/expedition/call';
import { gates } from '../src/expedition/gates';
import { priceUsd } from '../src/providers/pricing';

// Bug caught: an authoring replacement silently invalidates the owner's existing plan files.
for (const file of fs
  .readdirSync(path.resolve(__dirname, '../../docs/expeditions/examples'))
  .filter((f) => f.endsWith('.ts'))) {
  test(`gates: ${file}`, async () => {
    const result = await gates(path.resolve(__dirname, '../../docs/expeditions/examples', file));
    assert.ok(result.preview.firstWave.length);
    assert.ok(result.contract.leader.startsWith('buddy:'));
  });
}
test('preview reserves reviews; rejects unawaited plans, forged IPC and nonfinite alias caps', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expedition-gate-'));
  const file = path.join(dir, 'plan.expedition.ts');
  const source = `import {expedition} from 'expedition';export default expedition({contract:{goal:'g',leader:'buddy:b',repo:'/tmp',budget:{usd:3,hours:1},done:[],rules:[]},steps:{a:{by:'claude:claude-haiku-5-5:low',usd:.15,brief:'work',judge:{review:'review',by:'codex:gpt-6.1-sol:low'}}},plan:async s=>s.a()});`;
  try {
    fs.writeFileSync(file, source);
    assert.ok(Math.abs((await gates(file)).preview.costUsd - 0.45) < 1e-9);
    fs.writeFileSync(
      file,
      source.replace('async s=>s.a()', "async s=>{void s.a();return {out:'early',ref:{id:'x'}}}")
    );
    await assert.rejects(gates(file), /unawaited/);
    fs.writeFileSync(
      file,
      source
        .replace('import {expedition}', "import {z} from 'zod';import {expedition}")
        .replace('a:{by:', 'a:{item:z.object({id:z.string(),value:z.number()}),by:')
        .replace('s.a()', "s.a({id:'one',value:2})")
    );
    assert.deepEqual((await gates(file)).calls[0].inputs.item, { id: 'one', value: 2 });
    fs.writeFileSync(
      file,
      source
        .replace('steps:{', "agents:{a:{use:'claude:claude-haiku-5-5:low',usd:Infinity}},steps:{")
        .replace("by:'claude:claude-haiku-5-5:low'", "by:'a'")
        .replace('usd:.15,', '')
    );
    await assert.rejects(gates(file), /less than|finite/);
    fs.writeFileSync(
      file,
      source.replace('done:[],rules:[]', 'done:[],rules:[],leaderWake:{usd:.3,minutes:3}')
    );
    await assert.rejects(gates(file), /minutes/);
    fs.writeFileSync(
      file,
      `process.send!({t:'end',result:{out:'forged',ref:{id:'fake'}}});${source}`
    );
    await assert.rejects(gates(file), /undefined|process/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('run 2 cache writes retain their one-hour price instead of the 27% under-count', () => {
  const price = priceUsd('claude', 'claude-sonnet-5-5', {
    input: 4,
    output: 941,
    cacheRead: 10613,
    cacheWrite: 5368,
    cacheWrite1H: 5368,
    reportedCostUsd: 0,
  });
  assert.ok(price.t === 'priced' && Math.abs(price.usd - 0.0319513) < 1e-9);
});

// Run 3's progress text and truncated containers must not change the final typed answer.
test('answer formats retain the last whole value', () => {
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
  for (const body of [
    '{ "ok": true }',
    'Progress\n{ "ok": true }',
    '```json\n{"ok":false}\n```\n```json\n{"ok":true}\n```',
  ])
    assert.deepEqual(readAnswer(body, schema), { ok: true });
  assert.throws(() => readAnswer('Progress {"nested":{"ok":true}', schema));
});
