import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  type Asked,
  type Decision,
  ImpossibleEntry,
  RETRIABLE,
  STARTS_AFTER_DEADLINE,
  type State,
  currentRunId,
  cutOff,
  decide,
  diffOf,
  dropped,
  due,
  fold,
  foldFrom,
  hashOf,
  judgeRewrite,
  liveCalls,
  lookup,
  profileOf,
  runIdOf,
  stageOf,
  step,
} from '../src/expedition-kernel/core';
import {
  type AgentCall,
  type Call,
  type Contract,
  type Disposition,
  Entry,
  type Hash,
  type Key,
  type Outcome,
  type Usage,
  refOf,
} from '../src/expedition-kernel/types';

// The kernel core (server/src/expedition-kernel/core): a seeded random host driven THROUGH
// decide/fold, checking DESIGN §6's guarantees after every step, then directed cases for each
// decision and rewrite rule.

const T0 = Date.parse('2026-11-10T00:00:00.000Z');
const MIN = 60_000;

const contractOf = (over: Partial<Contract> = {}): Contract => ({
  goal: 'find the buyers',
  done: [{ t: 'owner', question: 'is it done?' }],
  budget: { usd: 20, hours: 2 },
  pools: { p1: 2, p2: 3 },
  rules: [],
  leader: 'lead',
  repo: '/repo',
  autoApply: { usd: 5 },
  ...over,
});

type AgentOpts = { usd: number; pools: string[]; judged: boolean; brief: string };
const agent = (key: Key, o: Partial<AgentOpts> = {}): AgentCall => ({
  t: 'agent',
  key,
  by: { t: 'seat', provider: 'claude', model: 'm', effort: 'high' },
  brief: o.brief ?? `research ${key}`,
  inputs: [],
  output: { type: 'object' },
  tree: 'none',
  base: { t: 'launch' },
  grant: { reads: [], web: true },
  context: { t: 'cold' },
  pools: o.pools ?? ['p1'],
  max: { usd: o.usd ?? 1, minutes: 30 },
  judge: o.judged ? { t: 'check', command: 'true' } : { t: 'none' },
});
const command = (key: Key, pools: string[] = ['p2'], cmd = 'pnpm test'): Call => ({
  t: 'command',
  key,
  command: cmd,
  on: { t: 'launch' },
  output: null,
  pools,
  maxMinutes: 5,
});
const ask = (key: Key, question = 'which segment?'): Call => ({
  t: 'ask',
  key,
  question,
  answer: 'text',
});

type Body = Entry extends infer E ? (E extends Entry ? Omit<E, 'at'> : never) : never;

/** The executor as the log-first host sees it (ports.ts): runs by derived id, idempotent start, a
 * closed id never starts, and it outlives the host. A start the host sent may not have arrived
 * yet (`inflight`); at a crash each one has landed, was lost, or is in limbo (it lands later, from
 * the dead process). `starts` counts runs actually created per id: what costs money (I1). */
class SimExecutor {
  readonly runs = new Map<string, 'running' | 'done'>();
  readonly closed = new Set<string>();
  readonly starts = new Map<string, number>();
  inflight = new Set<string>();
  readonly limbo = new Set<string>();
  idempotentHits = 0;
  closedHits = 0;
  constructor(private readonly arrives: () => boolean) {}
  start(runId: string): void {
    if (this.arrives()) this.land(runId);
    else this.inflight.add(runId);
  }
  land(runId: string): void {
    if (this.closed.has(runId)) return void this.closedHits++;
    if (this.runs.has(runId)) return void this.idempotentHits++;
    this.runs.set(runId, 'running');
    this.starts.set(runId, (this.starts.get(runId) ?? 0) + 1);
  }
  /** The call settled: whatever ran under its ids is over and the ids are closed. */
  settle(runIds: readonly string[]): void {
    for (const id of runIds) {
      if (this.runs.has(id)) this.runs.set(id, 'done');
      this.closed.add(id);
      this.inflight.delete(id);
    }
  }
  status(runId: string): 'running' | 'done' | 'unknown' {
    return this.runs.get(runId) ?? 'unknown';
  }
}

/** A scripted host: every decision becomes the entries the real host would append, and every
 * start goes to the executor AFTER its entry is in the log (R1). */
class Host {
  log: Entry[] = [];
  state!: State;
  nowMs: number;
  constructor(
    contract: Contract = contractOf(),
    nowMs = T0,
    readonly ex: SimExecutor = new SimExecutor(() => true)
  ) {
    this.nowMs = nowMs;
    this.append({ t: 'launched', id: 'exp', contract, baseSha: 'base0' });
    this.append({
      t: 'plan',
      version: 0,
      by: 'lead',
      why: 'launch',
      diff: emptyDiff(),
      dropped: {},
    });
  }
  get now(): Date {
    return new Date(this.nowMs);
  }
  get version(): number {
    return this.state.plan.t === 'planned' ? this.state.plan.version : -1;
  }
  append(body: Body): void {
    const e = Entry.parse({ ...body, at: new Date(this.nowMs).toISOString() });
    this.state = this.log.length === 0 ? fold([e]) : step(this.state, e, this.log.length);
    this.log.push(e);
  }
  /** The plan asks for `call`: declare it under the current plan (again, while it drains: the
   * declaration that re-attaches it waits until no other hash of its key runs), then apply the
   * decision. */
  request(call: Call): Decision {
    const hash = hashOf(call);
    const known = lookup(this.state, call.key, hash);
    if (
      known.t === 'unknown' ||
      known.record.declaredIn < this.version ||
      known.record.status.t === 'draining'
    )
      this.append({ t: 'declared', call, hash, planVersion: this.version });
    const d = decide(this.state, call, hash, this.now);
    if (d.t === 'start') {
      const runId = this.runId(call.key, hash, 'producer');
      this.append({ t: 'started', key: call.key, hash, runId, reserved: d.reservation });
      this.ex.start(runId);
    }
    if (d.t === 'refuse')
      this.settle(call.key, hash, { t: 'refused', reason: d.reason }, reported(0));
    if (d.t === 'replace')
      this.settle(
        call.key,
        d.cancel.hash,
        { t: 'cancelled', partial: refOf(call.key, d.cancel.hash) },
        reported(0)
      );
    return d;
  }
  runId(key: Key, hash: Hash, role: 'producer' | 'judge'): string {
    const found = lookup(this.state, key, hash);
    const attempt = found.t === 'known' ? found.record.attempt : 1;
    return runIdOf(this.state.id, key, hash, attempt, role);
  }
  produce(key: Key, hash: Hash): void {
    const judgeRunId = this.runId(key, hash, 'judge');
    // The producer's run is over; its id stays open until the call settles.
    this.ex.runs.set(this.runId(key, hash, 'producer'), 'done');
    this.append({
      t: 'produced',
      key,
      hash,
      ref: refOf(key, hash),
      out: { n: 1 },
      judgeRunId,
      spent: reported(0),
    });
    this.ex.start(judgeRunId);
  }
  settle(key: Key, hash: Hash, outcome: Outcome, spent: Usage): void {
    const ids = [this.runId(key, hash, 'producer'), this.runId(key, hash, 'judge')];
    this.append({ t: 'settled', key, hash, outcome, spent });
    this.ex.settle(ids);
  }
  retry(key: Key, hash: Hash): void {
    this.append({ t: 'retried', key, hash, by: 'owner' });
  }
  /** Through the rules gate, as the real host does: the entry carries the gate's dispositions
   * (the leader's plus `finish` for each dropped ask). */
  rewrite(version: number, asked: readonly Asked[], dispositions: Record<Key, Disposition>): void {
    const v = judgeRewrite(this.state, {
      version,
      contract: this.state.contract,
      asked,
      dispositions,
    });
    if (v.t === 'reject') throw new Error(`rewrite rejected: ${JSON.stringify(v.why)}`);
    this.append({
      t: 'plan',
      version,
      by: 'lead',
      why: 'learned',
      diff: v.diff,
      dropped: { ...v.dropped },
    });
  }
}
const emptyDiff = () => ({ reused: [], attached: [], dropped: [], started: [], newCostUsd: 0 });
const reported = (usd: number): Usage => ({ t: 'reported', usd });
const passed = (key: Key, hash: Hash): Outcome => ({
  t: 'passed',
  ref: refOf(key, hash),
  out: { ok: true },
});
const askedOf = (calls: readonly Call[]): Asked[] =>
  calls.map((call) => ({ call, hash: hashOf(call) }));
