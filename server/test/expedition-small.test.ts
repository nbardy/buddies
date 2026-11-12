import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readAnswer } from '../src/expedition/call';
import { resolveBase } from '../src/expedition/cambium';
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
    fs.unlinkSync(file);
    const pinned = source.replace("repo:'/tmp'", "repo:'/tmp',base:'release'");
    assert.equal((await gates(file, undefined, pinned)).contract.base, 'release');
    assert.equal(
      fs.existsSync(file),
      false,
      'committed source gates without writing into the repo'
    );
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
    fs.writeFileSync(file, source.replace("by:'codex:gpt-6.1-sol:low'", "by:'unknownJudge'"));
    await assert.rejects(gates(file), /Unknown agent unknownJudge/);
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

test('a stalled fetch is bounded and reports its failure while using the cached default', {
  timeout: 40_000,
}, async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'expedition-fetch-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  try {
    git('init', '-q', '-b', 'main');
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'base'
    );
    const commit = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/main', commit);
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    git('remote', 'add', 'origin', repo);
    const stall = path.join(repo, 'stall.cjs');
    fs.writeFileSync(
      stall,
      `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>process.exit());setTimeout(()=>{},30000);`,
      { mode: 0o755 }
    );
    git('config', 'remote.origin.uploadpack', stall);
    const began = Date.now();
    const result = await resolveBase(repo);
    assert.ok(Date.now() - began < 25_000, 'a stalled fetch is abandoned at its bound');
    assert.equal(result.commit, commit);
    assert.equal(result.line, `starts from origin/main at ${commit.slice(0, 7)}, fetch failed`);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('a remote added by hand (no recorded default branch) still starts from the remote default, not the folder branch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'expedition-sethead-'));
  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'repo');
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const commit = (cwd: string, message: string) =>
    git(
      cwd,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      message
    );
  try {
    fs.mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    commit(repo, 'base');
    const main = git(repo, 'rev-parse', 'HEAD');
    git(root, 'clone', '--bare', '-q', repo, origin);
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'fetch', '-q', 'origin');
    // Another session's branch is checked out, with a commit main does not have.
    git(repo, 'checkout', '-q', '-b', 'other-session');
    commit(repo, 'unrelated work');
    assert.throws(() => git(repo, 'symbolic-ref', '-q', 'refs/remotes/origin/HEAD'));
    const result = await resolveBase(repo);
    assert.equal(result.commit, main);
    assert.equal(result.line, `starts from origin/main at ${main.slice(0, 7)}, fetch succeeded`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
