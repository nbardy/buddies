import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { keyed } from '@unleashd/shared';
import { fold, liveCalls, step } from '../src/expedition-kernel/core';
import { type Expedition, type KernelDeps, launch, open } from '../src/expedition-kernel/kernel';
import type { RawOutcome } from '../src/expedition-kernel/ports';
import {
  type Policy,
  type Run,
  ScriptedClock,
  ScriptedExecutor,
  ScriptedLeader,
  ScriptedOwner,
  Signal,
  type WakeScript,
  attemptOfRun,
  cont,
  keyOfRun,
  reported,
  roleOfRun,
} from './fixtures/expedition-ports';
import { tempDir } from './fixtures/temp';

// The expedition kernel end to end (docs/expeditions/keyed/v1/DESIGN.md, gtm/rewrite/REWRITE.md):
// real plan child processes, real log files in temp dirs, the real typecheck gate and the real GTM
// fixture plans. Only the Executor, Leader, Owner and Clock are scripted (fixtures/expedition-ports.ts):
// the agent CLIs are the hard external boundary.

const REPO = path.resolve(__dirname, '../..');
const FIXTURES = path.join(__dirname, 'fixtures', 'expedition-plans');
const GATES = {
  zodEntry: path.join(REPO, 'server/node_modules/zod'),
  tscBin: path.join(REPO, 'server/node_modules/.bin/tsc'),
};
const T0 = Date.parse('2026-11-10T09:00:00.000Z');
const MIN = 60_000;
const REPORT = { summary: 'done', files: [] };
const ok = (out: unknown): RawOutcome => ({ t: 'ok', out });

type Org = { id: string; name: string; segment: 'rl-data' | 'design-partner'; kind: string };
const org = (id: string, kind: 'direct' | 'substitute' | 'comparator'): Org => ({
  id,
  name: id,
  segment: 'rl-data',
  kind,
});

/** Copy one plan file, optionally editing its owner literal or plan code. */
function fixture(
  name: string,
  edit: { contract?: (source: string) => string; plan?: (source: string) => string } = {}
): string {
  const file = path.join(tempDir('expedition-file-'), `${path.basename(name)}.expedition.ts`);
  let source = readFileSync(path.join(FIXTURES, `${name}.expedition.ts`), 'utf8');
  if (edit.contract) source = edit.contract(source);
  if (edit.plan) source = edit.plan(source);
  writeFileSync(file, source);
  return file;
}

type World = {
  signal: Signal;
  ex: ScriptedExecutor;
  leader: ScriptedLeader;
  owner: ScriptedOwner;
  clock: ScriptedClock;
  deps: KernelDeps;
  root: string;
};
function world(policy: Policy, script: WakeScript): World {
  const signal = new Signal();
  const ex = new ScriptedExecutor(signal, policy);
  const leader = new ScriptedLeader(signal, script);
  const owner = new ScriptedOwner(() => true);
  const clock = new ScriptedClock(T0);
  const deps: KernelDeps = {
    executor: ex,
    leader,
    owner,
    clock,
    providerOf: (who) =>
      who.t === 'buddy' && (who.id === 'market-research' || who.id === 'lead')
        ? { t: 'known', provider: 'claude' }
        : { t: 'unknown', why: `no buddy ${JSON.stringify(who)}` },
    gates: GATES,
  };
  return { signal, ex, leader, owner, clock, deps, root: tempDir('expedition-root-') };
}

/** Kernels a test opened: detached after each test, so a failure leaves no plan process. */
const opened = new Set<Expedition>();
afterEach(async () => {
  for (const e of opened) await e.detach().catch(() => {});
  opened.clear();
});

/** Every append pokes the signal, and is checked against I2 as it lands. */
function watch(w: World, e: Expedition): Expedition {
  opened.add(e);
  w.signal.context = () =>
    JSON.stringify(
      {
        faults: e.view().faults,
        leader: w.leader.events,
        tail: e
          .entries()
          .slice(-6)
          .map((x) => [x.t, 'key' in x ? x.key : x.t === 'declared' ? x.call.key : '']),
      },
      null,
      1
    ).slice(0, 6000);
  e.subscribe((_entry, s) => {
    assert.ok(
      s.spentUsd + s.reservedUsd <= s.contract.budget.usd + 1e-9,
      `I2 broken at ${_entry.t}`
    );
    w.signal.poke();
  });
  return e;
}
async function launched(w: World, file: string): Promise<Expedition> {
  const r = await launch(w.deps, w.root, file, 'base0', { t: 'none' });
  if (r.t !== 'launched') throw new Error(`launch rejected at ${r.gate}: ${r.issues.join('\n')}`);
  return watch(w, r.expedition);
}
/** The finish, or a timeout that says what the kernel was doing. */
async function finishedOf(w: World, e: Expedition): Promise<keyed.Finish> {
  await w.signal.until(() => e.state().progress.t === 'finished', 'the expedition finishes');
  return e.finished;
}
async function reopen(w: World, dir: string): Promise<Expedition> {
  return watch(w, (await open(w.deps, dir)).expedition);
}