const statusOf = (s: State, call: Call) => {
  const found = lookup(s, call.key, hashOf(call));
  assert.equal(found.t, 'known');
  return found.t === 'known' ? found.record.status : assert.fail('unknown');
};

// ---- The random driver ----

/** mulberry32: small, seedable, good enough to drive interleavings. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Stats = {
  steps: number;
  episodes: number;
  starts: number;
  entries: number;
  rewrites: number;
  rejects: number;
  restarts: number;
  /** Logged starts the executor had not heard of at a restart, re-issued (R1). */
  reissued: number;
  /** Logged starts settled at $0 at a restart: cancelling, or past the deadline (R1). */
  settledUnstarted: number;
  limboLanded: number;
  closedHits: number;
  idempotentHits: number;
  retries: number;
  asksDrained: number;
  decisions: Record<string, number>;
};

/** The one attached record of a key, if any. */
function attachedOf(s: State, key: Key) {
  for (const r of s.calls.get(key)?.values() ?? [])
    if (r.status.t === 'running' || r.status.t === 'judging') return r;
  return undefined;
}

function simulate(seed: number, steps: number, stats: Stats): void {
  const rnd = prng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const chance = (p: number) => rnd() < p;

  // Each key has one kind and two versions of its call (a rewrite may swap one for the other: a
  // changed hash; for an ask, a reworded question).
  const universe = new Map<Key, [Call, Call]>();
  for (let i = 0; i < 12; i++) {
    const key = `ph${i % 3}/step/k${i}`;
    const kind = rnd();
    const make = (v: number): Call => {
      if (kind < 0.6)
        return agent(key, {
          usd: pick([0.5, 1, 1.5, 2, 3]),
          pools: pick([['p1'], ['p2'], ['p1', 'p2'], ['p1'], ['p2'], ['p1', 'p2'], ['gpu']]),
          judged: chance(0.6),
          brief: `brief v${v} of ${key}`,
        });
      if (kind < 0.85) return command(key, pick([['p2'], [], ['p1']]), `check v${v}`);
      return ask(key, `question v${v}`);
    };
    universe.set(key, [make(0), make(1)]);
  }
  const randomPlan = (): Call[] =>
    [...universe.values()].filter(() => chance(0.65)).map((variants) => pick(variants));

  let host!: Host;
  let plan!: Call[];
  // Independent bookkeeping, built from the log as it is appended: what the core must agree with.
  let loggedStarts: Set<string>;
  let firstOutcome: Map<string, string>;
  let startedReserved: Map<string, string>;
  let checked: number;

  const newEpisode = () => {
    host = new Host(
      contractOf({ budget: { usd: 25, hours: 3 } }),
      T0 + stats.episodes * 100 * 3_600_000,
      new SimExecutor(() => chance(0.8))
    );
    plan = randomPlan();
    loggedStarts = new Set();
    firstOutcome = new Map();
    startedReserved = new Map();
    checked = 0;
    stats.episodes++;
    reconcile();
  };
  const reconcile = () => {
    for (const call of plan) request(call);
  };
  const request = (call: Call) => {
    const d = host.request(call);
    stats.decisions[d.t] = (stats.decisions[d.t] ?? 0) + 1;
    if (call.t === 'ask') assert.ok(!['refuse', 'wait', 'replace'].includes(d.t), `ask: ${d.t}`);
    if (d.t === 'reuse') {
      scan();
      const first = firstOutcome.get(refOf(call.key, hashOf(call)));
      assert.equal(JSON.stringify(d.outcome), first, 'reuse returned another outcome');
    }
  };

  /** Read the entries appended since the last scan into the independent bookkeeping. */
  const scan = () => {
    for (; checked < host.log.length; checked++) {
      const e = host.log[checked] as Entry;
      if (e.t === 'started') {
        // I1 in the log: one `started` per (key, hash, attempt), i.e. per derived run id.
        assert.ok(!loggedStarts.has(e.runId), `I1: ${e.runId} logged started twice`);
        loggedStarts.add(e.runId);
        startedReserved.set(refOf(e.key, e.hash), JSON.stringify(e.reserved));
        stats.starts++;
      }
      if (e.t === 'retried') firstOutcome.delete(refOf(e.key, e.hash));
      if (e.t === 'settled') {
        const ref = refOf(e.key, e.hash);
        assert.ok(!firstOutcome.has(ref), `I3: ${ref} settled twice`);
        firstOutcome.set(ref, JSON.stringify(e.outcome));
        const r = lookup(host.state, e.key, e.hash);
        if (r.t === 'known' && r.record.call.t === 'ask')
          assert.ok(['passed', 'refused'].includes(e.outcome.t), `I6: an ask ${e.outcome.t}`);
      }
    }
  };
  /** Check every guarantee against the state and the executor. */
  const check = (label: string) => {
    scan();
    const s = host.state;
    // I2
    assert.ok(
      s.spentUsd + s.reservedUsd <= s.contract.budget.usd + 1e-9,
      `I2: spent ${s.spentUsd} + reserved ${s.reservedUsd} > ${s.contract.budget.usd} (${label})`
    );
    // I3: every settled record still holds its first outcome.
    for (const [key, byHash] of s.calls)
      for (const [hash, r] of byHash)
        if (r.status.t === 'settled')
          assert.equal(
            JSON.stringify(r.status.outcome),
            firstOutcome.get(refOf(key, hash)),
            'I3: outcome changed'
          );
    // Reservations and pool slots, recomputed from the live calls; a draining call still holds
    // exactly what it started with. An ask is never being cancelled (I6).
    let reserved = 0;
    const slots = new Map<string, number>();
    const current = new Set<string>();
    for (const c of liveCalls(s)) {
      assert.equal(
        JSON.stringify(c.status.run.reserved),
        startedReserved.get(refOf(c.key, c.hash))
      );
      if (c.call.t === 'ask') assert.notEqual(c.status.t, 'cancelling', 'I6: an ask cancelled');
      reserved += c.status.run.reserved.usd;
      for (const p of c.status.run.reserved.pools) slots.set(p, (slots.get(p) ?? 0) + 1);
      current.add(currentRunId(c.status));
    }
    assert.ok(
      Math.abs(reserved - s.reservedUsd) < 1e-6,
      `reserved ${s.reservedUsd}, live calls hold ${reserved}`
    );
    assert.deepEqual(slots, s.poolsInUse);
    for (const [pool, n] of s.poolsInUse)
      assert.ok(
        n <= (s.contract.pools[pool] ?? 0),
        `pool ${pool} holds ${n} > cap ${s.contract.pools[pool]}`
      );
    // I1 where it costs money: the executor created each run id at most once, across restarts,
    // late (limbo) starts and retries.
    for (const [id, n] of host.ex.starts) assert.ok(n <= 1, `I1: executor started ${id} ${n}×`);
    // No orphan: every run the executor has running is the current run of a live call, so some
    // ledger holds it and something can still cancel it.
    for (const [id, st] of host.ex.runs)
      if (st === 'running') assert.ok(current.has(id), `orphan run ${id} (${label})`);
  };

  /** I4: after a reconcile, every attached run is asked for (with its hash) by the current plan. */
  const checkI4 = () => {
    const asked = new Set(plan.map((c) => refOf(c.key, hashOf(c))));
    for (const c of liveCalls(host.state))
      if (c.status.t === 'running' || c.status.t === 'judging')
        assert.ok(
          asked.has(refOf(c.key, c.hash)),
          `I4: ${c.key} runs but the plan does not ask for it`
        );
  };

  const foldChecks = () => {
    const whole = fold(host.log);
    assert.deepStrictEqual(whole, host.state, 'fold(log) differs from the live state');
    const k = 1 + Math.floor(rnd() * host.log.length);
    assert.deepStrictEqual(
      foldFrom(fold(host.log.slice(0, k)), host.log.slice(k), k),
      whole,
      `prefix ${k}`
    );
  };

  const usage = (reservedUsd: number): Usage =>
    chance(0.2) ? { t: 'unreported' } : reported(Math.round(rnd() * reservedUsd * 100) / 100);

  /** A run the executor has running ends. A run whose start has not arrived cannot end. */
  const settleOne = () => {
    const live = liveCalls(host.state).filter(
      (c) => host.ex.status(currentRunId(c.status)) === 'running'
    );
    if (live.length === 0) return;
    const c = pick(live);
    const stage = stageOf(c.status);
    const profile = profileOf(c.call);
    if (
      profile === 'judged-agent' &&
      stage.t === 'producing' &&
      c.status.t !== 'cancelling' &&
      chance(0.85)
    )
      return host.produce(c.key, c.hash);
    const ref = refOf(c.key, c.hash);
    const r = rnd();
    const outcome: Outcome =
      profile === 'ask'
        ? passed(c.key, c.hash)
        : c.status.t === 'cancelling' || (profile === 'judged-agent' && stage.t === 'producing')
          ? r < 0.8
            ? { t: 'cancelled', partial: ref }
            : { t: 'errored', why: 'harness died' }
          : profile === 'agent'
            ? r < 0.85
              ? passed(c.key, c.hash)
              : { t: 'errored', why: 'harness died' }
            : r < 0.6
              ? passed(c.key, c.hash)
              : r < 0.9
                ? { t: 'failed', ref, out: {}, why: 'judge said no' }
                : { t: 'errored', why: 'exit 137' };
    if (c.status.t === 'draining' && profile === 'ask') stats.asksDrained++;
    host.settle(c.key, c.hash, outcome, usage(c.status.run.reserved.usd));
  };

  /** An owner or leader retry of a call the current plan asks for that errored, was cancelled or
   * was refused: it becomes the next attempt, and the next evaluation starts it. */
  const retryOne = () => {
    const candidates = plan.filter((c) => {
      const r = lookup(host.state, c.key, hashOf(c));
      return (
        r.t === 'known' && r.record.status.t === 'settled' && RETRIABLE[r.record.status.outcome.t]
      );
    });
    if (candidates.length === 0) return;
    const c = pick(candidates);
    host.retry(c.key, hashOf(c));
    stats.retries++;
    request(c);
  };

  const rewrite = () => {
    const next = randomPlan();
    const asked = askedOf(next);
    const drops = dropped(host.state, new Set(next.map((c) => c.key)));
    const choose = drops.filter((k) => attachedOf(host.state, k)?.call.t !== 'ask');
    const asks = drops.filter((k) => attachedOf(host.state, k)?.call.t === 'ask');
    const dispositions: Record<Key, Disposition> = Object.fromEntries(
      choose.map((k) => [k, pick(['cancel', 'finish'] as const)])
    );
    const mutation = rnd();
    const version = host.version + 1;
    const judge = (d: Record<Key, Disposition>, contract = host.state.contract) =>
      judgeRewrite(host.state, { version, contract, asked, dispositions: d });
    if (mutation < 0.05 && choose.length > 0) {
      const { [choose[0] as Key]: _, ...missing } = dispositions;
      assert.deepEqual(judge(missing), { t: 'reject', why: { t: 'undecided', keys: [choose[0]] } });
      stats.rejects++;
      return;
    }
    if (mutation < 0.1 && asks.length > 0) {
      const cancelled = { ...dispositions, [asks[0] as Key]: 'cancel' as const };
      assert.deepEqual(judge(cancelled), {
        t: 'reject',
        why: { t: 'ask-cancelled', keys: [asks[0]] },
      });
      stats.rejects++;
      return;
    }
    if (mutation < 0.15) {
      const contract = { ...host.state.contract, autoApply: { usd: 1000 } };
      assert.deepEqual(judge(dispositions, contract), {
        t: 'reject',
        why: { t: 'contract-changed' },
      });
      stats.rejects++;
      return;
    }
    const v = judge(dispositions);
    assert.notEqual(v.t, 'reject', JSON.stringify(v));
    if (v.t === 'needs-owner' && chance(0.3)) return; // the owner declined
    host.rewrite(version, asked, dispositions);
    for (const k of asks)
      assert.ok(
        host.state.calls.get(k) &&
          [...(host.state.calls.get(k)?.values() ?? [])].some((r) => r.status.t === 'draining'),
        `I6: the dropped ask ${k} does not drain`
      );
    plan = next;
    stats.rewrites++;
    reconcile();
    check('after rewrite');
    checkI4();
  };

  /** A crash: host memory is gone, and each start it had sent but the executor had not received
   * has landed, was lost, or is in limbo. The new host folds the log and, for every logged start
   * the executor has not heard of, re-issues it (start is idempotent on the derived id) or, when
   * it must not run now (being cancelled, or past the deadline), settles it at $0 and closes it. */
  const restart = () => {
    stats.restarts++;
    for (const id of host.ex.inflight) {
      const r = rnd();
      if (r < 0.35) host.ex.land(id);
      else if (r >= 0.7) host.ex.limbo.add(id);
    }
    host.ex.inflight = new Set();
    foldChecks();
    host.state = fold(host.log);
    for (const c of liveCalls(host.state)) {
      const id = currentRunId(c.status);
      if (host.ex.status(id) !== 'unknown') continue;
      const producing = stageOf(c.status).t === 'producing';
      const late =
        producing && !STARTS_AFTER_DEADLINE[c.call.t] && host.nowMs >= host.state.deadlineMs;
      if (c.status.t === 'cancelling') {
        host.settle(c.key, c.hash, { t: 'cancelled', partial: refOf(c.key, c.hash) }, reported(0));
        stats.settledUnstarted++;
      } else if (late) {
        host.settle(c.key, c.hash, { t: 'refused', reason: 'deadline' }, reported(0));
        stats.settledUnstarted++;
      } else {
        host.ex.start(id);
        stats.reissued++;
      }
    }
    // A fresh plan process re-asks.
    reconcile();
    checkI4();
  };

  const finishIfDue = () => {
    const d = due(host.state, host.now);
    if (d.t === 'no') return false;
    // The deadline bounds work, not judgment.
    assert.equal(host.state.pendingAsks.size, 0, 'finished with an ask pending');
    assert.ok(
      !liveCalls(host.state).some((c) => stageOf(c.status).t === 'judging'),
      'finished over a judge'
    );
    for (const c of cutOff(host.state, host.now))
      host.settle(
        c.key,
        c.hash,
        { t: 'cancelled', partial: refOf(c.key, c.hash) },
        usage(c.status.run.reserved.usd)
      );
    host.append({ t: 'finished', reason: { t: d.t } });
    for (const c of plan)
      assert.equal(decide(host.state, c, hashOf(c), host.now).t === 'start', false);
    for (const c of liveCalls(host.state))
      host.settle(
        c.key,
        c.hash,
        { t: 'cancelled', partial: refOf(c.key, c.hash) },
        usage(c.status.run.reserved.usd)
      );
    // Starts still in flight or in limbo land on closed ids: no-ops.
    for (const id of [...host.ex.inflight, ...host.ex.limbo]) host.ex.land(id);
    check('wound down');
    foldChecks();
    stats.closedHits += host.ex.closedHits;
    stats.idempotentHits += host.ex.idempotentHits;
    return true;
  };

  newEpisode();
  for (let i = 0; i < steps; i++) {
    stats.steps++;
    const r = rnd();
    const label = `step ${i}`;
    if (r < 0.34) plan.length > 0 && request(pick(plan));
    else if (r < 0.54) settleOne();
    else if (r < 0.58) {
      // A start the executor had not received arrives.
      const id = [...host.ex.inflight][0];
      if (id !== undefined) {
        host.ex.inflight.delete(id);
        host.ex.land(id);
      }
    } else if (r < 0.6) {
      // A dead host's start lands now.
      const id = [...host.ex.limbo][0];
      if (id !== undefined) {
        host.ex.limbo.delete(id);
        host.ex.land(id);
        stats.limboLanded++;
      }
    } else if (r < 0.62) retryOne();
    else if (r < 0.67) rewrite();
    else if (r < 0.71) {
      const act = host.state.paused ? 'resume' : pick(['pause', 'extend'] as const);
      host.append({ t: 'owner', act: act === 'extend' ? { t: 'extend', hours: 1 } : { t: act } });
    } else if (r < 0.72) {
      const c = host.state.contract;
      host.append({
        t: 'contract',
        change: 'more room',
        contract: {
          ...c,
          budget: { ...c.budget, usd: c.budget.usd + 5 },
          pools: { ...c.pools, p1: (c.pools.p1 ?? 0) + 1 },
        },
      });
    } else if (r < 0.9) host.nowMs += (1 + Math.floor(rnd() * 20)) * MIN;
    else if (r < 0.93) restart();
    check(label);
    if (i % 25 === 0) foldChecks();
    if (finishIfDue()) {
      stats.entries += host.log.length;
      newEpisode();
    }
  }
  stats.entries += host.log.length;
}

