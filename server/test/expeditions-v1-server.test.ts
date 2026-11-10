import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { keyed } from '@unleashd/shared';
import { type Post, git, harness } from './fixtures/agent-runs';
import { tempDir } from './fixtures/temp';

// CONNECT_PLAN §8 step 6: the keyed expeditions as server.ts composes, boots, routes and shuts them
// down. The REAL backend (src/server.ts alone: no second host, no control port) on temp stores,
// driven only through its HTTP routes, the way the client and the owner drive it; the agent CLI is
// the only fake. The tests run in order on one harness, each boot the next one's predecessor:
//   1. flag off, nothing on disk: inert (no directory, no boot phase), reads answer, writes 503;
//   2. flag on: preview writes nothing, launch, list, view, an ask answered by an owner reply,
//      SIGKILL mid-call, the call settles once on the next backend, finished: met;
//   3. a rewrite's approval, declined then approved through the route;
//   4. a clean shutdown kills the plan process and the command's process group;
//   5. flag off over that directory: read-only rows and views, nothing opened for write, and an
//      owner reply in an expedition's thread is not consumed;
//   6. the copied-store case (flag on, execution disabled): launch refused, nothing runs.

const h = harness('xk-server', 'server');
const API = '/api/buddies/keyed-expeditions';
const ON = { UNLEASHD_EXPEDITIONS_V1: '1', CWV_EXPEDITION_CALL_USAGE_WAIT_MS: '500' };
let ws = '';
let lead = '';
let dm = '';
let exp1 = '';
let exp3 = '';

const slowPid = () => path.join(h.root, 'slow.pid');

