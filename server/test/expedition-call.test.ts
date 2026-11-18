import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { Call } from '../src/expedition/author';
import { type CallDeps, execute, modelOf } from '../src/expedition/call';
import { Contract } from '../src/expedition/gates';
import { priceUsd } from '../src/providers/pricing';
import type { RunTurnRequest } from '../src/turns/run-turn';

// Bugs caught: a reviewer that cannot be selected is discovered only after the writer is paid, and the
// step is booked at its whole reservation (2026-11-18: $7.50 for a report nobody reviewed); a review
// that cannot finish replaces the writer's real price with that reservation. No provider is called.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'expedition-call-'));
const repo = path.join(root, 'repo');
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
fs.mkdirSync(repo);
git('init', '-q');
fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
git('add', 'a.txt');
git('-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '-m', 'base');
const base = git('rev-parse', 'HEAD');
after(() => fs.rmSync(root, { recursive: true, force: true }));

// The step of the incident: an Opus writer capped at $6, reviewed by a Buddy, review capped at $1.50.
const WRITER = 'claude:claude-opus-5-5:high';
const contract = Contract.parse({
  goal: 'g',
  leader: 'buddy:lead',
  repo,
  budget: { usd: 90, hours: 36 },
  rules: [],
  done: [],
  doneReview: { usd: 1.5, minutes: 20 },
});
const report = {
  type: 'object',
  properties: { summary: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } },
  required: ['summary', 'files'],
  additionalProperties: false,
};
const step = (by: string, reviewer: string): Exclude<Call, { t: 'question' }> => ({
  t: 'agent',
  key: 'packet',
  usd: 6,
  minutes: 45,
  needs: [],
  inputs: {},
  output: report,
  by,
  brief: 'Write the report.',
  reads: [],
  web: false,
  checkout: false,
  judge: { review: 'Does it say what the evidence says?', by: reviewer },
});
const tokens = { input: 100_000, output: 10_000, cacheRead: 0, cacheWrite: 0, cacheWrite1H: 0 };
const priced = priceUsd('claude', 'claude-opus-5-5', { ...tokens, reportedCostUsd: 0 });
assert.equal(priced.t, 'priced');
const writerUsd = priced.t === 'priced' ? priced.usd : Number.NaN;

type Review = 'passes' | 'throws';
function fixture(review: Review) {
  const turns: RunTurnRequest[] = [];
  const deps: CallDeps = {
    // The server's resolver: a model string parses; a Buddy without a selected model throws.
    resolve: async (who) => {
      if (who.startsWith('buddy:')) throw new Error('Expedition Buddy must select a model');
      return modelOf(who);
    },
    cancelTurn: async () => {},
    runTurn: async (r) => {
      turns.push(r);
      const reviewing = r.key.endsWith('/review');
      if (reviewing && review === 'throws') throw new Error('review harness unavailable');
      return {
        t: 'complete',
        text: JSON.stringify(
          reviewing ? { verdict: 'yes', why: 'traced' } : { summary: 'done', files: [] }
        ),
        usage: { t: 'reported', tokens },
        conversationId: reviewing ? 'review-conversation' : 'writer-conversation',
      };
    },
  };
  return { deps, turns };
}
let run = 0;
const place = () => ({
  token: `step${++run}`,
  folder: path.join(root, 'run'),
  repo,
  base,
  contract,
  signal: new AbortController().signal,
});
const worktrees = () =>
  git('worktree', 'list', '--porcelain')
    .split('\n')
    .filter((l) => l.startsWith('worktree ')).length;

test('books nothing when the reviewer seat cannot be selected, and starts no turn', async () => {
  const { deps, turns } = fixture('passes');
  const receipt = await execute(deps, step(WRITER, 'buddy:lead'), place());
  assert.equal(receipt.cost, 0, 'the incident booked the $7.50 reservation here');
  assert.equal(receipt.result.t, 'errored');
  assert.match(receipt.result.t === 'errored' ? receipt.result.why : '', /must select a model/);
  assert.equal(
    turns.length,
    0,
    'the writer must not be paid before its reviewer is known to exist'
  );
});

test('books nothing when the writer seat cannot be selected', async () => {
  const { deps, turns } = fixture('passes');
  const receipt = await execute(deps, step('buddy:writer', WRITER), place());
  assert.equal(receipt.cost, 0);
  assert.equal(receipt.result.t, 'errored');
  assert.equal(turns.length, 0);
});

test("keeps the writer's own price when its review cannot finish", async () => {
  const { deps, turns } = fixture('throws');
  const receipt = await execute(deps, step(WRITER, WRITER), place());
  assert.deepEqual(
    turns.map((t) => t.key.endsWith('/review')),
    [false, true]
  );
  assert.equal(receipt.cost, writerUsd, 'the reservation is $6; the writer reported less');
  assert.ok(receipt.cost > 0 && receipt.cost < 6);
  assert.equal(receipt.result.t, 'errored');
  assert.match(receipt.result.t === 'errored' ? receipt.result.why : '', /Review could not finish/);
  assert.equal(receipt.conversationId, 'writer-conversation');
  assert.equal(worktrees(), 1, 'the judged checkout is removed');
});

test('a selected reviewer still reviews: both prices are booked and the step passes', async () => {
  const { deps, turns } = fixture('passes');
  const receipt = await execute(deps, step(WRITER, WRITER), place());
  assert.equal(turns.length, 2);
  assert.equal(receipt.result.t, 'passed');
  assert.equal(receipt.cost, writerUsd * 2);
  assert.equal(receipt.review?.who, WRITER);
  assert.equal(worktrees(), 1);
});