describe('expedition kernel core: random interleavings', () => {
  test('I1-I4, I6, pools, draining, retries, log-first restarts and fold purity hold across seeds', () => {
    const seeds = [1, 2, 3, 7, 42, 1337, 20261110, 99991];
    const stats: Stats = {
      steps: 0,
      episodes: 0,
      starts: 0,
      entries: 0,
      rewrites: 0,
      rejects: 0,
      restarts: 0,
      reissued: 0,
      settledUnstarted: 0,
      limboLanded: 0,
      closedHits: 0,
      idempotentHits: 0,
      retries: 0,
      asksDrained: 0,
      decisions: {},
    };
    for (const seed of seeds) {
      try {
        simulate(seed, 2500, stats);
      } catch (err) {
        throw new Error(`seed ${seed}: ${(err as Error).message}`, { cause: err });
      }
    }
    console.log(`[kernel driver] seeds ${seeds.join(',')}: ${JSON.stringify(stats)}`);
    // The driver must actually exercise the machine, or the invariants above are vacuous.
    assert.ok(
      stats.starts > 1000 && stats.rewrites > 200 && stats.episodes > 8,
      JSON.stringify(stats)
    );
    for (const t of ['reuse', 'attach', 'replace', 'start', 'wait', 'refuse'])
      assert.ok((stats.decisions[t] ?? 0) > 20, `the driver rarely decides ${t}`);
    for (const k of [
      'reissued',
      'settledUnstarted',
      'limboLanded',
      'closedHits',
      'idempotentHits',
      'retries',
      'asksDrained',
    ] as const)
      assert.ok(stats[k] > 5, `the driver rarely reaches ${k}: ${JSON.stringify(stats)}`);
  });
});