before(async () => {
  fs.mkdirSync(path.join(h.repo, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(h.repo, 'scripts', 'ok.js'), 'process.exit(0);\n');
  // A command that never ends on its own: the shutdown test kills it.
  fs.writeFileSync(
    path.join(h.repo, 'scripts', 'slow.js'),
    `require('node:fs').writeFileSync(${JSON.stringify(slowPid())}, String(process.pid));\nsetInterval(() => {}, 1000);\n`
  );
  git(h.repo, 'add', '.');
  git(h.repo, 'commit', '-qm', 'scripts');
});

after(async () => {
  await h.kill();
  for (const file of fs.readdirSync(h.fake('.')).filter((f) => f.endsWith('.pgid')))
    try {
      process.kill(-Number(h.read(file)), 'SIGKILL');
    } catch {}
  if (fs.existsSync(slowPid()))
    try {
      process.kill(Number(fs.readFileSync(slowPid(), 'utf8')), 'SIGKILL');
    } catch {}
});

// ---- helpers ----

const SEAT = "seat('claude', 'claude-sonnet-5-5', 'low')";
const HEAD = `import { check, command, need, plan, role, seat, steps } from 'expedition';

const worker = role({ by: ${SEAT}, usd: 1, minutes: 10 });`;
function planFolder(x: {
  plan: string;
  briefs?: Record<string, string>;
  autoApply?: number;
}): string {
  const folder = tempDir('xk-server-plan-');
  fs.writeFileSync(
    path.join(folder, 'contract.md'),
    `---
leader: ${lead}
repo: ${h.repo}
budget: { usd: 50, hours: 4 }
autoApply: { usd: ${x.autoApply ?? 5} }
pools: { claude: 4 }
done:
  - check: node scripts/ok.js
rules:
  - Stay inside the repo.
---

# Goal

Pick a color, do the work, finish.
`
  );
  fs.writeFileSync(path.join(folder, 'plan.ts'), x.plan);
  fs.mkdirSync(path.join(folder, 'briefs'));
  for (const [name, text] of Object.entries(x.briefs ?? {}))
    fs.writeFileSync(path.join(folder, 'briefs', `${name}.md`), text);
  return folder;
}
const answers = (tag: string, mode = 'answer') =>
  `Do it. TAG:${tag} MODE:${mode} ANSWER_JSON:{"summary":"done","files":[]}`;
const fence = (o: unknown) => `Decided.\n\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;

const get = (route: string) => h.http('GET', `${API}${route}`);
const post = (route: string, body: unknown) => h.http('POST', `${API}${route}`, body);
const view = async (id: string): Promise<keyed.KeyedView> => {
  const r = await get(`/${id}`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as keyed.KeyedView;
};
const rows = async (): Promise<keyed.KeyedRow[]> => {
  const r = await get('');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as keyed.KeyedRow[];
};
const finished = (id: string) =>
  h.eventually(
    () => view(id),
    (v) => v.status.t === 'finished',
    `${id} finished`
  );
const lane = (v: keyed.KeyedView, key: string) => v.lanes.find((l) => l.key === key);
/** Every file under `dir` with its bytes: "nothing was written" is this staying equal. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, 'base64');
    }
  };
  walk(dir);
  return out;
}
/** The processes whose command line names `text` (a plan process names its plan folder). */
const processesNaming = (text: string): string[] =>
  execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .filter((l) => l.includes(text) && !l.includes('ps -axo'));
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const bootPhases = (): string[] => {
  const file = path.join(h.data, 'observability', 'perf', 'boot.jsonl');
  return fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => (JSON.parse(l) as { phase: string }).phase)
    : [];
};
const MUTATIONS = (id: string) =>
  [
    [`/${id}/act`, { t: 'pause' }],
    [`/${id}/asks/${encodeURIComponent('ask/x@h')}`, { answer: 'x' }],
    [`/${id}/approval`, { approve: true }],
    ['/preview', { folder: '/tmp/none' }],
    ['/launch', { workspaceId: ws, folder: '/tmp/none' }],
  ] as const;
const askPosts = async (exp: string) =>
  (await h.rootPosts(dm)).filter(
    (p) => p.purpose === 'expedition_ask' && p.evidence.includes(`expedition-v1:${exp}`)
  );

// ---- 0 ----

// Regression guard (step 6): the live host's module graph took 140-410 ms to load under tsx, so a
// flag-off boot that imported it would be slower than before step 6. Read-only mode must never
// load it; the service requires it inside live mode only.
test('read-only mode loads none of the live host, kernel or plan runner', () => {
  const service = require('../src/expeditions-v1/service') as typeof import(
    '../src/expeditions-v1/service'
  );
  require('../src/expeditions-v1/routes');
  const mode = service.decideKeyedMode({}, { t: 'enabled' });
  assert.equal(mode.t, 'read-only');
  const x = service.createKeyedExpeditions(mode, {
    root: path.join(h.root, 'nowhere'),
  } as Parameters<typeof service.createKeyedExpeditions>[1]);
  assert.equal(x.consumes('c', 'b', { t: 'reply', to: 'p' }), false);
  const loaded = Object.keys(require.cache).filter((f) =>
    /expeditions-v1\/host\.ts$|expedition-kernel\/(kernel|launch|runner|change)\.ts$/.test(f)
  );
  assert.deepEqual(loaded, []);
});

// ---- 1 ----

test(
  'flag off, nothing on disk: the routes read empty, every write is 503, nothing is created',
  { timeout: 180_000 },
  async () => {
    await h.boot('off');
    ws = await h.workspace();
    lead = await h.hire(ws, 'lead');
    dm = await h.dm(lead);

    assert.deepEqual(await rows(), []);
    assert.equal((await get('/20261111T000000-aaaaaa')).status, 404);
    for (const [route, body] of MUTATIONS('20261111T000000-aaaaaa')) {
      const r = await post(route, body);
      assert.equal(r.status, 503, `${route}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /UNLEASHD_EXPEDITIONS_V1 is not 1/);
    }
    // Inert: no directory, and no keyed boot phase in this boot's record.
    assert.equal(fs.existsSync(h.expRoot), false, 'no expeditions-v1 directory');
    assert.deepEqual(
      bootPhases().filter((p) => p.startsWith('expeditions_v1')),
      [],
      'no keyed boot phase'
    );

    // Behind the auth gate: every route refuses a remote caller without the secret (a loopback
    // caller is this machine's browser, which the gate admits; auth.test.ts uses the same header).
    const routes: [string, string][] = [
      ['GET', ''],
      ['GET', '/x'],
      ...MUTATIONS('x').map(([r]): [string, string] => ['POST', r]),
    ];
    for (const [method, route] of routes) {
      const r = await fetch(`http://127.0.0.1:${h.port}${API}${route}`, {
        method,
        headers: { 'x-forwarded-for': '100.101.102.103', 'content-type': 'application/json' },
        body: method === 'POST' ? '{}' : undefined,
      });
      assert.equal(r.status, 401, `${method} ${route}`);
    }
    assert.equal(await h.stop(), 0, 'a clean shutdown with the flag off');
  }
);

// ---- 2 ----

const MAIN_PLAN = `${HEAD}
const { work } = steps({ work: worker });

export default plan(async (x) => {
  const [, done] = await Promise.all([x.ask('Which color?'), work()]);
  return need(done, 'no work');
});
`;

