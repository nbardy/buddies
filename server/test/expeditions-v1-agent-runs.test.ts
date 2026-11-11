import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { keyed } from '@unleashd/shared';
import { toolsFor } from '../src/buddies/mcp';
import {
  type CallTurn,
  capabilitiesOf,
  grantsOf,
  limitsText,
} from '../src/expedition-kernel/access';
import { endingOf } from '../src/expedition-kernel/runs';
import { runPaths } from '../src/expeditions-v1/executor/address';
import { withPrompts } from '../src/expeditions-v1/executor/prompts';
import { Capabilities } from '../src/expeditions-v1/executor/records';
import { getRef } from '../src/expeditions-v1/executor/refs';
import { HASH, agentSpec, harness, runIdOf } from './fixtures/agent-runs';

// CONNECT_PLAN §8 step 4: agent calls and review judges as Buddy requests, through real
// boundaries. The REAL backend (server.ts) runs on temp stores with the executor inside it
// (fixtures/expedition-backend.ts), real Buddy runner, grants, MCP endpoint, turn policy, ingest
// and git; only the agent CLI (`claude`, and `codex` for the memory reviewer) is a fake. Restarts,
// stops and checkouts: expeditions-v1-agent-restarts.test.ts.

const h = harness('xk-agent-runs');

test('capability records from before scratch still parse without widening the old grant', () => {
  const common = { web: 'off', instructions: 'none', agents: 'off', schedule: 'off', mcp: 'none' };
  const read = { ...common, files: { t: 'read', roots: [] } };
  assert.deepEqual(Capabilities.parse(read), read);
  const write = {
    ...common,
    files: { t: 'write', dir: '/draft', reads: [], shell: 'off', git: { t: 'none' } },
  };
  assert.deepEqual(Capabilities.parse(write), { ...write, files: { ...write.files, temp: '' } });
});

test('prompt headers tell the truth for both harnesses and all four turn kinds', () => {
  const turns: CallTurn[] = [
    { t: 'call', work: '/work', reads: ['/inputs'], web: false },
    {
      t: 'checkout',
      tree: '/tree',
      reads: ['/inputs'],
      web: false,
      git: { t: 'none' },
      temp: '/private-temp/checkout',
    },
    { t: 'judge', reads: ['/code'] },
    {
      t: 'leader',
      expDir: '/expedition',
      draft: '/expedition/draft',
      temp: '/private-temp/leader',
    },
  ];
  for (const provider of ['claude', 'codex'])
    for (const turn of turns) {
      const header = limitsText(provider, capabilitiesOf(turn));
      for (const [name, enforcement] of Object.entries(grantsOf(provider, turn))) {
        assert.ok(header.includes(`- ${name}: ${enforcement.t}`), `${provider} ${turn.t} ${name}`);
        if (enforcement.t === 'advisory') assert.ok(header.includes(enforcement.reason));
      }
      if (provider === 'codex') {
        assert.doesNotMatch(header, /Shell: none|Instructions: none load/);
        if (turn.t === 'judge' || turn.t === 'call')
          assert.match(
            header,
            /a read-only shell is available for reading files; it cannot write and has no network/
          );
        assert.match(header, /NOT held: .*spawn_agent/);
      } else if (turn.t !== 'checkout')
        assert.doesNotMatch(header, /Shell available on this harness/);
      else assert.match(header, /command chains.*built-in safety checks/);
    }
});
let ws = '';
let named = '';
const EXP_A = '20261111T000000-aaaaaa';
const EXP_B = '20261111T000000-bbbbbb';

before(async () => {
  await h.boot('A');
  ws = await h.workspace();
  named = await h.hire(ws, 'namer');
  h.launchLog(EXP_A, ws, { claude: 4 });
  // A second expedition whose pools need more seat slots than the default 12.
  h.launchLog(EXP_B, ws, { claude: 15, codex: 5 });
});

after(async () => {
  await h.kill();
  for (const file of fs.readdirSync(h.fake('.')).filter((f) => f.endsWith('.pgid')))
    try {
      process.kill(-Number(h.read(file)), 'SIGKILL');
    } catch {}
});