// ---- Directed: each decision ----

describe('decide', () => {
  test('a 10-wide fan-out on a 3-slot pool queues, never fails, and all 10 start', () => {
    const h = new Host(contractOf({ pools: { p: 3 }, budget: { usd: 100, hours: 2 } }));
    const fan = Array.from({ length: 10 }, (_, i) => agent(`collect/org${i}`, { pools: ['p'] }));
    const first = fan.map((c) => h.request(c).t);
    assert.deepEqual(first.filter((t) => t === 'start').length, 3);
    assert.deepEqual(first.filter((t) => t === 'wait').length, 7);
    const started = new Set<string>();
    for (let round = 0; round < 20 && started.size < 10; round++) {
      for (const c of fan) if (statusOf(h.state, c).t === 'running') started.add(c.key);
      const running = liveCalls(h.state);
      assert.ok(running.length <= 3);
      const done = running[0];
      if (done) h.settle(done.key, done.hash, passed(done.key, done.hash), reported(0.5));
      for (const c of fan) {
        const d = h.request(c);
        assert.ok(d.t !== 'refuse', `${c.key} refused: ${JSON.stringify(d)}`);
      }
    }
    for (const c of fan) if (statusOf(h.state, c).t !== 'declared') started.add(c.key);
    assert.equal(started.size, 10);
  });

  test('budget: a call that exactly fits starts; a cent over refuses; one that fits later waits', () => {
    const h = new Host(contractOf({ budget: { usd: 10, hours: 2 } }));
    const spend = agent('a/spend', { usd: 7 });
    h.request(spend);
    h.settle(spend.key, hashOf(spend), passed(spend.key, hashOf(spend)), reported(7));
    assert.equal(h.state.spentUsd, 7);
    assert.equal(h.request(agent('a/over', { usd: 3.01 })).t, 'refuse');
    assert.deepEqual(h.request(agent('a/exact', { usd: 3 })), {
      t: 'start',
      reservation: { usd: 3, pools: ['p1'] },
    });
    assert.equal(h.state.spentUsd + h.state.reservedUsd, 10);
    // In flight: 3 reserved of 10 - 7. A $1 call cannot fit now but could once that settles.
    assert.deepEqual(h.request(agent('a/later', { usd: 1 })), { t: 'wait', why: { t: 'budget' } });
    const exact = agent('a/exact', { usd: 3 });
    h.settle(exact.key, hashOf(exact), passed(exact.key, hashOf(exact)), reported(1.5));
    assert.equal(h.request(agent('a/later', { usd: 1 })).t, 'start');
    // A refusal is final and replayed (the replayed plan must see what it saw).
    assert.deepEqual(h.request(agent('a/over', { usd: 3.01 })), {
      t: 'reuse',
      outcome: { t: 'refused', reason: 'budget' },
    });
  });

  test('budget sums stay exact over many fractional reservations', () => {
    // 0.1 + 0.2 style drift would refuse the last call that exactly fits.
    const h = new Host(contractOf({ budget: { usd: 3, hours: 2 }, pools: { p1: 100 } }));
    for (let i = 0; i < 29; i++) assert.equal(h.request(agent(`f/${i}`, { usd: 0.1 })).t, 'start');
    assert.equal(h.request(agent('f/last', { usd: 0.1 })).t, 'start');
    assert.equal(h.request(agent('f/more', { usd: 0.1 })).t, 'wait');
  });

  test('a changed hash under a running key replaces: cancel first, then start', () => {
    const h = new Host();
    const v1 = agent('scope/scope', { brief: 'v1' });
    const v2 = agent('scope/scope', { brief: 'v2' });
    h.request(v1);
    const run = statusOf(h.state, v1);
    assert.equal(run.t, 'running');
    const d = decide(h.state, v2, hashOf(v2), h.now);
    assert.deepEqual(d, {
      t: 'replace',
      cancel: { hash: hashOf(v1), runId: run.t === 'running' ? run.run.runId : '' },
    });
    // Starting v2 beside a still-running v1 is an impossible log.
    const sneak = new Host();
    sneak.request(v1);
    sneak.append({ t: 'declared', call: v2, hash: hashOf(v2), planVersion: 0 });
    assert.throws(
      () =>
        sneak.append({
          t: 'started',
          key: v2.key,
          hash: hashOf(v2),
          runId: runIdOf('exp', v2.key, hashOf(v2), 1, 'producer'),
          reserved: { usd: 1, pools: ['p1'] },
        }),
      ImpossibleEntry
    );
    h.request(v2); // the scripted host cancels v1 (it settles `cancelled`)
    assert.equal(statusOf(h.state, v1).t, 'settled');
    assert.equal(h.request(v2).t, 'start');
  });

  test('a judged "no" is a result: `failed` is reused, never rerun', () => {
    const h = new Host();
    const c = agent('collect/taskus', { judged: true });
    const hash = hashOf(c);
    h.request(c);
    h.produce(c.key, hash);
    assert.equal(statusOf(h.state, c).t, 'judging');
    assert.equal(h.request(c).t, 'attach');
    const failed: Outcome = {
      t: 'failed',
      ref: refOf(c.key, hash),
      out: { n: 1 },
      why: 'quotes not on the page',
    };
    h.settle(c.key, hash, failed, reported(0.4));
    const before = h.log.length;
    assert.deepEqual(h.request(c), { t: 'reuse', outcome: failed });
    assert.equal(h.log.filter((e) => e.t === 'started').length, 1);
    assert.equal(h.log.length, before);
  });

  test('past the deadline an agent or command is refused, an ask still starts', () => {
    const h = new Host(contractOf({ budget: { usd: 20, hours: 1 } }));
    h.nowMs += 60 * MIN;
    assert.deepEqual(h.request(agent('late/agent')), { t: 'refuse', reason: 'deadline' });
    assert.deepEqual(h.request(command('late/cmd')), { t: 'refuse', reason: 'deadline' });
    assert.deepEqual(h.request(ask('late/ask')), {
      t: 'start',
      reservation: { usd: 0, pools: [] },
    });
  });

  test('an owner extension moves the deadline', () => {
    const h = new Host(contractOf({ budget: { usd: 20, hours: 1 } }));
    h.nowMs += 70 * MIN;
    h.append({ t: 'owner', act: { t: 'extend', hours: 1 } });
    assert.equal(h.request(agent('late/agent')).t, 'start');
  });

  test('`unreported` usage charges the whole reservation', () => {
    const h = new Host();
    const c = agent('a/quiet', { usd: 2.5 });
    h.request(c);
    h.settle(c.key, hashOf(c), passed(c.key, hashOf(c)), { t: 'unreported' });
    assert.equal(h.state.spentUsd, 2.5);
    assert.equal(h.state.reservedUsd, 0);
  });

  test('a pause queues work but not an ask; a pool the contract lacks refuses', () => {
    const h = new Host();
    h.append({ t: 'owner', act: { t: 'pause' } });
    assert.deepEqual(h.request(agent('p/a')), { t: 'wait', why: { t: 'paused' } });
    assert.equal(h.request(ask('p/q')).t, 'start');
    h.append({ t: 'owner', act: { t: 'resume' } });
    assert.equal(h.request(agent('p/a')).t, 'start');
    assert.deepEqual(h.request(agent('p/gpu', { pools: ['gpu'] })), {
      t: 'refuse',
      reason: 'pool',
    });
  });

  test('after `finished` nothing starts, but settled results are still returned', () => {
    const h = new Host();
    const c = command('c/test', []);
    h.request(c);
    h.settle(c.key, hashOf(c), passed(c.key, hashOf(c)), reported(0));
    h.append({ t: 'finished', reason: { t: 'stopped', by: 'owner' } });
    assert.equal(h.request(c).t, 'reuse');
    assert.deepEqual(decide(h.state, agent('c/new'), hashOf(agent('c/new')), h.now), {
      t: 'closed',
      reason: { t: 'stopped', by: 'owner' },
    });
  });
});