test(
  'flag on: preview writes nothing; launch, list, view; an owner reply settles the ask; a call killed mid-turn settles once; met',
  { timeout: 400_000 },
  async () => {
    await h.boot('on-A', ON);
    const folder = planFolder({ plan: MAIN_PLAN, briefs: { work: answers('work', 'hold') } });
    const before = snapshot(folder);

    // Bodies are checked, naming the field.
    const bad = await post('/preview', { folder: 'relative/path' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /folder: must be an absolute path/);
    assert.equal((await post('/launch', { folder })).status, 400, 'workspaceId missing');
    assert.match((await post('/launch', { folder })).body.error, /workspaceId/);

    // Preview: the first wave and its cost, and nothing written anywhere.
    const preview = await post('/preview', { folder });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const p = preview.body as keyed.KeyedPreview;
    assert.equal(p.t, 'clean', JSON.stringify(p));
    if (p.t !== 'clean') return;
    assert.deepEqual(p.firstWave.map((c) => [c.kind, c.reservedUsd]).sort(), [
      ['agent', 1],
      ['ask', 0],
    ]);
    assert.equal(p.costUsd, 1);
    assert.deepEqual(snapshot(folder), before, 'the folder is untouched');
    assert.deepEqual(fs.existsSync(h.expRoot) ? fs.readdirSync(h.expRoot) : [], []);
    const broken = planFolder({ plan: `${HEAD}\nexport default plan(async () => nope);\n` });
    const rejected = await post('/preview', { folder: broken });
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.t, 'rejected');
    assert.equal(rejected.body.gate, 'typecheck');

    // Launch: owner HTTP, a known workspace, the repo's base.
    const nowhere = await post('/launch', { workspaceId: 'no-such-workspace', folder });
    assert.equal(nowhere.status, 404);
    const launched = await post('/launch', { workspaceId: ws, folder });
    assert.equal(launched.status, 201, JSON.stringify(launched.body));
    exp1 = (launched.body as keyed.KeyedView).id;
    const launchedLine = JSON.parse(
      fs.readFileSync(path.join(h.expRoot, exp1, 'log.jsonl'), 'utf8').split('\n')[0] as string
    ) as Extract<keyed.Entry, { t: 'launched' }>;
    assert.equal(launchedLine.baseSha, git(h.repo, 'rev-parse', 'HEAD'), 'base: local main');
    assert.deepEqual(launchedLine.workspace, { t: 'workspace', id: ws });

    // The list and the view: the row names its workspace and that it needs the owner.
    const row = await h.eventually(
      async () => (await rows()).find((r) => r.id === exp1),
      (r) => r?.needsYou === true,
      'the row needs the owner'
    );
    assert.deepEqual(row?.workspace, { t: 'workspace', id: ws });
    const asking = await view(exp1);
    assert.equal(asking.asks.length, 1);
    assert.equal(asking.asks[0]?.question, 'Which color?');

    // The owner replies to the ask through the owner post route: consumed, it settles the ask.
    const [ask] = await h.eventually(
      () => askPosts(exp1),
      (ps) => ps.length === 1,
      'the ask posted'
    );
    const reply = await h.reply(dm, ask?.id as string, 'Blue.', 'o-blue');
    assert.equal(reply.purpose, 'host_command', 'consumed: it wakes nobody');
    const answered = await h.eventually(
      () => view(exp1),
      (v) => v.asks.length === 0 && lane(v, 'ask/which-color')?.status === 'settled',
      'the ask settled'
    );
    assert.equal(answered.needsYou, false);

    // The call runs as the seat Buddy, told that its final message is the answer (no tools).
    await h.eventually(() => h.exists('work.midturn'), Boolean, 'the call mid-turn');
    const prompt = h.read('work.prompt');
    assert.match(prompt, /your final message is the answer/);
    assert.doesNotMatch(prompt, /post\(\{ answers/);
    assert.doesNotMatch(prompt, /Evidence: /);
    assert.deepEqual(JSON.parse(h.read('work.tools')), [], 'a call turn has no tools');
    const running = await view(exp1);
    const workBar = lane(running, 'work')?.bars[0];
    assert.deepEqual(workBar?.cost, { t: 'holding', reservedUsd: 1 });

    // The backend dies mid-call; the next one adopts the turn and the call settles once.
    await h.kill();
    await h.boot('on-B', ON);
    h.release('work');
    const done = await finished(exp1);
    assert.equal(done.status.t === 'finished' && done.status.reason.t, 'met', JSON.stringify(done));
    assert.equal(h.spawnsOf('work'), 1, 'adopted, not re-run');
    const seat = (await h.buddies(ws)).find((b) => b.slug === 'expedition-seat');
    const seatRuns = (await h.runsOf(seat?.id as string)).filter((r) => r.input.kind === 'post');
    assert.equal(seatRuns.length, 1, 'one crate run for the call');
    const settledWork = lane(done, 'work')?.bars;
    assert.equal(settledWork?.length, 1);
    assert.equal(settledWork?.[0]?.cost.t, 'charged', 'no usage reported: charged its reservation');
    // Nothing woke the leader: no wake was due and the owner's reply was consumed.
    assert.deepEqual(await h.runsOf(lead), []);
    // A finished expedition takes no act.
    const late = await post(`/${exp1}/act`, { t: 'pause' });
    assert.equal(late.status, 409);

    // The call wording is inert for every other request: an ordinary one still names the `post`
    // tool and shows its evidence, and its turn has tools.
    const plain = await h.hire(ws, 'plain');
    const plainDm = await h.dm(plain);
    const asked = await h.http('POST', `/api/buddies/channels/${plainDm}/posts`, {
      kind: 'request',
      body: 'Answer plainly. TAG:plain MODE:answer ANSWER_JSON:{"n":1}',
      evidence: ['doc:notes'],
      key: 'plain-1',
    });
    assert.equal(asked.status, 201, JSON.stringify(asked.body));
    await h.eventually(() => h.exists('plain.tools'), Boolean, 'the plain request ran');
    const plainPrompt = h.read('plain.prompt');
    assert.ok(plainPrompt.includes(`post({ answers: "${asked.body.post.id}"`), plainPrompt);
    assert.match(plainPrompt, /Evidence: \["doc:notes"\]/);
    assert.ok(JSON.parse(h.read('plain.tools')).includes('post'), 'an ordinary turn has tools');
  }
);

// ---- 3 ----

test(
  'a rewrite over autoApply waits for the owner: declined, then approved, through the route',
  { timeout: 300_000 },
  async () => {
    const launched = await post('/launch', {
      workspaceId: ws,
      folder: planFolder({
        autoApply: 0,
        plan: `${HEAD}
const { probe } = steps({ probe: worker });

export default plan(async (x) => {
  const p = need(await probe(), 'no probe');
  await x.review('First look?');
  await x.review('Second look?');
  return p;
});
`,
        briefs: { probe: answers('probetwo'), more: answers('moretwo') },
      }),
    });
    assert.equal(launched.status, 201, JSON.stringify(launched.body));
    const exp = (launched.body as keyed.KeyedView).id;
    const V1 = `${HEAD}
const { probe, more } = steps({ probe: worker, more: worker });

export default plan(async () => {
  need(await probe(), 'no probe');
  return need(await more(), 'no more');
});
`;
    const wake = (n: number) =>
      h.eventually(() => h.exists(`${h.leaderName(exp, n)}.midturn`), Boolean, `wake ${n}`);
    const rewrite = (why: string) => fence({ t: 'rewrite', folder: '.', why });
    const pending = () =>
      h.eventually(
        () => view(exp),
        (v) => v.approval.t === 'pending',
        'the approval pending'
      );

    await wake(1);
    h.leaderAnswers(exp, 1, { files: { 'plan.ts': V1 }, answer: rewrite('add more') });
    const waiting = await pending();
    assert.equal(waiting.approval.t === 'pending' && waiting.approval.diff.started.join(), 'more');
    assert.equal(waiting.needsYou, true);
    assert.equal((await rows()).find((r) => r.id === exp)?.needsYou, true, 'the row says so too');
    assert.equal((await post(`/${exp}/approval`, { approve: 'no' })).status, 400);
    const declined = await post(`/${exp}/approval`, { approve: false });
    assert.equal(declined.status, 200, JSON.stringify(declined.body));
    assert.equal((declined.body as keyed.KeyedView).approval.t, 'none');
    await wake(2);
    assert.match(h.read(`${h.leaderName(exp, 2)}.prompt`), /owner: the owner declined/);
    assert.equal(
      (await view(exp)).markers.filter((m) => m.t === 'plan').length,
      1,
      'declined: no new plan'
    );
    h.leaderAnswers(exp, 2, { answer: fence({ t: 'continue' }) });

    await wake(3);
    h.leaderAnswers(exp, 3, { files: { 'plan.ts': V1 }, answer: rewrite('add more, again') });
    await pending();
    const approved = await post(`/${exp}/approval`, { approve: true });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const applied = await h.eventually(
      () => view(exp),
      (v) => v.markers.filter((m) => m.t === 'plan').length === 2,
      'plan v1 applied'
    );
    assert.deepEqual(applied.plan, { t: 'planned', version: 1 });
    const again = await post(`/${exp}/approval`, { approve: true });
    assert.equal(again.status, 409, 'answered once');
    const done = await finished(exp);
    assert.equal(done.status.t === 'finished' && done.status.reason.t, 'met');
    assert.equal(h.spawnsOf('moretwo'), 1);
  }
);

// ---- 4 ----

test(
  'a clean shutdown kills the plan process and the command process group',
  { timeout: 240_000 },
  async () => {
    const launched = await post('/launch', {
      workspaceId: ws,
      folder: planFolder({
        plan: `${HEAD}
const { slow } = steps({ slow: command('node scripts/slow.js', { minutes: 30 }) });

export default plan(async () => need(await slow(), 'no slow'));
`,
      }),
    });
    assert.equal(launched.status, 201, JSON.stringify(launched.body));
    exp3 = (launched.body as keyed.KeyedView).id;
    await h.eventually(() => fs.existsSync(slowPid()), Boolean, 'the command running');
    const pid = Number(fs.readFileSync(slowPid(), 'utf8'));
    const planDir = fs.realpathSync(path.join(h.expRoot, exp3, 'plans'));
    assert.ok(alive(pid));
    assert.equal(processesNaming(planDir).length, 1, 'one plan process');

    assert.equal(await h.stop(), 0);
    assert.equal(alive(pid), false, 'the command was killed');
    assert.deepEqual(processesNaming(planDir), [], 'the plan process was killed');
    // Its record stays `running` under the dead host: the next live host reaps it `errored` (D6).
    const runsDir = path.join(h.expRoot, exp3, 'runs');
    const records = fs
      .readdirSync(runsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8')));
    assert.deepEqual(
      records.map((r) => [r.kind, r.t]),
      [['command', 'running']]
    );
  }
);

// ---- 5 ----

test(
  'flag off over that directory: read-only rows and views, nothing written, replies not consumed',
  { timeout: 180_000 },
  async () => {
    // A torn last line (an append cut off): a reader leaves it on disk.
    const log1 = path.join(h.expRoot, exp1, 'log.jsonl');
    fs.appendFileSync(log1, '{"t":"owner","at":');
    const disk = snapshot(h.expRoot);
    await h.boot('off-B');

    const listed = await rows();
    assert.equal(listed.length, 3);
    assert.equal(listed.find((r) => r.id === exp1)?.status.t, 'finished');
    const v1 = await view(exp1);
    assert.ok(v1.faults.some((f) => /last line is incomplete/.test(f.what)));
    // Nothing reaped the command a dead host left running: no host is open.
    const v3 = await view(exp3);
    assert.equal(lane(v3, 'slow')?.status, 'running');
    for (const [route, body] of MUTATIONS(exp3)) {
      const r = await post(route, body);
      assert.equal(r.status, 503, `${route}: ${JSON.stringify(r.body)}`);
    }

    // An owner reply in an expedition's thread is not consumed: it is ordinary talk to the leader.
    const book = JSON.parse(fs.readFileSync(path.join(h.expRoot, exp1, 'owner.json'), 'utf8'));
    assert.equal(book.thread.t, 'posted');
    const leaderRuns = (await h.runsOf(lead)).length;
    const talk: Post = await h.reply(dm, book.thread.rootId, 'Hello there.', 'o-off');
    assert.notEqual(talk.purpose, 'host_command');
    await h.eventually(
      () => h.runsOf(lead),
      (runs) => runs.length === leaderRuns + 1,
      'the reply woke the leader as any DM reply does'
    );

    assert.deepEqual(snapshot(h.expRoot), disk, 'nothing under expeditions-v1 changed');
    await h.stop();
  }
);

// ---- 6 ----

test(
  'the copied-store case (flag on, execution disabled): launch refused, nothing opened or run',
  { timeout: 180_000 },
  async () => {
    const disk = snapshot(h.expRoot);
    await h.boot('copied', { ...ON, UNLEASHD_BUDDY_EXECUTION: '0' });
    const folder = planFolder({ plan: MAIN_PLAN, briefs: { work: answers('copied', 'answer') } });
    const refused = await post('/launch', { workspaceId: ws, folder });
    assert.equal(refused.status, 503);
    assert.match(refused.body.error, /Buddy execution is disabled/);
    assert.equal((await rows()).length, 3, 'read-only rows');
    assert.equal(lane(await view(exp3), 'slow')?.status, 'running', 'nothing reaped');
    assert.deepEqual(snapshot(h.expRoot), disk, 'nothing under expeditions-v1 changed');
    assert.equal(h.spawnsOf('copied'), 0);
    assert.deepEqual(processesNaming(fs.realpathSync(h.expRoot)), [], 'no plan process');
    await h.stop();
  }
);
