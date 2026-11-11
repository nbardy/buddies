import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { keyed } from '@unleashd/shared';
import { git, harness } from './fixtures/agent-runs';
import { rewriteSource, writePlan } from './fixtures/expedition-source';
import { tempDir } from './fixtures/temp';

// CONNECT_PLAN §8 step 5: the real Leader and Owner ports through real boundaries. The REAL
// backend (server.ts) runs the keyed host composed by `createKeyedHost`
// (fixtures/expedition-backend.ts): real kernels, plan processes and typecheck gate, the real
// Buddy runner, grants and MCP endpoint, crate, ingest and git. The fake agent CLI is the only
// fake: as an agent it answers by its TAG markers, as the leader it waits for the test's script,
// edits its draft folder and answers.

const h = harness('xk-leader');
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
  // A check judge reads the output it judges from EXPEDITION_OUTPUT.
  fs.writeFileSync(
    path.join(h.repo, 'scripts', 'check.js'),
    `const out = JSON.parse(require('node:fs').readFileSync(process.env.EXPEDITION_OUTPUT, 'utf8'));
process.exit(typeof out.summary === 'string' ? 0 : 1);
`
  );
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
const HEAD = `import { check, need, expedition, role, seat, steps } from 'expedition';

const worker = role({ by: ${SEAT}, usd: 1, minutes: 10 });`;
const answers = (tag: string, mode = 'answer', summary = 'done') =>
  `Do it. TAG:${tag} MODE:${mode} ANSWER_JSON:{"summary":"${summary}","files":[]}`;

function planFile(x: {
  plan: string;
  prompts?: Record<string, string>;
  autoApply?: number;
  done?: import('../src/expedition-kernel/contract').ContractInput['done'];
  wakeUsd?: number;
}): string {
  return writePlan(
    path.join(tempDir('xk-leader-plan-'), 'plan.expedition.ts'),
    {
      leader: lead,
      repo: h.repo,
      goal: 'Probe, reflect, and finish.',
      budget: { usd: 50, hours: 4 },
      autoApply: { usd: x.autoApply ?? 5 },
      pools: { claude: 4 },
      done: x.done ?? [{ check: 'node scripts/ok.js' }],
      rules: ['Stay inside the repo.'],
      ...(x.wakeUsd === undefined ? {} : { leaderWake: { usd: x.wakeUsd, minutes: 5 } }),
    },
    x.plan,
    x.prompts
  );
}
const fence = (o: unknown) => `I decided.\n\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;
const rewrite = (why: string) => fence({ t: 'rewrite', file: 'plan.expedition.ts', why });

const ofKey = <T extends keyed.Entry['t']>(es: keyed.Entry[], t: T, key: string) =>
  es.filter((e): e is Extract<keyed.Entry, { t: T }> => e.t === t && 'key' in e && e.key === key);
const plansOf = (es: keyed.Entry[]) =>
  es.filter((e): e is Extract<keyed.Entry, { t: 'plan' }> => e.t === 'plan');
const finished = (exp: string) =>
  h.eventually(
    () => h.view(exp),
    (v) => v.status.t === 'finished',
    `${exp} finished`
  );
const wake = (exp: string, n: number) =>
  h.eventually(() => h.exists(`${h.leaderName(exp, n)}.midturn`), Boolean, `leader wake ${n}`);
const promptOf = (exp: string, n: number) => h.read(`${h.leaderName(exp, n)}.prompt`);
const expDir = (exp: string) => path.join(h.expRoot, exp);

test('a wake is one crate run per run id across a SIGKILL; a rewrite applies plan v1, reuses the probe and keeps the pending ask', {
  timeout: 400_000,
}, async () => {
  const exp = await h.launch(
    planFile({
      plan: `${HEAD}
const { probe } = steps({ probe: worker.brief(PROMPTS.probe).judged(check('node scripts/check.js')) });