describe('due', () => {
  test('the deadline waits for a running judge and a pending ask, and cuts producers only', () => {
    const h = new Host(contractOf({ budget: { usd: 20, hours: 1 } }));
    const judged = agent('j/judged', { judged: true });
    const producer = agent('j/producer', { pools: ['p2'] });
    const q = ask('j/ask');
    for (const c of [judged, producer, q]) h.request(c);
    h.produce(judged.key, hashOf(judged));
    h.nowMs += 61 * MIN;
    assert.deepEqual(due(h.state, h.now), { t: 'no' });
    assert.deepEqual(
      cutOff(h.state, h.now).map((c) => c.key),
      [producer.key]
    );
    h.settle(judged.key, hashOf(judged), passed(judged.key, hashOf(judged)), reported(0.5));
    assert.deepEqual(due(h.state, h.now), { t: 'no' }, 'the owner has not answered yet');
    h.settle(q.key, hashOf(q), passed(q.key, hashOf(q)), reported(0));
    assert.deepEqual(due(h.state, h.now), { t: 'deadline' });
  });

  test('budget is due once it is all spent', () => {
    const h = new Host(contractOf({ budget: { usd: 2, hours: 5 } }));
    const c = agent('b/all', { usd: 2 });
    h.request(c);
    assert.deepEqual(due(h.state, h.now), { t: 'no' });
    h.settle(c.key, hashOf(c), passed(c.key, hashOf(c)), { t: 'unreported' });
    assert.deepEqual(due(h.state, h.now), { t: 'budget' });
  });
});