const brief = (tag: string, mode: string, answer = '{"n":7}') =>
  `Do the thing. TAG:${tag} MODE:${mode} ANSWER_JSON:${answer}`;
const expDir = (exp: string) => path.join(h.expRoot, exp);

/** What the fake CLI was spawned with, read as the limits a turn ran under (claude flags). */
const argvOf = (tag: string): string[] => JSON.parse(h.read(`${tag}.argv`));
const flagOf = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];
const limitsOf = (argv: string[]) => {
  const settings = JSON.parse(flagOf(argv, '--settings') as string);
  return {
    mode: flagOf(argv, '--permission-mode'),
    sources: flagOf(argv, '--setting-sources'),
    tools: flagOf(argv, '--tools'),
    addDirs: argv.flatMap((a, i) => (a === '--add-dir' ? [argv[i + 1]] : [])),
    allow: settings.permissions.allow,
    sandbox: settings.sandbox?.enabled === true,
    bypass: argv.includes('--dangerously-skip-permissions'),
    mcp: argv.includes('--mcp-config'),
  };
};

test('a seat call and a named-Buddy call answer with a typed value; one seat Buddy per workspace', {
  timeout: 240_000,
}, async () => {
  const seatA = runIdOf(EXP_A, 'p/seat/one', 'a');
  const seatB = runIdOf(EXP_B, 'p/seat/two', 'b');
  const byName = runIdOf(EXP_A, 'p/named/one', 'c');
  await Promise.all([
    h.start(seatA, agentSpec('p/seat/one', brief('seatone', 'answer', '{"n":1}'))),
    h.start(seatB, agentSpec('p/seat/two', brief('seattwo', 'answer', '{"n":2}'))),
    h.start(
      byName,
      agentSpec('p/named/one', brief('namedone', 'answer', '{"n":3}'), {
        by: { t: 'buddy', id: named },
      })
    ),
  ]);
  // A repeated start is a no-op (one record, one post, one run).
  await h.start(seatA, agentSpec('p/seat/one', brief('seatone', 'answer', '{"n":1}')));

  for (const [runId, exp, n, tag, key, letter] of [
    [seatA, EXP_A, 1, 'seatone', 'p/seat/one', 'a'],
    [seatB, EXP_B, 2, 'seattwo', 'p/seat/two', 'b'],
    [byName, EXP_A, 3, 'namedone', 'p/named/one', 'c'],
  ] as const) {
    const reports = await h.settledOf(runId);
    assert.equal(reports.length, 1, `${runId} is reported once`);
    const [report] = reports;
    assert.deepEqual(report?.raw, { t: 'ok', out: { n } });
    assert.equal(
      report?.refAtReport,
      true,
      'the ref and its answer file exist when ok is reported'
    );
    const ref = await getRef(expDir(exp), keyed.refOf(key, HASH(letter)));
    assert.equal(ref.t, 'found');
    if (ref.t === 'found') {
      assert.deepEqual(JSON.parse(fs.readFileSync(ref.value.answerPath, 'utf8')), { n });
      assert.equal(ref.value.commit, h.base, 'a tree-less call is at its base');
      assert.equal(ref.value.conversation.t, 'conversation');
    }
    // Its turn ran in the call's own directory, never the owner's checkout, with no tools.
    const cwd = fs.realpathSync(h.read(`${tag}.cwd`));
    assert.ok(cwd.startsWith(fs.realpathSync(expDir(exp))), `${tag} ran in ${cwd}`);
    assert.notEqual(cwd, fs.realpathSync(h.repo));
    assert.deepEqual(JSON.parse(h.read(`${tag}.tools`)), [], 'a call turn is shown no tools');
    assert.equal(h.spawnsOf(tag), 1);
    // Nothing priced it (no transcript): the kernel charges the reservation.
    assert.deepEqual(report?.spent, { t: 'unreported' });
  }

  const seats = (await h.buddies(ws)).filter((b) => b.slug === 'expedition-seat');
  assert.equal(seats.length, 1, 'two expeditions in one workspace share one seat Buddy');
  assert.equal(seats[0]?.maxActiveRuns, 20, "the seat grew to the larger expedition's Σ pools");
  const recordA = await h.record(seatA);
  const recordN = await h.record(byName);
  assert.ok(recordA.t === 'found' && recordA.value.t === 'settled');
  // The named call ran as the named Buddy, on its profile; the seat call on its config.
  const namedRuns = await h.runsOf(named);
  assert.equal(namedRuns.filter((r) => r.input.kind === 'post').length, 1);
  assert.ok(recordN.t === 'found');
  const seatRuns = await h.runsOf(seats[0]?.id as string);
  assert.equal(seatRuns.length, 2, 'one crate run per seat call, the repeated start included');

  // providerOf answers for a named Buddy from its profile.
  assert.deepEqual(await h.provider({ t: 'buddy', id: named }), {
    t: 'known',
    provider: 'claude',
  });
});