export default expedition({ contract: CONTRACT, plan: async (x) => {
  const p = need(await probe(), 'no probe');
  await Promise.all([x.ask('Which segment first?'), x.review('Change course?')]);
  return p;
} });
`,
      prompts: { probe: answers('probe', 'answer', 'SECRET-PROBE-OUTPUT') },
    }),
    ws,
    base
  );
  await wake(exp, 1);
  const draft1 = path.join(expDir(exp), 'drafts', '1');

  // The wake's turn: no tools, in its draft folder (one editable file with the inline owner contract),
  // told the state without the body of any output.
  const name1 = h.leaderName(exp, 1);
  assert.deepEqual(JSON.parse(h.read(`${name1}.tools`)), [], 'a leader wake has no tools');
  // Its limits (expedition-kernel/access.ts `leader`, CONNECT_PLAN §10 F1): read the expedition
  // directory, write only the draft folder; no shell, web, instructions, MCP server or bypass.
  const argv1: string[] = JSON.parse(h.read(`${name1}.argv`));
  const flag = (name: string) => argv1[argv1.indexOf(name) + 1];
  assert.equal(flag('--permission-mode'), 'dontAsk');
  assert.equal(flag('--setting-sources'), '');
  assert.equal(flag('--tools'), 'Read,Grep,Glob,Edit,Write,NotebookEdit');
  assert.deepEqual(
    argv1.flatMap((a, i) => (a === '--add-dir' ? [argv1[i + 1]] : [])),
    [expDir(exp)]
  );
  assert.deepEqual(JSON.parse(flag('--settings') as string).permissions.allow, [
    `Edit(/${draft1}/**)`,
  ]);
  assert.ok(!argv1.includes('--dangerously-skip-permissions') && !argv1.includes('--mcp-config'));
  assert.equal(fs.realpathSync(h.read(`${name1}.cwd`)), fs.realpathSync(draft1));
  assert.equal(
    fs.readFileSync(path.join(draft1, 'plan.expedition.ts'), 'utf8'),
    fs.readFileSync(path.join(expDir(exp), 'plans', 'v0.expedition.ts'), 'utf8')
  );
  assert.deepEqual(fs.readdirSync(draft1), ['plan.expedition.ts']);
  const prompt1 = promptOf(exp, 1);
  assert.match(prompt1, /Change course\?/);
  assert.match(prompt1, /Which segment first\?/, 'the pending ask is in the state');
  assert.doesNotMatch(prompt1, /SECRET-PROBE-OUTPUT/, 'no output body in the prompt');
  assert.match(
    prompt1,
    /"key":"probe","kind":"agent","attempt":1,"status":"settled","outcome":"passed"/
  );
  assert.match(prompt1, /refs\/probe[^"]*\.out\.json/, 'the probe row names its answer file');

  // The backend dies mid-wake. The next one settles that wake errored and closes its id (its
  // adopted turn is cancelled, never run again), and the replayed review wakes leader/2.
  const [askPost] = (await h.rootPosts(dm)).filter((p) => p.purpose === 'expedition_ask');
  await h.kill();
  await h.boot('B', { EXP_USAGE_WAIT_MS: '500' });
  assert.equal((await h.open(exp)).t, 'opened');
  await wake(exp, 2);
  const es = await h.entries(exp);
  const [wake1] = ofKey(es, 'settled', 'leader/1');
  assert.equal(wake1?.outcome.t, 'errored');
  const runId1 = ofKey(es, 'started', 'leader/1')[0]?.runId as string;
  const closed = await h.eventually(
    () => h.ex<{ t: string; value?: { t: string } }>('record', { runId: runId1 }),
    (r) => r.value?.t === 'closed',
    'leader/1 closed'
  );
  assert.equal(closed.value?.t, 'closed');
  const wakePosts = (await h.runsOf(lead)).filter((r) => r.input.kind === 'post');
  assert.equal(h.spawnsOf(name1), 1, 'leader/1 ran once');
  assert.equal(
    new Set(wakePosts.map((r) => r.input.postId)).size,
    wakePosts.length,
    'one crate run per wake post'
  );

  // leader/2 rewrites: v1 keeps the probe and the question and adds `more`.
  h.leaderAnswers(exp, 2, {
    files: {
      'plan.expedition.ts': rewriteSource(
        expDir(exp),
        `${HEAD}
const { probe, more } = steps({
  probe: worker.brief(PROMPTS.probe).judged(check('node scripts/check.js')),
  more: worker.brief(PROMPTS.more),
});

export default expedition({ contract: CONTRACT, plan: async (x) => {
  const p = need(await probe(), 'no probe');
  await x.ask('Which segment first?');
  return need(await more({ reads: [p] }), 'no more');
} });
`,
        { more: answers('more') }
      ),
    },
    answer: rewrite('one more step'),
  });
  const applied = await h.eventually(
    () => h.entries(exp),
    (all) => plansOf(all).length === 2,
    'plan v1'
  );
  const [, v1] = plansOf(applied);
  assert.equal(v1?.version, 1);
  assert.equal(v1?.why, 'one more step');
  assert.deepEqual(v1?.diff.reused, ['probe']);
  assert.deepEqual(v1?.diff.attached, ['ask/which-segment-first']);
  assert.ok(fs.existsSync(path.join(expDir(exp), 'plans', 'v1.expedition.ts')));

  // The pending ask was not disturbed: one post, answered in its thread, and the plan goes on.
  assert.equal((await h.rootPosts(dm)).filter((p) => p.purpose === 'expedition_ask').length, 1);
  await h.reply(dm, askPost?.id as string, 'Robotics labs.', 'l-segment');
  const done = await finished(exp);
  assert.equal(done.status.t === 'finished' && done.status.reason.t, 'met');
  assert.equal(h.spawnsOf('probe'), 1, 'the reused probe never ran again');
  assert.equal(h.spawnsOf('more'), 1);
});

test('an answer that is not an act settles the wake errored, and it is charged', {
  timeout: 240_000,
}, async () => {
  const exp = await h.launch(
    planFile({
      plan: `${HEAD}
const { probe } = steps({ probe: worker.brief(PROMPTS.probe) });

export default expedition({ contract: CONTRACT, plan: async (x) => {
  const p = need(await probe(), 'no probe');
  await x.review('Anything to change?');
  return p;
} });
`,
      prompts: { probe: answers('probetwo') },
      wakeUsd: 0.4,
    }),
    ws,
    base
  );
  await wake(exp, 1);
  const before = (await h.view(exp)).spentUsd;
  h.leaderAnswers(exp, 1, { answer: 'I think we should keep going, probably.' });
  const done = await finished(exp);
  const [settled] = ofKey(await h.entries(exp), 'settled', 'leader/1');
  assert.equal(settled?.outcome.t, 'errored');
  assert.match(settled?.outcome.t === 'errored' ? settled.outcome.why : '', /malformed answer/);
  // Its turn reported no usage, so the kernel charged the wake's whole reservation: the
  // contract's `leaderWake` cap ($0.40), not a fixed $2 (the 2026-11-11 run held $2 of a $3
  // budget for a wake that cost $0.04).
  assert.deepEqual(settled?.spent, { t: 'unreported' });
  const [started] = ofKey(await h.entries(exp), 'started', 'leader/1');
  assert.equal(started?.reserved.usd, 0.4);
  assert.ok(Math.abs(done.spentUsd - before - 0.4) < 1e-9);
  // An errored review wake ends the expedition with the reason as its gap.
  assert.equal(done.status.t === 'finished' && done.status.reason.t, 'not-met');
});

test('dropping running calls without dispositions.json is rejected and the next wake is told; with it, one is cancelled and one finishes', {
  timeout: 300_000,
}, async () => {
  const exp = await h.launch(
    planFile({
      plan: `${HEAD}
const { probe, slowa, slowb } = steps({
  probe: worker.brief(PROMPTS.probe).judged(check('node scripts/check.js')),
  slowa: worker.brief(PROMPTS.slowa),
  slowb: worker.brief(PROMPTS.slowb),
});

export default expedition({ contract: CONTRACT, plan: async (x) => {
  const p = need(await probe(), 'no probe');
  const slow = Promise.all([slowa(), slowb()]);
  await x.review('Keep the slow ones?');
  await slow;
  return p;
} });
`,
      prompts: {
        probe: answers('probethree'),
        slowa: answers('slowa', 'hold'),
        slowb: answers('slowb', 'hold'),
      },
    }),
    ws,
    base
  );
  await wake(exp, 1);
  await h.eventually(
    () => h.exists('slowa.midturn') && h.exists('slowb.midturn'),
    Boolean,
    'both slow calls running'
  );
  // v1 waits on the owner, so it cannot finish (and cancel what drains) before slowb is done.
  const V1 = `${HEAD}
const { probe } = steps({ probe: worker.brief(PROMPTS.probe).judged(check('node scripts/check.js')) });

export default expedition({ contract: CONTRACT, plan: async (x) => {
  const p = need(await probe(), 'no probe');
  await x.ask('Ready to finish?');
  return p;
} });
`;
  h.leaderAnswers(exp, 1, {
    files: { 'plan.expedition.ts': rewriteSource(expDir(exp), V1) },
    answer: rewrite('drop the slow ones'),
  });
  await wake(exp, 2);
  const prompt2 = promptOf(exp, 2);
  assert.match(prompt2, /no cancel or finish for the dropped running calls slowa, slowb/);
  assert.equal(plansOf(await h.entries(exp)).length, 1, 'the rejected rewrite changed nothing');
  assert.ok(!fs.existsSync(path.join(expDir(exp), 'plans', 'v1')));

  h.leaderAnswers(exp, 3, { answer: fence({ t: 'continue', why: 'on track' }) });
  h.leaderAnswers(exp, 2, {
    files: {
      'plan.expedition.ts': rewriteSource(expDir(exp), V1),
      'dispositions.json': JSON.stringify({ slowa: 'cancel', slowb: 'finish' }),
    },
    answer: rewrite('drop the slow ones, decided'),
  });
  const applied = await h.eventually(
    () => h.entries(exp),
    (es) => plansOf(es).length === 2,
    'plan v1'
  );
  assert.deepEqual(plansOf(applied)[1]?.dropped, { slowa: 'cancel', slowb: 'finish' });
  const cancelled = await h.eventually(
    () => h.entries(exp),
    (es) => ofKey(es, 'settled', 'slowa').length === 1,
    'slowa cancelled'
  );
  assert.equal(ofKey(cancelled, 'settled', 'slowa')[0]?.outcome.t, 'cancelled');
  assert.equal(ofKey(cancelled, 'settled', 'slowb').length, 0, 'slowb is still finishing');
  h.release('slowb');
  await h.eventually(
    () => h.entries(exp),
    (es) => ofKey(es, 'settled', 'slowb')[0]?.outcome.t === 'passed',
    'slowb finished'
  );
  const ready = (await h.view(exp)).asks.find((a) => a.key === 'ask/ready-to-finish');
  assert.ok(ready);
  assert.equal((await h.answerAsk(exp, ready.ref, { t: 'text', text: 'yes' })).t, 'answered');
  const done = await finished(exp);
  assert.equal(done.status.t === 'finished' && done.status.reason.t, 'met');
});

test('a rewrite over autoApply waits for the owner: decline changes nothing, approve applies it', {
  timeout: 300_000,
}, async () => {
  const exp = await h.launch(
    planFile({
      autoApply: 0,
      plan: `${HEAD}
const { probe } = steps({ probe: worker.brief(PROMPTS.probe).judged(check('node scripts/check.js')) });

export default expedition({ contract: CONTRACT, plan: async (x) => {
  const p = need(await probe(), 'no probe');
  await x.review('First look?');
  await x.review('Second look?');
  return p;
} });
`,
      prompts: { probe: answers('probefour'), more: answers('morefour') },
    }),
    ws,
    base
  );
  const book = await h.ownerBook(exp);
  const root = book.thread.t === 'posted' ? book.thread.rootId : '';
  const V1 = `${HEAD}
const { probe, more } = steps({
  probe: worker.brief(PROMPTS.probe).judged(check('node scripts/check.js')),
  more: worker.brief(PROMPTS.more),
});

export default expedition({ contract: CONTRACT, plan: async () => {
  need(await probe(), 'no probe');
  return need(await more(), 'no more');
} });
`;
  const approvalPosts = () =>
    h.thread(root).then((ps) => ps.filter((p) => p.body.startsWith('The leader wants to rewrite')));

  // First look: the rewrite adds $1 of new cost over a $0 auto-apply limit.
  await wake(exp, 1);
  h.leaderAnswers(exp, 1, {
    files: { 'plan.expedition.ts': rewriteSource(expDir(exp), V1) },
    answer: rewrite('add more'),
  });
  const [request] = await h.eventually(approvalPosts, (ps) => ps.length === 1, 'the request');
  assert.match(request?.body ?? '', /new cost \$1 is over the auto-apply limit \$0/);
  assert.match(request?.body ?? '', /Started 1: more/);
  assert.match(request?.body ?? '', /Why: add more/);
  const pending = await h.view(exp);
  assert.equal(pending.approval.t, 'pending');
  const logBefore = (await h.entries(exp)).length;
  await h.reply(dm, root, 'decline', 'l-decline');
  await wake(exp, 2);
  assert.match(promptOf(exp, 2), /owner: the owner declined/);
  // Nothing changed but the wakes' own entries: no plan entry, no v1 file, no `more`.
  const keyOf = (e: keyed.Entry) =>
    e.t === 'declared' ? e.call.key : 'key' in e ? e.key : `(${e.t})`;
  const since = (await h.entries(exp)).slice(logBefore);
  assert.deepEqual(
    since.map(keyOf).filter((k) => !k.startsWith('leader/')),
    [],
    JSON.stringify(since)
  );
  assert.equal(plansOf(await h.entries(exp)).length, 1);
  assert.ok(!fs.existsSync(path.join(expDir(exp), 'plans', 'v1')));
  assert.equal((await h.view(exp)).approval.t, 'none');
  h.leaderAnswers(exp, 2, { answer: fence({ t: 'continue', why: 'on track' }) });

  // Second look: the same rewrite, approved in the thread.
  await wake(exp, 3);
  h.leaderAnswers(exp, 3, {
    files: { 'plan.expedition.ts': rewriteSource(expDir(exp), V1) },
    answer: rewrite('add more, again'),
  });
  await h.eventually(approvalPosts, (ps) => ps.length === 2, 'the second request');
  await h.reply(dm, root, 'approve', 'l-approve');
  const applied = await h.eventually(
    () => h.entries(exp),
    (es) => plansOf(es).length === 2,
    'plan v1 applied'
  );
  assert.deepEqual(plansOf(applied)[1]?.diff.started, ['more']);
  assert.equal((await h.answerApproval(exp, true)).t, 'nothing-pending', 'answered once');
  const done = await finished(exp);
  assert.equal(done.status.t === 'finished' && done.status.reason.t, 'met');
  // The continue's reason reaches the review marker (2026-11-11: it read empty).
  assert.ok(done.markers.some((m) => m.t === 'review' && m.why === 'on track'));
  assert.equal(h.spawnsOf('morefour'), 1);
  assert.deepEqual(
    (await h.runsOf(lead)).filter((r) => r.input.kind !== 'post'),
    [],
    'no owner reply woke the leader'
  );
});

test('end to end through the composition: an agent call judged by a check, a review, an owner ask, finished: met', {
  timeout: 300_000,
}, async () => {
  const exp = await h.launch(
    planFile({
      done: [
        { check: 'node scripts/ok.js' },
        {
          review: {
            rubric:
              'Is it good? TAG:rubric MODE:answer ANSWER_JSON:{"verdict":"yes","why":"it is fine"}',
            by: { t: 'seat', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'low' },
          },
        },
        { owner: 'Ship the result?' },
      ],
      plan: `${HEAD}
const { make } = steps({ make: worker.brief(PROMPTS.make).judged(check('node scripts/check.js')) });

export default expedition({ contract: CONTRACT, plan: async (x) => {
  const audience = await x.ask('Who is it for?');
  return need(await make({ reads: [audience] }), 'nothing made');
} });
`,
      prompts: {
        make: answers('make'),
        rubric:
          'Is it good? TAG:rubric MODE:answer ANSWER_JSON:{"verdict":"yes","why":"it is fine"}',
      },
    }),
    ws,
    base
  );
  const [ask] = await h.eventually(
    () =>
      h
        .rootPosts(dm)
        .then((ps) =>
          ps.filter(
            (p) => p.purpose === 'expedition_ask' && p.evidence.includes(`expedition-v1:${exp}`)
          )
        ),
    (ps) => ps.length === 1,
    'the question'
  );
  await h.reply(dm, ask?.id as string, 'Robotics teams.', 'e-who');
  const owner = await h.eventually(
    () => h.view(exp),
    (v) => v.asks.some((a) => a.key === 'done/2'),
    'the owner criterion'
  );
  assert.equal(owner.lanes.find((l) => l.key === 'make')?.status, 'settled');
  const shipRoot = await h.eventually(
    async () =>
      (await h.rootPosts(dm)).find(
        (p) => p.purpose === 'expedition_ask' && p.body.includes('Ship the result?')
      ),
    Boolean,
    'the acceptance question'
  );
  // F5: the owner is asked to accept the result, not an opaque ref (2026-11-11: `rank@<64 hex>`).
  const ship = owner.asks.find((x) => x.key === 'done/2');
  assert.equal(ship?.about.t, 'candidate');
  if (ship?.about.t === 'candidate') {
    assert.equal(ship.about.summary, 'done');
    assert.ok(fs.existsSync(ship.about.answerPath), 'the answer file exists');
    assert.ok(shipRoot?.body.includes(`Summary:\ndone`), shipRoot?.body);
    assert.ok(shipRoot?.body.includes(`Full answer: ${ship.about.answerPath}`), shipRoot?.body);
  }
  await h.reply(dm, shipRoot?.id as string, 'yes', 'e-ship');
  const done = await finished(exp);
  assert.equal(done.status.t === 'finished' && done.status.reason.t, 'met');
  const es = await h.entries(exp);
  assert.equal(ofKey(es, 'settled', 'make')[0]?.outcome.t, 'passed');
  assert.equal(ofKey(es, 'settled', 'done/0')[0]?.outcome.t, 'passed');
  assert.equal(ofKey(es, 'settled', 'done/1')[0]?.outcome.t, 'passed');
  assert.equal(ofKey(es, 'settled', 'done/2')[0]?.outcome.t, 'passed');
  assert.equal(h.spawnsOf('make'), 1);
  assert.equal(h.spawnsOf('rubric'), 1);
});