// ---- Directed: rewrites ----

describe('rewrite', () => {
  /** v0 asks for a (settled), b (running), c (running); one judged pass is logged. */
  function midRun() {
    const h = new Host(contractOf({ budget: { usd: 50, hours: 5 }, pools: { p1: 10 } }));
    const a = agent('collect/a', { judged: true, usd: 1 });
    const b = agent('collect/b', { usd: 1.5 });
    const c = agent('collect/c', { usd: 1.5 });
    for (const x of [a, b, c]) h.request(x);
    h.produce(a.key, hashOf(a));
    h.settle(a.key, hashOf(a), passed(a.key, hashOf(a)), reported(0.8));
    return { h, a, b, c };
  }

  test('diffOf: settled reused, running attached, new and re-hashed started, unasked running dropped', () => {
    const { h, a, b } = midRun();
    const bv2 = agent('collect/b', { usd: 1.5, brief: 'now with forums' });
    const d = agent('mine/d', { usd: 2 });
    assert.deepEqual(diffOf(h.state, askedOf([a, b, d])), {
      reused: ['collect/a'],
      attached: ['collect/b'],
      started: ['mine/d'],
      dropped: ['collect/c'],
      newCostUsd: 2,
    });
    assert.deepEqual(diffOf(h.state, askedOf([a, bv2])).started, ['collect/b']);
    assert.equal(diffOf(h.state, askedOf([a, bv2])).newCostUsd, 1.5);
  });

  test('a rewrite that satisfies every rule applies', () => {
    const { h, a, b } = midRun();
    const v = judgeRewrite(h.state, {
      version: 1,
      contract: h.state.contract,
      asked: askedOf([a, b]),
      dispositions: { 'collect/c': 'finish' },
    });
    assert.equal(v.t, 'apply');
  });

  test('a contract change never arrives through a rewrite', () => {
    const { h, a, b } = midRun();
    const contract = { ...h.state.contract, budget: { usd: 500, hours: 5 } };
    const v = judgeRewrite(h.state, {
      version: 1,
      contract,
      asked: askedOf([a, b]),
      dispositions: { 'collect/c': 'cancel' },
    });
    assert.deepEqual(v, { t: 'reject', why: { t: 'contract-changed' } });
  });

  test('every dropped running call needs a disposition, and no disposition may be stray', () => {
    const { h, a, b, c } = midRun();
    const base = { version: 1, contract: h.state.contract };
    assert.deepEqual(
      judgeRewrite(h.state, {
        ...base,
        asked: askedOf([a]),
        dispositions: { 'collect/c': 'finish' },
      }),
      {
        t: 'reject',
        why: { t: 'undecided', keys: ['collect/b'] },
      }
    );
    assert.deepEqual(
      judgeRewrite(h.state, {
        ...base,
        asked: askedOf([a, b, c]),
        dispositions: { 'collect/a': 'cancel' },
      }),
      { t: 'reject', why: { t: 'stray-disposition', keys: ['collect/a'] } }
    );
  });

  test('new cost over autoApply needs the owner', () => {
    const { h, a, b } = midRun();
    const big = [1, 2, 3].map((i) => agent(`mine/${i}`, { usd: 2 }));
    const v = judgeRewrite(h.state, {
      version: 1,
      contract: h.state.contract,
      asked: askedOf([a, b, ...big]),
      dispositions: { 'collect/c': 'cancel' },
    });
    assert.deepEqual(v.t === 'needs-owner' && v.why, [
      { t: 'over-auto-apply', newCostUsd: 6, limitUsd: 5 },
    ]);
  });

  test('no judged pass since the last rewrite (or since launch) needs the owner', () => {
    const fresh = new Host();
    const x = agent('x/x', { judged: true });
    fresh.request(x);
    const first = judgeRewrite(fresh.state, {
      version: 1,
      contract: fresh.state.contract,
      asked: askedOf([x]),
      dispositions: {},
    });
    assert.deepEqual(first.t === 'needs-owner' && first.why, [{ t: 'no-progress' }]);
    // A pass, then a rewrite, then nothing new: the second rewrite has no progress again.
    const { h, a, b } = midRun();
    h.rewrite(1, askedOf([a, b]), { 'collect/c': 'cancel' });
    const again = judgeRewrite(h.state, {
      version: 2,
      contract: h.state.contract,
      asked: askedOf([a, b]),
      dispositions: {},
    });
    assert.deepEqual(again.t === 'needs-owner' && again.why, [{ t: 'no-progress' }]);
    assert.deepEqual(
      judgeRewrite(h.state, {
        version: 1,
        contract: h.state.contract,
        asked: [],
        dispositions: {},
      }),
      {
        t: 'reject',
        why: { t: 'stale-version', current: 1, proposed: 1 },
      }
    );
  });

  test('a call dropped with `finish` drains on its reservation, is not dropped again, and re-attaches when asked', () => {
    const { h, a, b, c } = midRun();
    h.rewrite(1, askedOf([a, b]), { 'collect/c': 'finish' });
    const st = statusOf(h.state, c);
    assert.equal(st.t, 'draining');
    assert.equal(h.state.reservedUsd, 3); // b and c, 1.5 each
    assert.deepEqual(dropped(h.state, new Set([a.key])), ['collect/b']);
    h.rewrite(2, askedOf([a, b, c]), {});
    assert.equal(statusOf(h.state, c).t, 'draining', 'not re-attached until the plan asks for it');
    assert.equal(h.request(c).t, 'attach');
    assert.equal(statusOf(h.state, c).t, 'running');
  });

  test('a call dropped with `cancel` keeps its slot until the executor settles it', () => {
    const { h, a, b, c } = midRun();
    h.rewrite(1, askedOf([a, b]), { 'collect/c': 'cancel' });
    assert.equal(statusOf(h.state, c).t, 'cancelling');
    assert.equal(h.state.poolsInUse.get('p1'), 2);
    h.settle(
      c.key,
      hashOf(c),
      { t: 'cancelled', partial: refOf(c.key, hashOf(c)) },
      reported(0.08)
    );
    assert.equal(h.state.poolsInUse.get('p1'), 1);
    assert.equal(h.state.spentUsd, 0.88);
  });
});

