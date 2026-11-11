import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { keyed } from '@unleashd/shared';
import { git, harness } from './fixtures/agent-runs';
import { tempDir } from './fixtures/temp';

// CONNECT_PLAN §8 steps 3 and 5, the owner's side, through real boundaries: the REAL backend
// (server.ts) with the keyed host composed inside it by `createKeyedHost`
// (fixtures/expedition-backend.ts), its `consumes` in front of the Buddy routes, real kernels and
// plan processes, the real Buddy runner, crate and git. The owner types into the leader's DM
// through the owner post route, as the UI does. Only the agent CLI is a fake.

const h = harness('xk-owner');
let ws = '';
let lead = '';
let dm = '';
let base = '';

before(async () => {
  await h.boot('A', { EXP_USAGE_WAIT_MS: '500' });
  ws = await h.workspace();
  lead = await h.hire(ws, 'lead');
  dm = await h.dm(lead);
  fs.mkdirSync(path.join(h.repo, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(h.repo, 'scripts', 'ok.js'), 'process.exit(0);\n');
  git(h.repo, 'add', '.');
  git(h.repo, 'commit', '-qm', 'scripts');
  base = git(h.repo, 'rev-parse', 'HEAD');
});

after(async () => {
  await h.kill();
  for (const file of fs.readdirSync(h.fake('.')).filter((f) => f.endsWith('.pgid')))
    try {
      process.kill(-Number(h.read(file)), 'SIGKILL');
    } catch {}
});

const SEAT = "seat('claude', 'claude-sonnet-5-5', 'low')";
function planFolder(x: { plan: string; briefs?: Record<string, string>; hours?: number }): string {
  const folder = tempDir('xk-owner-plan-');
  fs.writeFileSync(
    path.join(folder, 'contract.md'),
    `---
leader: ${lead}
repo: ${h.repo}
budget: { usd: 50, hours: ${x.hours ?? 4} }
autoApply: { usd: 5 }
pools: { claude: 4 }
done:
  - owner: Is it done?
rules:
  - Stay inside the repo.
---

# Goal

Answer the owner's questions, then finish.
`
  );
  fs.writeFileSync(path.join(folder, 'plan.ts'), x.plan);
  fs.mkdirSync(path.join(folder, 'briefs'));
  for (const [name, text] of Object.entries(x.briefs ?? {}))
    fs.writeFileSync(path.join(folder, 'briefs', `${name}.md`), text);
  return folder;
}
const fence = (o: unknown) => `Decided.\n\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;

const settledOf = (entries: keyed.Entry[], key: string) =>
  entries.filter(
    (e): e is Extract<keyed.Entry, { t: 'settled' }> => e.t === 'settled' && e.key === key
  );
const askPosts = async (exp: string) =>
  (await h.rootPosts(dm)).filter(
    (p) => p.purpose === 'expedition_ask' && p.evidence.includes(`expedition-v1:${exp}`)
  );
const threadRoot = async (exp: string) => {
  const book = await h.ownerBook(exp);
  assert.equal(book.thread.t, 'posted');
  return book.thread.t === 'posted' ? book.thread.rootId : '';
};
/** The leader's runs: none may come from an owner post in an expedition's thread. */
const leaderRuns = () => h.runsOf(lead);
const settle = () => new Promise((resolve) => setTimeout(resolve, 1_500));

const STEER_PLAN = `import { command, need, plan, role, seat, steps } from 'expedition';

const worker = role({ by: ${SEAT}, usd: 1, minutes: 10 });
const { flaky, finish } = steps({
  flaky: worker,
  finish: command('node scripts/ok.js', { minutes: 1 }),
});

export default plan(async (x) => {
  await Promise.all([x.ask('Which color first?'), x.confirm('Ship it?'), flaky()]);
  await x.review('Go on?');
  return need(await finish(), 'no finish');
});
`;

test('asks post once across a restart and settle from thread replies; commands steer; talk is a note', {
  timeout: 400_000,
}, async () => {
  const exp = await h.launch(
    planFolder({
      plan: STEER_PLAN,
      briefs: { flaky: 'Answer badly. TAG:flaky MODE:malformed' },
    }),
    ws,
    base
  );
  const asks = await h.eventually(
    () => askPosts(exp),
    (posts) => posts.length === 2,
    'both questions posted in the leader DM'
  );
  const text = asks.find((p) => p.body.includes('Which color first?'));
  const confirm = asks.find((p) => p.body.includes('Ship it?'));
  assert.ok(text && confirm);
  assert.equal(text.author.id, lead, 'an ask is the leader’s post');
  const root = await threadRoot(exp);

  // ---- bare commands at the expedition thread's root ----
  await h.eventually(
    () => h.entries(exp),
    (es) => settledOf(es, 'flaky').length === 1,
    'flaky errored'
  );
  const say = (body: string, key: string) => h.reply(dm, root, body, key);
  const acks = async () => (await h.thread(root)).filter((p) => p.author.id === lead);
  const ackOf = async (start: string) =>
    h.eventually(
      acks,
      (ps) => ps.some((p) => p.body.startsWith(start)),
      `the "${start}" acknowledgement`
    );

  const pause = await say('pause', 'o-pause');
  await ackOf('Paused');
  assert.equal((await h.view(exp)).status.t, 'paused');
  await say('Resume.', 'o-resume');
  await ackOf('Resumed');
  assert.equal((await h.view(exp)).status.t, 'running');
  const before = Date.parse((await h.view(exp)).deadline);
  await say('extend 2h', 'o-extend');
  await ackOf('Extended 2 h');
  assert.equal(Date.parse((await h.view(exp)).deadline) - before, 2 * 3_600_000);
  await say('retry flaky', 'o-retry');
  await ackOf('Retrying flaky');
  await h.eventually(
    () => h.entries(exp),
    (es) => settledOf(es, 'flaky').length === 2,
    'the retried attempt ran'
  );
  const entries = await h.entries(exp);
  assert.ok(entries.some((e) => e.t === 'retried' && e.key === 'flaky' && e.by === 'owner'));
  assert.equal(h.spawnsOf('flaky'), 2);
  // A refused command is answered, not applied.
  await say('retry nothing/here', 'o-retry-bad');
  await ackOf('"retry nothing/here": not done');

  // ---- talk: a note for the leader's next wake, which wakes nobody ----
  await say('Please favour blue options.', 'o-note');
  await ackOf('Noted');
  const book = await h.ownerBook(exp);
  assert.deepEqual(
    book.notes.map((n) => n.text),
    ['Please favour blue options.']
  );

  // Each command was consumed (no Buddy turn, no delivery) and acknowledged exactly once, also
  // after more observation passes.
  assert.equal(pause.purpose, 'host_command');
  await settle();
  const lines = (await acks()).map((p) => p.body.split(' ')[0]);
  for (const word of ['Paused', 'Resumed.', 'Extended', 'Retrying', 'Noted'])
    assert.equal(lines.filter((l) => l === word).length, 1, `one ${word} line`);
  assert.deepEqual(await leaderRuns(), [], 'no owner post in the thread started a leader run');

  // ---- the backend dies with both asks pending ----
  await h.kill();
  await h.boot('B', { EXP_USAGE_WAIT_MS: '500' });
  assert.equal((await h.open(exp)).t, 'opened');
  await settle();
  assert.equal((await askPosts(exp)).length, 2, 'each question was posted once');

  // A text ask: the first owner reply is the answer.
  const answer = await h.reply(dm, text.id, 'Blue, then green.', 'o-color');
  assert.equal(answer.purpose, 'host_command', 'an answer wakes nobody');
  await h.eventually(
    () => h.entries(exp),
    (es) => settledOf(es, 'ask/which-color-first').length === 1,
    'the text ask settled'
  );
  const [color] = settledOf(await h.entries(exp), 'ask/which-color-first');
  assert.equal(color?.outcome.t, 'passed');
  assert.equal(color?.outcome.t === 'passed' && color.outcome.out, 'Blue, then green.');

  // A confirm ask: an unclear reply is answered once and the question stays open.
  await h.reply(dm, confirm.id, 'maybe later', 'o-maybe');
  const reAsks = () => h.thread(confirm.id).then((ps) => ps.filter((p) => p.author.id === lead));
  await h.eventually(reAsks, (ps) => ps.length === 1, 'the host re-asks once');
  await settle();
  assert.equal((await reAsks()).length, 1, 'still once after more passes');
  assert.equal(settledOf(await h.entries(exp), 'ask/ship-it').length, 0);
  await h.reply(dm, confirm.id, 'Yes!', 'o-yes');
  await h.eventually(
    () => h.entries(exp),
    (es) => settledOf(es, 'ask/ship-it').length === 1,
    'the confirm ask settled'
  );
  const [ship] = settledOf(await h.entries(exp), 'ask/ship-it');
  assert.equal(ship?.outcome.t === 'passed' && ship.outcome.out, true);

  // ---- the review wakes the leader: the owner's note is in its prompt ----
  const name = h.leaderName(exp, 1);
  await h.eventually(() => h.exists(`${name}.midturn`), Boolean, 'the review wake');
  assert.match(h.read(`${name}.prompt`), /Please favour blue options\./);
  h.leaderAnswers(exp, 1, { answer: fence({ t: 'continue', why: 'on track' }) });

  // The candidate's owner criterion is an ask too; answered here through the route.
  const doneAsk = await h.eventually(
    () => h.view(exp),
    (v) => v.asks.some((a) => a.key === 'done/0'),
    'the done question'
  );
  const ref = doneAsk.asks.find((a) => a.key === 'done/0')?.ref as string;
  assert.equal(
    (await h.answerAsk(exp, ref, { t: 'text', text: 'yes' })).t,
    'refused',
    'a confirm ask takes yes or no'
  );
  assert.equal((await h.answerAsk(exp, ref, { t: 'confirm', yes: true })).t, 'answered');
  const done = await h.eventually(
    () => h.view(exp),
    (v) => v.status.t === 'finished',
    'finished'
  );
  assert.deepEqual(done.status.t === 'finished' && done.status.reason.t, 'met');
  // Only the review woke the leader: its one wake run, nothing from the owner's posts.
  const runs = await leaderRuns();
  assert.equal(runs.length, 1, JSON.stringify(runs));
  assert.equal(runs[0]?.input.kind, 'post');
});

test('an ask stays answerable after the deadline; stop ends the expedition, acknowledged once', {
  timeout: 240_000,
}, async () => {
  const exp = await h.launch(
    planFolder({
      hours: 0.003,
      plan: `import { command, need, plan, steps } from 'expedition';

const { finish } = steps({ finish: command('node scripts/ok.js', { minutes: 1 }) });

export default plan(async (x) => {
  await x.ask('Is it late?');
  return need(await finish(), 'no finish');
});
`,
    }),
    ws,
    base
  );
  const [ask] = await h.eventually(
    () => askPosts(exp),
    (posts) => posts.length === 1,
    'the question'
  );
  const deadline = Date.parse((await h.view(exp)).deadline);
  await h.eventually(
    () => Date.now(),
    (now) => now > deadline + 1_000,
    'past the deadline',
    30_000
  );
  assert.equal((await h.view(exp)).asks.length, 1, 'still pending past the deadline');
  await h.reply(dm, ask?.id as string, 'Late, but yes.', 'o-late');
  const late = await h.eventually(
    () => h.entries(exp),
    (es) => settledOf(es, 'ask/is-it-late').length === 1,
    'answered after the deadline'
  );
  const [answered] = settledOf(late, 'ask/is-it-late');
  assert.equal(answered?.outcome.t === 'passed' && answered.outcome.out, 'Late, but yes.');
  assert.ok(Date.parse(answered?.at as string) > deadline);

  const root = await threadRoot(exp);
  await h.reply(dm, root, 'stop', 'o-stop');
  const acked = () =>
    h
      .thread(root)
      .then((ps) => ps.filter((p) => p.author.id === lead && /^(Stopped|"stop")/.test(p.body)));
  await h.eventually(acked, (ps) => ps.length === 1, 'the stop acknowledged');
  await settle();
  assert.equal((await acked()).length, 1);
  assert.equal((await h.view(exp)).status.t, 'finished');
});