test('the posted answer is the final message, excluding a progress message with an earlier JSON fence', {
  timeout: 240_000,
}, async () => {
  const id = runIdOf(EXP_A, 'p/final/one', 'f');
  await h.start(id, agentSpec('p/final/one', brief('finalonly', 'finalonly', '{"n":7}')));
  assert.deepEqual((await h.settledOf(id))[0]?.raw, { t: 'ok', out: { n: 7 } });
});

test('a malformed answer errors before any ref is written; a review that says no is a judged failure', {
  timeout: 240_000,
}, async () => {
  const bad = runIdOf(EXP_A, 'p/bad/one', 'd');
  await h.start(
    bad,
    agentSpec('p/bad/one', 'Answer badly. TAG:badone MODE:malformed', { tree: 'checkout' })
  );
  const [report] = await h.settledOf(bad);
  assert.equal(report?.raw.t, 'errored');
  assert.match(report?.raw.t === 'errored' ? report.raw.why : '', /^malformed answer: not JSON/);
  const temp = JSON.parse(h.read('badone.temp')) as { dir: string };
  assert.ok(!fs.existsSync(temp.dir), 'failed answer removes private scratch');
  const ref = keyed.refOf('p/bad/one', HASH('d'));
  assert.equal((await getRef(expDir(EXP_A), ref)).t, 'missing', 'nothing stored to judge');

  // A producer, then its review judge on what it stored.
  const producer = runIdOf(EXP_A, 'p/judged/one', 'e');
  await h.start(producer, agentSpec('p/judged/one', brief('judgedone', 'answer', '{"n":5}')));
  const [produced] = await h.settledOf(producer);
  assert.deepEqual(produced?.raw, { t: 'ok', out: { n: 5 } });
  const of = keyed.refOf('p/judged/one', HASH('e'));
  const judge = runIdOf(EXP_A, 'p/judged/one', 'e', 'judge');
  await h.start(judge, {
    t: 'review',
    by: { t: 'seat', provider: 'claude', model: 'claude-haiku-5-5', effort: 'low' },
    brief: `Is n even? TAG:judgeone MODE:answer ANSWER_JSON:{"verdict":"no","why":"n is 5, odd"}`,
    of,
    max: { usd: 5, minutes: 10 },
  });
  const [verdict] = await h.settledOf(judge);
  assert.deepEqual(verdict?.raw, { t: 'no', why: 'n is 5, odd' });
  // The judge's brief named the producer's stored answer.
  const judgeRecord = await h.record(judge);
  const producerRef = await getRef(expDir(EXP_A), of);
  assert.ok(producerRef.t === 'found');
  assert.ok(judgeRecord.t === 'found' && judgeRecord.value.t === 'settled');
  // What the kernel makes of that report for a judged call: `failed`, its output kept.
  const ending = endingOf('judged-agent', {
    ref: of,
    raw: verdict?.raw as never,
    spent: { t: 'unreported' },
    cancelling: false,
    stage: {
      t: 'judging',
      ref: of,
      out: { n: 5 },
      judgeRunId: judge,
      spent: { t: 'unreported' },
    },
  });
  assert.deepEqual(ending, {
    t: 'settle',
    outcome: { t: 'failed', ref: of, out: { n: 5 }, why: 'n is 5, odd' },
    spent: { t: 'unreported' },
  });
});