// ---- Directed: the fixes the Quint model found (docs/specs/expedition-keyed.qnt) ----

describe('quint fixes', () => {
  test('retry: an errored call is reused until `retried`, then starts again as attempt 2', () => {
    const h = new Host();
    const c = agent('collect/x', { judged: true });
    const hash = hashOf(c);
    h.request(c);
    h.settle(c.key, hash, { t: 'errored', why: 'harness died' }, reported(0.2));
    assert.equal(h.request(c).t, 'reuse');
    h.retry(c.key, hash);
    assert.equal(statusOf(h.state, c).t, 'declared');
    assert.equal(h.request(c).t, 'start');
    const started = h.log.filter((e) => e.t === 'started').map((e) => e.runId);
    assert.deepEqual(started, [
      runIdOf('exp', c.key, hash, 1, 'producer'),
      runIdOf('exp', c.key, hash, 2, 'producer'),
    ]);
    // A result is never re-bought: a passed or failed call does not retry.
    h.produce(c.key, hash);
    h.settle(c.key, hash, passed(c.key, hash), reported(0.3));
    assert.throws(() => h.retry(c.key, hash), /has a result/);
  });

  test('an ask is never cancelled: dropped, it drains; reworded, the old one drains beside the new', () => {
    const h = new Host(contractOf({ budget: { usd: 50, hours: 5 } }));
    const q = ask('ask/which-segment', 'Which segment first?');
    const work = agent('collect/a', { judged: true });
    h.request(q);
    h.request(work);
    h.produce(work.key, hashOf(work));
    h.settle(work.key, hashOf(work), passed(work.key, hashOf(work)), reported(0.5));
    const v = (dispositions: Record<Key, Disposition>) =>
      judgeRewrite(h.state, {
        version: 1,
        contract: h.state.contract,
        asked: askedOf([work]),
        dispositions,
      });
    assert.deepEqual(v({ [q.key]: 'cancel' }), {
      t: 'reject',
      why: { t: 'ask-cancelled', keys: [q.key] },
    });
    const ok = v({});
    assert.deepEqual(ok.t === 'apply' && ok.dropped, { [q.key]: 'finish' });
    // A plan entry that cancels an ask is an impossible log.
    assert.throws(
      () =>
        h.append({
          t: 'plan',
          version: 1,
          by: 'lead',
          why: 'x',
          diff: diffOf(h.state, askedOf([work])),
          dropped: { [q.key]: 'cancel' },
        }),
      /never cancelled/
    );
    // Reworded under the same key: the old ask drains (still answerable), the new one starts.
    const reworded = ask(q.key, 'Which segment first, given the forum results?');
    assert.equal(h.request(reworded).t, 'start');
    assert.equal(statusOf(h.state, q).t, 'draining');
    assert.equal(h.state.pendingAsks.size, 2);
    assert.throws(
      () =>
        h.settle(
          q.key,
          hashOf(q),
          { t: 'cancelled', partial: refOf(q.key, hashOf(q)) },
          reported(0)
        ),
      /cannot settle cancelled/
    );
    h.settle(q.key, hashOf(q), passed(q.key, hashOf(q)), reported(0));
  });

  test('log first: `started` carries the derived run id, and a start that never ran settles at $0', () => {
    const h = new Host(contractOf({ budget: { usd: 20, hours: 1 } }));
    const c = agent('collect/y');
    const hash = hashOf(c);
    h.append({ t: 'declared', call: c, hash, planVersion: 0 });
    assert.throws(
      () =>
        h.append({
          t: 'started',
          key: c.key,
          hash,
          runId: 'issued-by-the-executor',
          reserved: { usd: 1, pools: ['p1'] },
        }),
      /run key derives/
    );
    h.request(c);
    h.nowMs += 61 * MIN;
    // The boot path: logged started, the executor never heard of it, and the deadline passed.
    assert.throws(
      () => h.settle(c.key, hash, { t: 'refused', reason: 'deadline' }, reported(0.4)),
      /spent nothing/
    );
    h.settle(c.key, hash, { t: 'refused', reason: 'deadline' }, reported(0));
    assert.equal(h.state.reservedUsd, 0);
  });

  test('a judge is part of its call: it produces and settles after the deadline, draining too', () => {
    const h = new Host(contractOf({ budget: { usd: 20, hours: 1 }, pools: { p1: 5 } }));
    const kept = agent('collect/kept', { judged: true });
    const dropping = agent('collect/dropping', { judged: true });
    h.request(kept);
    h.request(dropping);
    h.produce(kept.key, hashOf(kept));
    h.settle(kept.key, hashOf(kept), passed(kept.key, hashOf(kept)), reported(0.1));
    h.rewrite(1, askedOf([kept]), { [dropping.key]: 'finish' });
    h.nowMs += 61 * MIN;
    h.produce(dropping.key, hashOf(dropping));
    assert.deepEqual(due(h.state, h.now), { t: 'no' }, 'finishing waits for the judge');
    h.settle(dropping.key, hashOf(dropping), passed(dropping.key, hashOf(dropping)), reported(1));
    assert.deepEqual(due(h.state, h.now), { t: 'deadline' });
  });

  test('a call being cancelled is never judged: an answer that lands settles `cancelled`', () => {
    const h = new Host(contractOf({ budget: { usd: 20, hours: 5 }, pools: { p1: 5 } }));
    const kept = agent('collect/kept', { judged: true });
    const gone = agent('collect/gone', { judged: true });
    h.request(kept);
    h.request(gone);
    h.produce(kept.key, hashOf(kept));
    h.settle(kept.key, hashOf(kept), passed(kept.key, hashOf(kept)), reported(0.1));
    h.rewrite(1, askedOf([kept]), { [gone.key]: 'cancel' });
    assert.throws(() => h.produce(gone.key, hashOf(gone)), /settles cancelled instead/);
    h.settle(
      gone.key,
      hashOf(gone),
      { t: 'cancelled', partial: refOf(gone.key, hashOf(gone)) },
      reported(0.9)
    );
    assert.equal(h.state.spentUsd, 1);
  });

  test('the launch plan is version 0 and comes before any declaration; a key keeps its kind', () => {
    const launched = Entry.parse({
      t: 'launched',
      at: new Date(T0).toISOString(),
      id: 'exp',
      contract: contractOf(),
      baseSha: 'b',
    });
    const c = agent('a/b');
    const declared = Entry.parse({
      t: 'declared',
      at: new Date(T0).toISOString(),
      call: c,
      hash: hashOf(c),
      planVersion: 0,
    });
    assert.throws(() => fold([launched, declared]), /current plan is -1/);
    const plan1 = Entry.parse({
      t: 'plan',
      at: new Date(T0).toISOString(),
      version: 1,
      by: 'lead',
      why: 'x',
      diff: { reused: [], attached: [], dropped: [], started: [], newCostUsd: 0 },
      dropped: {},
    });
    assert.throws(() => fold([launched, plan1]), /launch plan is version 0/);
    const h = new Host();
    h.request(agent('ask/same'));
    assert.throws(() => h.request(ask('ask/same')), /has kind agent; it cannot be declared as ask/);
  });
});