/** The durable log, parsed. */
const logOf = (dir: string): keyed.Entry[] =>
  readFileSync(path.join(dir, 'log.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => keyed.Entry.parse(JSON.parse(l)));
/** I2 at every prefix of the durable log, folded the way a restart would. */
function assertBudgetAtEveryAppend(dir: string): void {
  const log = logOf(dir);
  let s = fold(log.slice(0, 1));
  log.slice(1).forEach((e, i) => {
    s = step(s, e, i + 1);
    assert.ok(
      s.spentUsd + s.reservedUsd <= s.contract.budget.usd + 1e-9,
      `I2 at entry ${i + 1} (${e.t})`
    );
  });
}
/** I1 where it costs money: the executor created every run id at most once. */
function assertEachRunCreatedOnce(ex: ScriptedExecutor): void {
  for (const [id, n] of ex.created) assert.equal(n, 1, `${id} was created ${n} times`);
}
const createdFor = (ex: ScriptedExecutor, key: string, role: 'producer' | 'judge') =>
  [...ex.created.keys()].filter((id) => keyOfRun(id) === key && roleOfRun(id) === role);

const isAgent = (key: string) => (r: Run) => r.spec.t === 'agent' && r.spec.call.key === key;
const agentRunning = (ex: ScriptedExecutor, prefix: string) =>
  ex.running((r) => r.spec.t === 'agent' && r.spec.call.key.startsWith(prefix));
const settledOf = (e: Expedition, key: string) =>
  e
    .entries()
    .filter((x): x is Extract<keyed.Entry, { t: 'settled' }> => x.t === 'settled' && x.key === key);
const outcomeOf = (e: Expedition, key: string) => settledOf(e, key).at(-1)?.outcome.t;

/** The GTM executor: the scope lists `orgs`; every other agent answers a report; judges pass. */
function gtmPolicy(
  orgs: readonly Org[],
  over: (run: Run) => ReturnType<Policy> | 'default' = () => 'default'
): Policy {
  return (run) => {
    const o = over(run);
    if (o !== 'default') return o;
    const s = run.spec;
    const spend = (usd: number): keyed.Usage => reported(usd);
    if (s.t === 'agent')
      return s.call.key === 'scope/scope'
        ? { raw: ok(orgs), spent: spend(s.call.max.usd) }
        : { raw: ok(REPORT), spent: spend(s.call.max.usd / 2) };
    if (s.t === 'check') return { raw: ok({}), spent: spend(0) };
    if (s.t === 'review') return { raw: ok({}), spent: spend(0.5) };
    return 'hold';
  };
}
const leaderFor =
  (on: Partial<Record<keyed.WakeEvent['t'], WakeScript>>): WakeScript =>
  (event, view) => {
    const handler = on[event.t];
    if (!handler) throw new Error(`unexpected wake ${JSON.stringify(event)}`);
    return handler(event, view);
  };
const withContract = (edit: (md: string) => string) => ({ contract: edit });

describe('expedition kernel end to end', () => {
  test('an owner stop during replay closes a queued host wake without a post-finish declaration', async () => {
    const w = world(
      () => 'hold',
      () => new Promise(() => {})
    );
    const e = await launched(w, fixture('need-gap'));
    await w.signal.until(() => w.ex.running().length === 1, 'the initial call starts');
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let replaying!: () => void;
    const replay = new Promise<void>((r) => {
      replaying = r;
    });
    const queue = e.serial(async () => {
      e.restartPlan(e.version());
      replaying();
      await held;
    });
    await replay;
    // Exactly the run-3 stack: a hostCall enqueues request/consider after stop has queued.
    // The serialized order is fixed, independently of when the child process answers replay.
    const stop = e.stop();
    let delivery: unknown;
    const late = e
      .hostCall(() => ({
        t: 'leader',
        key: 'leader/late',
        event: { t: 'review', question: 'late replay' },
        max: { usd: 1, minutes: 1 },
      }))
      .then((d) => {
        delivery = d;
      });
    release();
    await queue;
    await stop;
    await e.serial(() => {});
    assert.deepEqual(e.view().faults, []);
    await late;
    assert.deepEqual(delivery, { t: 'closed', reason: { t: 'stopped', by: 'owner' } });
    assert.equal(e.entries().at(-1)?.t, 'finished');
    assert.ok(
      !e.entries().some((entry) => entry.t === 'declared' && entry.call.key === 'leader/late')
    );
  });

  for (const raw of [
    { t: 'no', why: 'test failed' },
    { t: 'errored', why: 'harness failed' },
  ] as const) {
    test(`a ${raw.t === 'no' ? 'failed' : 'errored'} call returns to the running plan and wakes the leader only at its review`, async () => {
      const w = world(
        () => 'hold',
        (event) => {
          assert.equal(event.t, 'review');
          return { act: { t: 'stop', why: 'review reached' }, spent: reported(0) };
        }
      );
      const file = fixture('need-gap', {
        plan: (s) =>
          s
            .replace(
              'brief: `Do the work for probe.`,',
              'brief: `Do the work for probe.`, judge:{check:"node scripts/check.js"},'
            )
            .replace(
              /plan: async \(\{ probe \}(?:, x)?\) => await probe\(\),/,
              `plan: async ({probe},x) => {
            const result=await probe.try();
            await x.ask('The plan handled '+result.t+'; continue to checkin?');
            await x.checkin('planned reflection');
            if(result.t !== 'passed') throw new Error('The probe found nothing.');
            return result;
          },`
            ),
      });
      const e = await launched(w, file);
      await w.signal.until(() => w.ex.running(isAgent('probe')).length === 1, 'probe starts');
      w.ex.end(
        w.ex.running(isAgent('probe'))[0].runId,
        raw.t === 'no' ? ok(REPORT) : raw,
        reported(0)
      );
      if (raw.t === 'no') {
        await w.signal.until(
          () => w.ex.running((r) => r.spec.t === 'check').length === 1,
          'the probe judge starts'
        );
        w.ex.end(w.ex.running((r) => r.spec.t === 'check')[0].runId, raw, reported(0));
      }
      await w.signal.until(
        () => w.ex.running((r) => r.spec.t === 'ask').length === 1,
        'plan handles the failure itself'
      );
      assert.deepEqual(w.leader.events, []);
      const ask = w.ex.running((r) => r.spec.t === 'ask')[0];
      assert.ok(
        ask.spec.t === 'ask' &&
          ask.spec.call.question.includes(raw.t === 'no' ? 'failed' : 'errored')
      );
      w.ex.end(ask.runId, ok('yes'), reported(0));
      assert.equal((await finishedOf(w, e)).t, 'not-met');
      assert.deepEqual(w.leader.events, [{ t: 'review', question: 'planned reflection' }]);
    });
  }

  test('GTM v0 runs to `finished: met`: done is the host’s, the owner criterion is an ask', async () => {
    const orgs = [
      org('taskus', 'direct'),
      org('psi', 'substitute'),
      org('appen', 'comparator'),
      org('labelbox', 'comparator'),
    ];
    const w = world(gtmPolicy(orgs), leaderFor({ review: () => cont, 'budget-mark': () => cont }));
    const e = await launched(w, fixture('gtm'));
    await w.signal.until(
      () => w.ex.running((r) => r.spec.t === 'ask').length === 1,
      'the owner is asked'
    );
    const [askRun] = w.ex.running((r) => r.spec.t === 'ask');
    assert.ok(askRun && askRun.spec.t === 'ask');
    const candidate = settledOf(e, 'packet/packet')[0]?.outcome;
    assert.equal(candidate?.t, 'passed');
    const ref = candidate?.t === 'passed' ? candidate.ref : '';
    // The owner criterion holds nothing: an ask, confirming this candidate.
    assert.equal(askRun.spec.call.answer, 'confirm');
    assert.match(askRun.spec.call.question, /Do you accept the packet/);
    assert.ok(askRun.spec.call.question.includes(ref));
    // The host ran the done check and review itself, on the candidate.
    // (The packet's own judge is the same audit command on the same output; it is packet's run.)
    const doneRun = (key: string) => w.ex.find((r) => keyOfRun(r.runId) === key)[0]?.spec;
    assert.deepEqual(doneRun('done/0'), {
      t: 'check',
      command: 'python tools/gtm/audit_ledger.py business/research/2026-11-10_gtm',
      of: ref,
      maxMinutes: 20,
    });
    const review = doneRun('done/1');
    assert.equal(review?.t === 'review' && review.of, ref);
    assert.equal(e.state().progress.t, 'open', 'not finished before the owner answers');
    w.ex.end(askRun.runId, ok(true), reported(0));
    assert.deepEqual(await finishedOf(w, e), { t: 'met', candidate: ref });
    // Each wake runs under the run id its `started` entry logged: that id is what a real leader
    // turn is keyed and closed by, so a wake re-issued after a restart cannot start a second turn.
    const wakeStarts = e
      .entries()
      .flatMap((x) => (x.t === 'started' && x.key.startsWith('leader/') ? [x.runId] : []));
    assert.ok(wakeStarts.length > 0, 'the GTM run wakes the leader at its reviews');
    assert.deepEqual(w.leader.runIds, wakeStarts);

    const declared = new Set(e.entries().flatMap((x) => (x.t === 'declared' ? [x.call.key] : [])));
    const barKeys = new Set(e.timeline().bars.map((b) => b.key));
    for (const key of declared) assert.ok(barKeys.has(key), `${key} is not in the timeline`);
    for (const key of [
      'scope/scope',
      'collect/collect/psi',
      'synthesize/thesis',
      'duel/attack/3',
      'packet/packet',
      'done/0',
      'done/1',
      'done/2',
      'leader/1',
    ])
      assert.ok(barKeys.has(key), key);
    assert.deepEqual(e.view().faults, []);
    assertEachRunCreatedOnce(w.ex);
    await e.detach();
    assertBudgetAtEveryAppend(e.dir);
  });

  test('a pool of 3 queues a 10-wide fan-out: never more than 3 collects at once, all 10 run', async () => {
    const orgs = Array.from({ length: 10 }, (_, i) => org(`org${i}`, 'direct'));
    const w = world(
      gtmPolicy(orgs, (r) => (isCollect(r) ? 'hold' : 'default')),
      leaderFor({ 'budget-mark': () => cont })
    );
    let most = 0;
    const e = await launched(
      w,
      fixture(
        'gtm',
        withContract((md) => md.replace('claude: 6', 'claude: 3'))
      )
    );
    e.subscribe((_x, s) => {
      most = Math.max(most, liveCalls(s).filter((c) => c.key.startsWith('collect/')).length);
    });
    for (let done = 0; done < 10; done++) {
      await w.signal.until(
        () => agentRunning(w.ex, 'collect/').length === Math.min(3, 10 - done),
        `collect ${done}`
      );
      assert.ok(agentRunning(w.ex, 'collect/').length <= 3);
      const [next] = agentRunning(w.ex, 'collect/');
      if (next) w.ex.end(next.runId, ok(REPORT), reported(1));
    }
    await w.signal.until(
      () => orgs.every((o) => settledOf(e, `collect/collect/${o.id}`).length === 1),
      'all collects settle'
    );
    assert.ok(most <= 3, `${most} collect calls held the pool at once`);
    assert.equal(most, 3);
    for (const o of orgs)
      assert.equal(createdFor(w.ex, `collect/collect/${o.id}`, 'producer').length, 1);
    assertEachRunCreatedOnce(w.ex);
    await e.detach();
    assertBudgetAtEveryAppend(e.dir);
  });

  test('crash and reopen mid-collect: no run starts twice, running calls re-attach, a logged start the executor never got is issued once', async () => {
    const orgs = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => org(id, 'direct'));
    const w = world(
      gtmPolicy(orgs, (r) => (isCollect(r) ? 'hold' : 'default')),
      leaderFor({ review: () => new Promise(() => {}), 'budget-mark': () => cont })
    );
    const e1 = await launched(w, fixture('gtm'));
    await w.signal.until(
      () => agentRunning(w.ex, 'collect/').length === 6,
      'six collects run (pool 6)'
    );
    const collectRun = (id: string) => {
      const [r] = w.ex.find(isAgent(`collect/collect/${id}`));
      if (!r) throw new Error(`no run for ${id}`);
      return r;
    };
    // The next two collect starts (g, h) reach the executor's door and wait there.
    w.ex.holdNext((s) => s.t === 'agent', 2);
    w.ex.end(collectRun('a').runId, ok(REPORT), reported(1));
    w.ex.end(collectRun('b').runId, ok(REPORT), reported(1));
    await w.signal.until(() => w.ex.limbo.length === 2, 'g and h are logged started and in flight');
    const logged = (key: string) => e1.entries().some((x) => x.t === 'started' && x.key === key);
    assert.ok(
      logged('collect/collect/g') && logged('collect/collect/h'),
      'log first: started before the executor has them'
    );
    const [gStart, hStart] = w.ex.limbo.map((l) => l.runId);
    assert.ok(gStart && hStart);

    await e1.detach(); // the crash
    w.ex.end(collectRun('c').runId, ok(REPORT), reported(1)); // finishes while no host listens
    w.ex.lose(gStart); // g's start never arrives
    const before = new Map(w.ex.created);

    const e2 = await reopen(w, e1.dir);
    await w.signal.until(
      () => outcomeOf(e2, 'collect/collect/c') === 'passed',
      'c settles from the executor status'
    );
    await w.signal.until(
      () => w.ex.runs.has(gStart) && w.ex.runs.has(hStart),
      'g and h are re-issued'
    );
    w.ex.land(hStart); // h's first start arrives late: a no-op
    assert.equal(w.ex.idempotentNoops, 1);
    for (const id of ['a', 'b']) {
      assert.equal(settledOf(e2, `collect/collect/${id}`).length, 1);
      assert.equal(createdFor(w.ex, `collect/collect/${id}`, 'producer').length, 1, `${id} re-ran`);
    }
    for (const [id, n] of before)
      assert.equal(w.ex.created.get(id), n, `${id} started again at boot`);
    for (const id of ['d', 'e', 'f', 'g', 'h'])
      w.ex.end(collectRun(id).runId, ok(REPORT), reported(1));
    await w.signal.until(
      () => orgs.every((o) => outcomeOf(e2, `collect/collect/${o.id}`) === 'passed'),
      're-attached calls settle into the new log'
    );
    assert.equal(w.ex.startCalls.filter((id) => id === gStart).length, 2, 'g was asked for twice');
    assertEachRunCreatedOnce(w.ex);
    const startedIds = e2.entries().flatMap((x) => (x.t === 'started' ? [x.runId] : []));
    assert.equal(new Set(startedIds).size, startedIds.length, 'I1 in the log');
    await e2.detach();
    assertBudgetAtEveryAppend(e2.dir);
  });

  test('a start in limbo at a crash, reopened past the deadline, settles at $0 and its late arrival is a no-op', async () => {
    const orgs = ['a', 'b'].map((id) => org(id, 'direct'));
    const w = world(
      gtmPolicy(orgs, (r) => (isCollect(r) ? 'hold' : 'default')),
      leaderFor({ 'budget-mark': () => cont })
    );
    const e1 = await launched(
      w,
      fixture(
        'gtm',
        withContract((md) => md.replace('claude: 6', 'claude: 1'))
      )
    );
    await w.signal.until(() => agentRunning(w.ex, 'collect/').length === 1, 'a runs');
    w.ex.holdNext((s) => s.t === 'agent');
    const [a] = agentRunning(w.ex, 'collect/');
    assert.ok(a);
    w.ex.end(a.runId, ok(REPORT), reported(1));
    await w.signal.until(() => w.ex.limbo.length === 1, "b's start is in flight");
    const bStart = w.ex.limbo[0]?.runId as string;
    await e1.detach();
    w.clock.advance(9 * 60 * MIN); // past the 8 hour deadline
    const e2 = await reopen(w, e1.dir);
    const b = settledOf(e2, 'collect/collect/b')[0];
    assert.deepEqual(b?.outcome, { t: 'refused', reason: 'deadline' });
    assert.deepEqual(b?.spent, reported(0));
    await w.signal.until(() => w.ex.closed.has(bStart), "b's run id is closed");
    w.ex.land(bStart);
    assert.equal(w.ex.closedNoops, 1);
    assert.equal(w.ex.runs.has(bStart), false, 'a closed id never runs');
    await e2.detach();
    assertBudgetAtEveryAppend(e2.dir);
  });

  test('the REWRITE.md scenario: at the 50% wake the leader rewrites to gtm-rewrite; finish and cancel; nothing settled re-runs', async () => {
    const orgs = [
      org('taskus', 'direct'),
      org('psi', 'substitute'),
      org('periodic', 'substitute'),
      org('orca3d', 'direct'),
      org('cadence', 'substitute'),
      org('appen', 'comparator'),
      org('labelbox', 'comparator'),
      org('snorkel', 'comparator'),
    ];
    const v1 = fixture('gtm-rewrite', withContract(budget26));
    const w = world(
      gtmPolicy(orgs, (r) => {
        if (isCollect(r)) return 'hold';
        if (r.spec.t === 'agent' && r.spec.call.key.startsWith('mine/'))
          return { raw: ok(REPORT), spent: reported(1.5) };
        if (r.spec.t === 'check' && r.spec.of.startsWith('collect/collect/orca3d@'))
          return { raw: { t: 'no', why: 'quotes not found in page' }, spent: reported(0) };
        return 'default';
      }),
      leaderFor({
        'budget-mark': (event) =>
          event.t === 'budget-mark' && event.percent === 50
            ? {
                act: { t: 'rewrite', file: v1, why: 'vendor pages carry no buyer complaints' },
                spent: reported(0.1),
              }
            : cont,
        drained: () => cont,
        review: () => ({ act: { t: 'stop', why: 'enough for this test' }, spent: reported(0.1) }),
      })
    );
    w.leader.disposer = () => ({
      'collect/collect/labelbox': 'finish',
      'collect/collect/snorkel': 'cancel',
    });
    const e = await launched(w, fixture('gtm', withContract(budget26)));
    const run = (id: string) => w.ex.find(isAgent(`collect/collect/${id}`))[0] as Run;
    const passIn = async (id: string) => {
      w.ex.end(run(id).runId, ok(REPORT), reported(1.5));
      await w.signal.until(
        () => settledOf(e, `collect/collect/${id}`).length === 1,
        `${id} settles`
      );
    };
    await w.signal.until(() => agentRunning(w.ex, 'collect/').length === 6, 'six collects run');
    await passIn('taskus');
    await passIn('appen');
    await w.signal.until(
      () => !!run('labelbox') && !!run('snorkel'),
      'the last two comparators start'
    );
    await passIn('orca3d'); // its anchor check says no: failed
    await passIn('cadence'); // $8 + 4 × $1.50 = $14 of $26: past half
    await w.signal.until(
      () => e.entries().some((x) => x.t === 'plan' && x.version === 1),
      'the rewrite applies'
    );

    const plan1 = e
      .entries()
      .find((x): x is Extract<keyed.Entry, { t: 'plan' }> => x.t === 'plan' && x.version === 1);
    assert.ok(plan1);
    const sorted = (xs: readonly string[]) => [...xs].sort();
    assert.deepEqual(
      sorted(plan1.diff.reused),
      sorted([
        'scope/scope',
        'collect/collect/taskus',
        'collect/collect/orca3d',
        'collect/collect/cadence',
      ])
    );
    assert.deepEqual(
      sorted(plan1.diff.attached),
      sorted(['collect/collect/psi', 'collect/collect/periodic'])
    );
    assert.deepEqual(
      sorted(plan1.diff.dropped),
      sorted(['collect/collect/labelbox', 'collect/collect/snorkel'])
    );
    // The dry run stops at the first call it cannot answer: `mine` comes after the collects still
    // running, so its four calls are not in the diff (REWRITE.md §4 shows them; see the report).
    assert.deepEqual(plan1.diff.started, []);
    assert.deepEqual(plan1.dropped, {
      'collect/collect/labelbox': 'finish',
      'collect/collect/snorkel': 'cancel',
    });
    assert.equal(outcomeOf(e, 'collect/collect/orca3d'), 'failed');

    await w.signal.until(
      () => outcomeOf(e, 'collect/collect/snorkel') === 'cancelled',
      'snorkel is cancelled'
    );
    assert.deepEqual(w.ex.cancels, [run('snorkel').runId]);
    w.ex.end(run('labelbox').runId, ok(REPORT), reported(1.1)); // the drained call finishes
    await w.signal.until(
      () => outcomeOf(e, 'collect/collect/labelbox') === 'passed',
      'labelbox lands'
    );
    await w.signal.until(
      () => w.leader.events.some((x) => x.t === 'drained'),
      'the leader hears of it'
    );
    w.ex.end(run('psi').runId, ok(REPORT), reported(1.5));
    w.ex.end(run('periodic').runId, ok(REPORT), reported(1.5));
    assert.equal((await finishedOf(w, e)).t, 'not-met');

    for (const id of ['rl-forums', 'vendor-work', 'cfd-forums', 'naval-forums']) {
      assert.equal(outcomeOf(e, `mine/mine/${id}`), 'passed');
      assert.equal(createdFor(w.ex, `mine/mine/${id}`, 'producer').length, 1);
    }
    assert.deepEqual(
      w.leader.events.filter((x) => x.t === 'drained'),
      [{ t: 'drained', key: 'collect/collect/labelbox' }],
      'the drained call wakes the leader once'
    );
    for (const key of ['scope/scope', ...orgs.map((o) => `collect/collect/${o.id}`)])
      assert.equal(createdFor(w.ex, key, 'producer').length, 1, `${key} ran again`);
    assertEachRunCreatedOnce(w.ex);
    const plans = e.timeline().markers.filter((m) => m.t === 'plan');
    assert.deepEqual(
      plans.map((m) => (m.t === 'plan' ? [m.version, m.why] : [])),
      [
        [0, 'launch'],
        [1, 'vendor pages carry no buyer complaints'],
      ]
    );
    const bars = e.timeline().bars;
    assert.ok(bars.some((b) => b.key.startsWith('mine/') && b.planVersion === 1));
    assert.ok(
      bars.some(
        (b) => b.key === 'collect/collect/labelbox' && b.planVersion === 0 && b.end.t === 'settled'
      )
    );
    await e.detach();
    assertBudgetAtEveryAppend(e.dir);
  });

  // The contract now travels inside executable plan code. It still belongs to the owner:
  // evaluating a leader rewrite may not replace it. Guard: this real file -> IPC -> rules gate.
  test('a leader file whose evaluated contract changes the goal is rejected at the rules gate', async () => {
    const changed = fixture('ask-rewrite/v0', {
      contract: (s) =>
        s.replace(
          'Probe one thing, ask the owner which segment comes first, then follow up.',
          'A different owner goal.'
        ),
    });
    const w = world(
      () => 'hold',
      leaderFor({
        review: () => ({
          act: { t: 'rewrite', file: changed, why: 'change the goal' },
          spent: reported(0.1),
        }),
        rejected: () => cont,
      })
    );
    const e = await launched(w, fixture('ask-rewrite/v0'));
    await w.signal.until(
      () => w.leader.events.some((x) => x.t === 'rejected'),
      'contract change is rejected'
    );
    const rejection = w.leader.events.find((x) => x.t === 'rejected');
    assert.equal(rejection?.t, 'rejected');
    if (rejection?.t === 'rejected')
      assert.match(rejection.issues.join('; '), /rules:.*contract.*owner/);
    assert.equal(e.entries().filter((x) => x.t === 'plan').length, 1);
    assert.deepEqual(readdirSync(path.join(e.dir, 'plans')), ['v0.expedition.ts']);
    await e.detach();
  });

  test('a rewrite that fails a gate leaves the log and the plans directory byte-identical', async () => {
    const orgs = [
      org('taskus', 'direct'),
      org('psi', 'substitute'),
      org('periodic', 'substitute'),
      org('orca3d', 'direct'),
      org('cadence', 'substitute'),
      org('appen', 'comparator'),
      org('labelbox', 'comparator'),
      org('snorkel', 'comparator'),
    ];
    const bad = [
      fixture('gtm', {
        contract: budget26,
        plan: (s) =>
          s.replace(
            "await x.phase('scope', () => scope())",
            "(await x.phase('scope', () => scope.try())).out"
          ),
      }),
      fixture('gtm', {
        contract: budget26,
        plan: (s) =>
          s.replace(
            /brief: \(item\) => `# Collect:[\s\S]*?`,\n\s*item: Org,/,
            'brief: undefined as unknown as (item: z.infer<typeof Org>) => string, item: Org,'
          ),
      }),
      fixture('gtm-rewrite', withContract(budget26)), // drops two running calls; no dispositions
      fixture('gtm', {
        contract: budget26,
        plan: (s) =>
          s.replace(
            '# Collect: the public record',
            'Also note forum links you come across.\n# Collect: the public record'
          ),
      }),
    ];
    type Snap = { log: Buffer; plans: string };
    const snaps: Snap[] = [];
    let dir = '';
    const snap = (): Snap => ({
      log: readFileSync(path.join(dir, 'log.jsonl')),
      plans: treeHash(path.join(dir, 'plans')),
    });
    const rejections: string[][] = [];
    const w = world(
      gtmPolicy(orgs, (r) => (isCollect(r) ? 'hold' : 'default')),
      leaderFor({
        'budget-mark': () => {
          snaps.push(snap());
          return {
            act: { t: 'rewrite', file: bad[0] as string, why: 'try 1' },
            spent: reported(0.1),
          };
        },
        rejected: (event) => {
          // Since the snapshot: that wake settled, and this one is declared and started. Nothing else.
          const prev = snaps.at(-1) as Snap;
          const now = snap();
          assert.equal(now.plans, prev.plans, 'the plans directory changed');
          assert.deepEqual(now.log.subarray(0, prev.log.length), prev.log, 'the log was rewritten');
          const added = now.log
            .subarray(prev.log.length)
            .toString('utf8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l))
            // The owner's ask after two rejections, and the ruling: asked about, not plan state.
            .filter((x) => x.t !== 'owner' && !(x.key ?? x.call?.key ?? '').startsWith('owner/'));
          assert.deepEqual(
            added.map((x) => [x.t, x.key ?? x.call?.key]),
            [
              ['settled', `leader/${snaps.length}`],
              ['act', `leader/${snaps.length}`],
              ['declared', `leader/${snaps.length + 1}`],
              ['started', `leader/${snaps.length + 1}`],
            ]
          );
          if (event.t === 'rejected') rejections.push([...event.issues]);
          snaps.push(now);
          const next = bad[snaps.length - 1];
          return next
            ? {
                act: { t: 'rewrite', file: next, why: `try ${snaps.length}` },
                spent: reported(0.1),
              }
            : cont;
        },
      })
    );
    w.owner.answer = () => false;
    const e = await launched(w, fixture('gtm', withContract(budget26)));
    dir = e.dir;
    const run = (id: string) => w.ex.find(isAgent(`collect/collect/${id}`))[0] as Run;
    await w.signal.until(() => agentRunning(w.ex, 'collect/').length === 6, 'six collects run');
    for (const id of ['taskus', 'appen', 'orca3d', 'cadence']) {
      await w.signal.until(() => !!run(id), `${id} runs`);
      w.ex.end(run(id).runId, ok(REPORT), reported(1.5));
      await w.signal.until(
        () => settledOf(e, `collect/collect/${id}`).length === 1,
        `${id} settles`
      );
    }
    // Four rewrites, each through `tsc` (seconds apiece on a loaded machine), so longer waits.
    // After every second rejection in a row the host asks the owner instead of waking the leader:
    // the first time the owner waits for a rewrite (one more wake, then a fourth rejection), the
    // second time it continues as planned.
    const answerAsk = async (n: number, reply: string) => {
      const ask = () =>
        w.ex.running((r) => r.spec.t === 'ask' && r.spec.call.key === `owner/leader-stuck-${n}`);
      await w.signal.until(() => ask().length === 1, `the owner is asked (${n})`, 120_000);
      w.ex.end((ask()[0] as Run).runId, ok(reply), reported(0));
    };
    await answerAsk(1, 'rewrite');
    await answerAsk(2, 'continue, as planned');
    await w.signal.until(
      () =>
        e
          .entries()
          .some(
            (x) => x.t === 'owner' && x.act.t === 'leader-stuck' && x.act.ruling.t === 'continue'
          ),
      'the owner rules to continue'
    );
    assert.equal(w.leader.events.length, 4, 'no wake after the fourth rejection');
    const issues = e
      .entries()
      .flatMap((x) => (x.t === 'act' && x.verdict.t === 'rejected' ? [x.verdict.issues] : []));
    assert.equal(issues.length, 4);
    assert.match(issues[0]?.join() ?? '', /^typecheck: .*TS2339/);
    assert.match(issues[1]?.join() ?? '', /dry-run: .*Step collect/);
    assert.match(
      issues[2]?.join() ?? '',
      /rules: no cancel or finish for the dropped running calls collect\/collect\/labelbox, collect\/collect\/snorkel/
    );
    assert.match(
      issues[3]?.join() ?? '',
      /owner: the owner declined: new cost \$\d+(\.\d+)? is over the auto-apply limit \$10/
    );
    // The wake after the owner's "rewrite" carried that choice to the leader.
    assert.match(rejections[1]?.join() ?? '', /chose to wait for a rewrite/);
    assert.equal(w.owner.asked.length, 1);
    assert.equal(e.entries().filter((x) => x.t === 'plan').length, 1);
    assert.deepEqual(readdirSync(path.join(dir, 'plans')), ['v0.expedition.ts']);
    await e.detach();

    // At launch, a failed gate writes nothing at all.
    const w2 = world(gtmPolicy(orgs), leaderFor({}));
    const r = await launch(w2.deps, w2.root, bad[0] as string, 'base0', { t: 'none' });
    assert.equal(r.t === 'rejected' && r.gate, 'typecheck');
    assert.deepEqual(readdirSync(w2.root), []);
  });

  test('past the deadline: a new agent call is refused, a running judge completes, a pending ask is answered, the run finishes', async () => {
    const w = world(
      (r) => (r.spec.t === 'agent' ? { raw: ok(REPORT), spent: reported(0.5) } : 'hold'),
      leaderFor({})
    );
    const e = await launched(w, fixture('deadline'));
    await w.signal.until(
      () =>
        w.ex.running((r) => r.spec.t === 'check').length === 1 &&
        w.ex.running((r) => r.spec.t === 'ask').length === 1,
      'the judge and the ask are open'
    );
    w.clock.advance(61 * MIN);
    const deadline = e.state().deadlineMs;
    await e.serial(() => {}); // let the deadline check run
    assert.equal(e.state().progress.t, 'open', 'finishing waits for the judge and the ask');
    const [judge] = w.ex.running((r) => r.spec.t === 'check');
    const [question] = w.ex.running((r) => r.spec.t === 'ask');
    assert.ok(judge && question);
    w.ex.end(judge.runId, ok({}), reported(0));
    await w.signal.until(() => outcomeOf(e, 'probe') === 'passed', 'the judge completes');
    w.ex.end(question.runId, ok('rl-data'), reported(0));
    const finish: keyed.Finish = await finishedOf(w, e);
    assert.deepEqual(finish, {
      t: 'not-met',
      gaps: ['Step after did not pass: refused: deadline.'],
    });
    assert.deepEqual(settledOf(e, 'after')[0]?.outcome, { t: 'refused', reason: 'deadline' });
    for (const key of ['probe', 'ask/which-segment-first']) {
      const s = settledOf(e, key)[0];
      assert.equal(s?.outcome.t, 'passed');
      assert.ok(Date.parse(s?.at ?? '') >= deadline, `${key} settled after the deadline`);
    }
    assert.deepEqual(settledOf(e, 'leader/1')[0]?.outcome, { t: 'refused', reason: 'deadline' });
    assert.equal(w.leader.events.length, 0, 'no reflection after the deadline');
    await e.detach();
    assertBudgetAtEveryAppend(e.dir);
  });

  test('a judged "no" is failed and reused; an errored producer is never judged, reused until retry, then attempt 2', async () => {
    const orgs = [org('taskus', 'direct'), org('psi', 'substitute'), org('appen', 'comparator')];
    let reviews = 0;
    let createdAtSecondReview = new Map<string, number>();
    const w = world(
      gtmPolicy(orgs, (r) => {
        if (
          r.spec.t === 'agent' &&
          r.spec.call.key === 'collect/collect/psi' &&
          attemptOfRun(r.runId) === 1
        )
          return { raw: { t: 'errored', why: 'harness died' }, spent: reported(0.2) };
        if (r.spec.t === 'check' && r.spec.of.startsWith('collect/collect/taskus@'))
          return { raw: { t: 'no', why: 'quotes not found in page' }, spent: reported(0) };
        return 'default';
      }),
      leaderFor({
        'budget-mark': () => cont,
        review: () => {
          reviews++;
          if (reviews === 1) return new Promise(() => {}); // still thinking when the host dies
          if (reviews === 2) {
            createdAtSecondReview = new Map(w.ex.created);
            return { act: { t: 'retry', keys: ['collect/collect/psi'] }, spent: reported(0.1) };
          }
          return { act: { t: 'stop', why: 'enough for this test' }, spent: reported(0.1) };
        },
      })
    );
    const e1 = await launched(w, fixture('gtm'));
    await w.signal.until(() => reviewWakes(w) === 1, 'the coverage review wakes the leader');
    assert.equal(outcomeOf(e1, 'collect/collect/taskus'), 'failed');
    assert.equal(outcomeOf(e1, 'collect/collect/psi'), 'errored');
    assert.deepEqual(
      createdFor(w.ex, 'collect/collect/psi', 'judge'),
      [],
      'an errored producer is never judged'
    );
    assert.deepEqual(await e1.retry('collect/collect/taskus'), {
      t: 'refused',
      why: 'collect/collect/taskus failed: it has a result, so a retry would rebuy it',
    });
    const createdBeforeCrash = new Map(w.ex.created);
    await e1.detach();

    const e2 = await reopen(w, e1.dir);
    assert.equal(
      outcomeOf(e2, 'leader/1'),
      'errored',
      'the wake in flight at the crash is settled at boot'
    );
    await w.signal.until(() => reviewWakes(w) === 2, 'the replayed plan reaches the review again');
    assert.deepEqual(
      createdAtSecondReview,
      createdBeforeCrash,
      'the replay reused every result, the errored one too'
    );
    assert.equal((await finishedOf(w, e2)).t, 'not-met');
    const psi = createdFor(w.ex, 'collect/collect/psi', 'producer');
    assert.deepEqual(psi.map(attemptOfRun), [1, 2]);
    assert.deepEqual(createdFor(w.ex, 'collect/collect/psi', 'judge').map(attemptOfRun), [2]);
    assert.equal(outcomeOf(e2, 'collect/collect/psi'), 'passed');
    assert.equal(createdFor(w.ex, 'collect/collect/taskus', 'producer').length, 1);
    assert.equal(createdFor(w.ex, 'collect/collect/taskus', 'judge').length, 1);
    assert.equal(outcomeOf(e2, 'collect/collect/taskus'), 'failed');
    assertEachRunCreatedOnce(w.ex);
    await e2.detach();
    assertBudgetAtEveryAppend(e2.dir);
  });

  // CONNECT_PLAN §10 (second real run): the leader answered `retry` for a call that had failed its
  // judge, twice, and each rejection woke it again at once, bounded only by the budget. Two
  // rejected acts in a row at one wake point now ask the owner; the count is folded from the log,
  // so a host that dies between the two rejections still stops at two.
  test('two rejected acts at one wake point ask the owner once and wake the leader no third time, across a restart', async () => {
    const orgs = [org('taskus', 'direct'), org('psi', 'substitute')];
    const retryFailed: keyed.LeaderAct = { t: 'retry', keys: ['collect/collect/taskus'] };
    let crashed = false;
    const w = world(
      gtmPolicy(orgs, (r) =>
        r.spec.t === 'check' && r.spec.of.startsWith('collect/collect/taskus@')
          ? { raw: { t: 'no', why: 'quotes not found in page' }, spent: reported(0) }
          : 'default'
      ),
      leaderFor({
        'budget-mark': () => cont,
        review: () => ({ act: retryFailed, spent: reported(0.1) }),
        // Before the crash the second wake is still thinking when the host dies.
        rejected: () =>
          crashed ? { act: retryFailed, spent: reported(0.1) } : new Promise(() => {}),
      })
    );
    const e1 = await launched(w, fixture('gtm'));
    await w.signal.until(
      () => w.leader.events.filter((x) => x.t === 'rejected').length === 1,
      'the first rejection wakes the leader again'
    );
    const acts1 = e1.entries().filter((x) => x.t === 'act');
    assert.deepEqual(
      acts1.map((x) => x.t === 'act' && [x.key, x.verdict.t]),
      [['leader/1', 'rejected']]
    );
    crashed = true;
    await e1.detach();

    const e2 = await reopen(w, e1.dir);
    const ask = () =>
      w.ex.running((r) => r.spec.t === 'ask' && r.spec.call.key === 'owner/leader-stuck-1');
    await w.signal.until(() => ask().length === 1, 'the owner is asked after the second rejection');
    // Rebuilt from the log: the wake after the restart carried the first rejection, and its act was
    // the second; no third wake followed.
    assert.deepEqual(
      w.leader.events.map((x) => x.t),
      ['review', 'rejected', 'rejected']
    );
    assert.deepEqual(
      e2.entries().flatMap((x) => (x.t === 'act' ? [[x.key, x.verdict.t]] : [])),
      [
        ['leader/1', 'rejected'],
        ['leader/3', 'rejected'],
      ]
    );
    const [question] = ask();
    const text = question?.spec.t === 'ask' ? question.spec.call.question : '';
    assert.match(text, /last 2 acts at the checkin "Is the coverage enough/);
    assert.match(
      text,
      /1\. leader\/1: retry collect\/collect\/taskus\. Rejected: .*failed: it has a result/
    );
    assert.match(text, /2\. leader\/3: retry collect\/collect\/taskus\./);
    assert.match(text, /"continue".*"stop".*"rewrite"/);

    w.ex.end(
      question?.runId as string,
      ok('Stop. It keeps asking for the same thing.'),
      reported(0)
    );
    const finish = await finishedOf(w, e2);
    assert.equal(finish.t, 'not-met');
    assert.match(JSON.stringify(finish), /the owner stopped it after two rejected leader acts/);
    assert.equal(w.leader.events.length, 3, 'the owner ruled; the leader was never woken again');
    await e2.detach();
  });

  test('a rewrite never cancels a pending ask: a cancel for it is rejected, and without one it drains and is answered', async () => {
    const v1 = fixture('ask-rewrite/v1');
    let disposals = 0;
    const w = world(
      (r) =>
        r.spec.t === 'agent' && r.spec.call.key === 'scan'
          ? { raw: ok(REPORT), spent: reported(0.5) }
          : 'hold',
      leaderFor({
        review: () => ({
          act: { t: 'rewrite', file: v1, why: 'scan instead' },
          spent: reported(0.1),
        }),
        rejected: () => ({
          act: { t: 'rewrite', file: v1, why: 'scan instead, keep the question' },
          spent: reported(0.1),
        }),
        drained: () => cont,
      })
    );
    w.leader.disposer = (): Record<string, 'cancel' | 'finish'> =>
      ++disposals === 1
        ? { probe: 'cancel', 'ask/which-segment-first': 'cancel' }
        : { probe: 'cancel' };
    const e = await launched(w, fixture('ask-rewrite/v0'));
    await w.signal.until(
      () => e.entries().some((x) => x.t === 'plan' && x.version === 1),
      'the second rewrite applies'
    );
    const rejected = w.leader.events.find((x) => x.t === 'rejected');
    assert.match(JSON.stringify(rejected), /an ask is never cancelled: ask\/which-segment-first/);
    const plan1 = e
      .entries()
      .find((x): x is Extract<keyed.Entry, { t: 'plan' }> => x.t === 'plan' && x.version === 1);
    assert.deepEqual(plan1?.dropped, { probe: 'cancel', 'ask/which-segment-first': 'finish' });
    assert.equal(w.owner.asked.length, 1, 'no judged pass yet: the owner approved it');

    const [question] = w.ex.find(
      (r) => r.spec.t === 'ask' && r.spec.call.key === 'ask/which-segment-first'
    );
    assert.ok(question);
    await w.signal.until(
      () => w.ex.running((r) => r.spec.t === 'ask' && r.spec.call.key === 'done/0').length === 1,
      'v1 ends; the owner criterion is asked'
    );
    assert.equal(w.ex.cancels.includes(question.runId), false, 'the ask was never cancelled');
    assert.equal(e.state().pendingAsks.size, 2);
    w.ex.end(question.runId, ok('rl-data'), reported(0));
    await w.signal.until(
      () => outcomeOf(e, 'ask/which-segment-first') === 'passed',
      'the drained ask is answered'
    );
    const [accept] = w.ex.running((r) => r.spec.t === 'ask' && r.spec.call.key === 'done/0');
    assert.ok(accept);
    w.ex.end(accept.runId, ok(true), reported(0));
    assert.equal((await finishedOf(w, e)).t, 'met');
    assert.equal(outcomeOf(e, 'probe'), 'cancelled');
    await e.detach();
    assertBudgetAtEveryAppend(e.dir);
  });

  test('a torn last line is truncated and reported; a bad line before it is a typed error', async () => {
    const w = world(
      gtmPolicy([org('a', 'direct')], (r) => (isCollect(r) ? 'hold' : 'default')),
      leaderFor({ 'budget-mark': () => cont })
    );
    const e1 = await launched(w, fixture('gtm'));
    await w.signal.until(() => agentRunning(w.ex, 'collect/').length === 1, 'a collect runs');
    await e1.detach();
    const file = path.join(e1.dir, 'log.jsonl');
    const good = readFileSync(file, 'utf8');
    writeFileSync(file, `${good}{"t":"settled","at":"2026-11-10T09:0`);
    const { expedition: e2, repair } = await open(w.deps, e1.dir);
    assert.equal(repair.t, 'truncated-torn-line');
    assert.equal(readFileSync(file, 'utf8'), good);
    await e2.detach();
    const lines = good.split('\n');
    lines[2] = '{"t":"declared"}';
    writeFileSync(file, lines.join('\n'));
    await assert.rejects(open(w.deps, e1.dir), /log\.jsonl:3: not an entry/);
  });
});

const reviewWakes = (w: World) => w.leader.events.filter((x) => x.t === 'review').length;
const isCollect = (r: Run) => r.spec.t === 'agent' && r.spec.call.key.startsWith('collect/');
const budget26 = (md: string) => md.replace('usd: 60', 'usd: 26');

/** Paths and bytes of every file under `dir`, hashed: equal iff the tree is byte-identical. */
function treeHash(dir: string): string {
  const h = createHash('sha256');
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = path.join(d, name);
      h.update(`${path.relative(dir, p)}\0`);
      if (statSync(p).isDirectory()) walk(p);
      else h.update(readFileSync(p));
    }
  };
  if (existsSync(dir)) walk(dir);
  return h.digest('hex');
}