test('no memory review follows a call turn; one still follows a normal turn, whose tools are unchanged', {
  timeout: 240_000,
}, async () => {
  // `named` ran a call turn in the first test. Now an ordinary owner request to it.
  const asked = await h.ask(named, brief('normalone', 'answer', '{"n":0}'), 'normal-one');
  const reviews = await h.eventually(
    () => h.reviews(named),
    (r) => r.length > 0,
    'the normal turn to be reviewed'
  );
  // The reviewer runs one review at a time, in order: a review queued after the earlier call
  // turn would have finished first. Exactly one, and it is the normal turn's.
  const normalRun = (await h.runsOf(named)).find((r) => r.input.postId === asked.id);
  assert.equal(reviews.length, 1, JSON.stringify(reviews));
  assert.equal(reviews[0]?.conversationId, normalRun?.conversationId);
  const seat = (await h.buddies(ws)).find((b) => b.slug === 'expedition-seat');
  assert.deepEqual(await h.reviews(seat?.id as string), [], 'no review of any seat call');
  assert.deepEqual(
    JSON.parse(h.read('normalone.tools')),
    Object.keys(toolsFor('worker')),
    "a normal Buddy turn's tool list is unchanged"
  );
  // ...and so is its command line: the bypass, the one MCP server and the steering hooks exactly
  // as before capability sets (agent-cli pins the full argv of a request without one), and none
  // of a call's limits.
  const normal = argvOf('normalone'); // argv after the binary
  assert.equal(normal[0], '--dangerously-skip-permissions');
  assert.deepEqual(normal.slice(normal.indexOf('-p'), normal.indexOf('--settings')), [
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--permission-mode',
    'bypassPermissions',
    '--tools',
    'default',
    '--add-dir',
    h.repo,
  ]);
  assert.deepEqual(Object.keys(JSON.parse(flagOf(normal, '--settings') as string)), [
    'autoMemoryEnabled',
    'hooks',
  ]);
  assert.deepEqual(normal.slice(-3, -1), ['--strict-mcp-config', '--mcp-config']);
  for (const limit of ['dontAsk', '--setting-sources', '--disable-slash-commands'])
    assert.ok(!normal.includes(limit), `an ordinary turn has no ${limit}`);
});