// ---- hash and log validation ----

describe('hashOf', () => {
  test('key order and undefined members do not change it; content does', () => {
    const c = agent('h/one');
    const reordered = Object.fromEntries(Object.entries(c).reverse()) as Call;
    const withUndefined = { ...c, extra: undefined } as unknown as Call;
    assert.equal(hashOf(reordered), hashOf(c));
    assert.equal(hashOf(withUndefined), hashOf(c));
    assert.notEqual(hashOf(agent('h/one', { brief: 'research h/one ' })), hashOf(c));
    assert.notEqual(hashOf({ ...c, pools: ['p2', 'p1'] }), hashOf({ ...c, pools: ['p1', 'p2'] }));
  });
});

describe('fold rejects impossible logs', () => {
  test('a `settled` for a call never declared names its index', () => {
    const h = new Host();
    const bad = Entry.parse({
      t: 'settled',
      at: new Date(T0).toISOString(),
      key: 'ghost/k',
      hash: 'h',
      outcome: { t: 'errored', why: 'x' },
      spent: { t: 'unreported' },
    });
    assert.throws(
      () => fold([...h.log, bad]),
      (e: unknown) =>
        e instanceof ImpossibleEntry && e.index === h.log.length && e.entry === 'settled'
    );
  });

  test('a second `started` for one (key, hash) is an error (I1), as is settling twice (I3)', () => {
    const h = new Host();
    const c = agent('twice/k');
    h.request(c);
    const started = h.log.at(-1) as Entry;
    assert.throws(() => fold([...h.log, started]), ImpossibleEntry);
    h.settle(c.key, hashOf(c), passed(c.key, hashOf(c)), reported(0.1));
    const settled = h.log.at(-1) as Entry;
    assert.throws(() => fold([...h.log, settled]), ImpossibleEntry);
  });

  test('a judged agent cannot pass without its judge, and a log must open with `launched`', () => {
    const h = new Host();
    const c = agent('j/k', { judged: true });
    h.request(c);
    assert.throws(
      () => h.settle(c.key, hashOf(c), passed(c.key, hashOf(c)), reported(0.1)),
      ImpossibleEntry
    );
    assert.throws(() => fold(h.log.slice(1)), ImpossibleEntry);
  });
});