test('each expedition turn kind spawns with its limits; its exact prompt is kept before the post', {
  timeout: 240_000,
}, async () => {
  // CONNECT_PLAN §10 F1/F2/F4. Before: a call ran `--tools default`, bypassed permissions and
  // loaded the owner's global CLAUDE.md; its prompt was kept only in a provider transcript.
  const refs = path.join(expDir(EXP_A), 'refs');
  const docs = path.join(h.repo, 'docs');
  const input = keyed.refOf('p/seat/one', HASH('a')); // stored by the first test
  const call = runIdOf(EXP_A, 'p/limits/call', '3');
  const checkout = runIdOf(EXP_A, 'p/limits/checkout', '4');
  await Promise.all([
    h.start(
      call,
      agentSpec('p/limits/call', brief('limcall', 'answer', '{"n":3}'), {
        grant: { reads: ['docs'], web: true },
        inputs: [{ t: 'ref', ref: input }],
      })
    ),
    h.start(
      checkout,
      agentSpec('p/limits/checkout', brief('limcheckout', 'answer', '{"n":4}'), {
        tree: 'checkout',
      })
    ),
  ]);
  for (const id of [call, checkout])
    assert.equal((await h.settledOf(id))[0]?.raw.t, 'ok', `${id} answered`);
  const judge = runIdOf(EXP_A, 'p/limits/call', '3', 'judge');
  await h.start(judge, {
    t: 'review',
    by: { t: 'seat', provider: 'claude', model: 'claude-haiku-5-5', effort: 'low' },
    brief: 'Is it fine? TAG:limjudge MODE:answer ANSWER_JSON:{"verdict":"yes","why":"fine"}',
    of: keyed.refOf('p/limits/call', HASH('3')),
    max: { usd: 5, minutes: 10 },
  });
  assert.equal((await h.settledOf(judge))[0]?.raw.t, 'ok');

  // A tree-less call: reads its input's directory and its grant (relative to the repo), web on,
  // writes nothing, no shell, no user or project instructions, no MCP server, no bypass.
  assert.deepEqual(limitsOf(argvOf('limcall')), {
    mode: 'dontAsk',
    sources: '',
    tools: 'Read,Grep,Glob,WebSearch,WebFetch',
    addDirs: [refs, docs],
    allow: ['WebSearch', 'WebFetch'],
    sandbox: false,
    bypass: false,
    mcp: false,
  });
  // A checkout call: read-write and a sandboxed shell in its worktree only, the repo's own
  // instructions, web off (not granted).
  // The worktree is released at settle; the harness root is already a realpath.
  assert.equal(h.read('limcheckout.cwd'), runPaths(expDir(EXP_A), checkout).tree);
  const inTree = limitsOf(argvOf('limcheckout'));
  assert.deepEqual(inTree, {
    mode: 'dontAsk',
    sources: 'project',
    tools: 'Read,Grep,Glob,Edit,Write,NotebookEdit,Bash',
    addDirs: [],
    allow: [`Edit(/${runPaths(expDir(EXP_A), checkout).tree}/**)`, 'Bash'],
    sandbox: true,
    bypass: false,
    mcp: false,
  });
  // A review judge: the judged output and what its producer could read; nothing else.
  assert.deepEqual(limitsOf(argvOf('limjudge')), {
    mode: 'dontAsk',
    sources: '',
    tools: 'Read,Grep,Glob',
    addDirs: [refs, docs],
    allow: [],
    sandbox: false,
    bypass: false,
    mcp: false,
  });
  // The limits are stated once, at the head of the prompt; the old advice is gone.
  const sent = h.read('limcall.prompt');
  assert.match(sent, /LIMITS \(the tools of this turn are set to these/);
  assert.doesNotMatch(sent, /ACCESS \(advisory\)|do not change it/);

  // F4: one prompt file per run id beside its record, holding exactly the posted body (which the
  // CLI received inside the request line), written before the post.
  for (const [runId, tag] of [
    [call, 'limcall'],
    [checkout, 'limcheckout'],
    [judge, 'limjudge'],
  ] as const) {
    const file = runPaths(expDir(EXP_A), runId).prompt;
    const kept = fs.readFileSync(file, 'utf8');
    assert.ok(kept.startsWith(`Expedition call ${runId} `), file);
    assert.ok(h.read(`${tag}.prompt`).includes(kept), `${tag} received the kept prompt`);
  }
  const seat = (await h.buddies(ws)).find((b) => b.slug === 'expedition-seat');
  const posts = (await h.runsOf(seat?.id as string)).flatMap((r) =>
    r.input.kind === 'post' ? [r.input.postId as string] : []
  );
  const keptBodies = new Map(
    [call, checkout, judge].map((id) => [
      fs.readFileSync(runPaths(expDir(EXP_A), id).prompt, 'utf8'),
      runPaths(expDir(EXP_A), id).prompt,
    ])
  );
  let matched = 0;
  for (const postId of posts) {
    const { body } = await h.http('GET', `/api/buddies/posts/${postId}/thread?limit=1`);
    const file = keptBodies.get(body.root.body);
    if (file === undefined) continue;
    matched += 1;
    assert.ok(
      fs.statSync(file).mtimeMs <= Date.parse(body.root.createdAt),
      `${file} was written before its post`
    );
  }
  assert.equal(matched, 3, 'each kept prompt is exactly a posted body');

  // The view's bar detail names them: the producer's and its judge's, at the paths written.
  const bar = (key: string, letter: string): keyed.Bar => ({
    key,
    hash: HASH(letter),
    kind: 'agent',
    attempt: 1,
    planVersion: 0,
    start: new Date().toISOString(),
    end: { t: 'open' },
    cost: { t: 'unknown' },
    prompts: [],
  });
  const view = withPrompts(h.expRoot, {
    id: EXP_A,
    lanes: [
      { key: 'p/limits/call', kind: 'agent', status: 'settled', bars: [bar('p/limits/call', '3')] },
      { key: 'p/never', kind: 'agent', status: 'declared', bars: [bar('p/never', '5')] },
    ],
  } as unknown as keyed.KeyedView);
  assert.deepEqual(
    view.lanes.map((l) => l.bars[0]?.prompts),
    [
      [
        { role: 'producer', path: runPaths(expDir(EXP_A), call).prompt },
        { role: 'judge', path: runPaths(expDir(EXP_A), judge).prompt },
      ],
      [],
    ]
  );
});

test('usage: a priced session is charged, an unpriceable one reports nothing, max.usd stops a call', {
  timeout: 240_000,
}, async () => {
  const priced = runIdOf(EXP_A, 'p/usage/one', 'f');
  const capped = runIdOf(EXP_A, 'p/usage/two', '1');
  await h.start(priced, agentSpec('p/usage/one', brief('usageone', 'usage')));
  await h.start(
    capped,
    agentSpec('p/usage/two', brief('usagetwo', 'usagehang'), { max: { usd: 1.5, minutes: 30 } })
  );
  const [paid] = await h.settledOf(priced);
  assert.deepEqual(paid?.raw, { t: 'ok', out: { n: 7 } });
  // 250k uncached input + 50k output on claude-opus-5-5 at $4 / $20 per 1M tokens.
  assert.equal(paid?.spent.t, 'reported');
  assert.ok(
    paid?.spent.t === 'reported' && Math.abs(paid.spent.usd - 2) < 1e-9,
    JSON.stringify(paid?.spent)
  );

  const [stopped] = await h.settledOf(capped);
  assert.equal(stopped?.raw.t, 'errored');
  assert.match(
    stopped?.raw.t === 'errored' ? stopped.raw.why : '',
    /^exceeded \$1\.5 \(spent \$2\.0000\)$/
  );
  assert.deepEqual(stopped?.spent, { t: 'reported', usd: 2 });
  const record = await h.record(capped);
  assert.ok(record.t === 'found' && record.value.t === 'settled');
  assert.deepEqual(record.value.t === 'settled' && record.value.stop, {
    t: 'usd',
    usd: 1.5,
    spent: 2,
  });
});

test("the owner's cancel and a Buddy's runs cancel/retry are refused for a call; its own cancel ends it", {
  timeout: 240_000,
}, async () => {
  const target = runIdOf(EXP_A, 'p/target/one', '2');
  await h.start(target, agentSpec('p/target/one', brief('targetone', 'hang')));
  await h.eventually(() => h.exists('targetone.midturn'), Boolean, 'the call mid-turn');
  const posted = await h.eventually(
    () => h.record(target),
    (r) => r.t === 'found' && r.value.t === 'posted' && r.value.crateRunIds.length === 1,
    'the call run to be seen'
  );
  const crateRun =
    posted.t === 'found' && posted.value.t === 'posted' ? posted.value.crateRunIds[0] : '';

  const refused = await h.http('POST', `/api/buddies/runs/${crateRun}/cancel`);
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /is an expedition call; cancel it from its expedition/);

  fs.writeFileSync(h.fake('refuse.target'), crateRun as string);
  await h.ask(named, 'Try it. TAG:refuser MODE:refuse', 'refuse-one');
  await h.eventually(() => h.exists('refuser.refused'), Boolean, 'the refuser to try');
  const [cancel, retry] = JSON.parse(h.read('refuser.refused')) as Array<{
    isError: boolean;
    content: Array<{ text: string }>;
  }>;
  assert.equal(cancel?.isError, true);
  assert.match(cancel?.content[0]?.text ?? '', /\[denied\].*expedition call; cancel it/);
  assert.equal(retry?.isError, true);
  assert.match(retry?.content[0]?.text ?? '', /\[denied\].*expedition call; retry it/);
  const still = await h.http('GET', `/api/buddies/runs/${crateRun}`);
  assert.equal(still.body.status, 'running', 'the refused actions changed nothing');

  // The executor's own cancel stops the running turn; the call ends cancelled, its partial
  // work stored (no answer, the base commit).
  await h.cancel(target);
  const [ended] = await h.settledOf(target);
  assert.deepEqual(ended?.raw, { t: 'cancelled' });
  const partial = await getRef(expDir(EXP_A), keyed.refOf('p/target/one', HASH('2')));
  assert.ok(partial.t === 'found');
  assert.equal(partial.t === 'found' && partial.value.out, null);
  const run = await h.http('GET', `/api/buddies/runs/${crateRun}`);
  assert.equal(run.body.status, 'cancelled');
});
