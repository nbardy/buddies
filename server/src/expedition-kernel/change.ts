import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { keyed } from '@unleashd/shared';
import { canonicalise } from './canonical';
import { parseContract } from './contract';
import {
  ATTACHED,
  type Asked,
  DISPOSAL,
  type Rejection,
  type State,
  canonicalJson,
  diffOf,
  hashOf,
  judgeRewrite,
  lookup,
  stageOf,
} from './core';
import { evaluateDone } from './done';
import { staticGate, typecheckGate } from './gates';
import type { Expedition, KernelDeps } from './kernel';
import type { Disposed, DroppedInfo } from './ports';
import type { Authored } from './protocol';
import { dryRun } from './runner';

// How a plan changes (DESIGN §5) and how it ends: the leader's wakes, the rewrite gates, and the
// host's own evaluation of `done`. Each wake is a `leader/<n>` call, logged and charged like any
// other; wakes run one at a time, outside the kernel's queue, and every state change they cause
// goes back through it.

// ---- the plan gates, shared by launch and rewrite ----

export type Checked =
  | { readonly t: 'ok'; readonly asked: readonly Asked[] }
  | {
      readonly t: 'failed';
      readonly gate: 'typecheck' | 'dry-run' | 'static';
      readonly issues: readonly string[];
    };

/** Typecheck, then a dry run answered only with what `known` returns, then the static checks on
 * the calls it made. `asked`: those calls, canonical and hashed. */
export async function checkPlan(
  deps: KernelDeps,
  folder: string,
  contract: keyed.Contract,
  known: (call: Authored) => keyed.Outcome | undefined
): Promise<Checked> {
  const typed = await typecheckGate(folder, deps.gates);
  if (typed.t === 'failed') return { t: 'failed', gate: 'typecheck', issues: typed.errors };
  const dry = await dryRun({ folder, known, reviewed: () => false });
  if (dry.end.t === 'threw' || dry.end.t === 'crashed')
    return { t: 'failed', gate: 'dry-run', issues: [JSON.stringify(dry.end)] };
  const checked = staticGate({ contract, folder, calls: dry.calls, providerOf: deps.providerOf });
  if (checked.t === 'failed') return { t: 'failed', gate: 'static', issues: checked.issues };
  const asked: Asked[] = [];
  for (const a of dry.calls) {
    const canon = canonicalise(a, { contract, folder, providerOf: deps.providerOf });
    if (canon.t === 'invalid') return { t: 'failed', gate: 'static', issues: canon.issues };
    asked.push({ call: canon.call, hash: hashOf(canon.call) });
  }
  return { t: 'ok', asked };
}

// ---- wakes ----

type Resolution =
  | { readonly t: 'continue' }
  | { readonly t: 'stop'; readonly why: string }
  | { readonly t: 'rewritten' }
  | { readonly t: 'retried' }
  | { readonly t: 'errored'; readonly why: string }
  | { readonly t: 'refused'; readonly reason: string }
  | { readonly t: 'closed' };

type Rejected = { readonly t: 'rejected'; readonly issues: readonly string[] };
type Applied = { readonly t: 'applied' } | Rejected;

export class Change {
  private chain: Promise<void> = Promise.resolve();
  private readonly inFlight = new Set<string>();
  /** The host is evaluating `done` on a candidate. */
  private evaluating = false;
  /** `ended-unmet` wakes queued or running: each ends in a `finished` of its own. */
  private endings = 0;

  /** The plan has ended and the host is deciding how the expedition ends: `due` waits, so the
   * finish carries the gaps rather than a bare `deadline`. */
  get ending(): boolean {
    return this.evaluating || this.endings > 0;
  }

  constructor(private readonly m: Expedition) {}

  /** Wake the leader for `event` once it is its turn, unless the same event is already queued. */
  wake(event: keyed.BaseWake): void {
    const id = `${this.m.version()}:${canonicalJson(event)}`;
    if (this.inFlight.has(id)) return;
    this.inFlight.add(id);
    const ends = ENDS_THE_PLAN[event.t] ? 1 : 0;
    this.endings += ends;
    this.chain = this.chain
      .then(async () => {
        const r = await this.resolve(event);
        await this.m.serial(() => RESOLVED[event.t](this.m, event as never, r));
      })
      .catch((e: unknown) => this.m.fault(`leader: ${(e as Error).stack ?? String(e)}`))
      .finally(() => {
        this.inFlight.delete(id);
        this.endings -= ends;
      });
  }

  /** Wake the leader until it settles on something other than a rewrite or retry that failed. */
  private async resolve(event: keyed.BaseWake): Promise<Resolution> {
    let next: keyed.WakeEvent = event;
    for (;;) {
      const d = await this.m.hostCall((s) => leaderCall(s, next, this.m.deps));
      if (d.t === 'closed') return { t: 'closed' };
      const act = actOf(d.outcome);
      if (act.t !== 'act') return act.resolution;
      const done = await ACT[act.act.t](this, act.act as never, event);
      if (done.t !== 'rejected') return done;
      next = { t: 'rejected', after: event, act: act.act, issues: [...done.issues] };
    }
  }

  async retry(keys: readonly keyed.Key[]): Promise<Resolution | Rejected> {
    const r = await this.m.serial(() => this.m.retryKeys(keys, this.m.state().contract.leader));
    return r.t === 'done' ? { t: 'retried' } : { t: 'rejected', issues: [r.why] };
  }

  // ---- a rewrite ----

  /** Copy the folder as the next version, run the gates in order, and apply. A rejection changes
   * nothing: no entry is written and the copy is removed (I8). */
  async rewrite(
    act: Extract<keyed.LeaderAct, { t: 'rewrite' }>,
    event: keyed.BaseWake
  ): Promise<Resolution | Rejected> {
    const version = this.m.version() + 1;
    // Anything but an applied rewrite removes the copy, a kernel fault included.
    let result: Applied = reject('kernel', ['the rewrite did not complete']);
    try {
      result = await this.m.store.copyPlan(act.folder, version).then(
        () => this.gated(act, event, version),
        (e: Error) => reject('folder', [`it could not be copied: ${e.message}`])
      );
    } finally {
      if (result.t === 'rejected') await this.m.store.removePlan(version);
    }
    return result.t === 'applied' ? { t: 'rewritten' } : result;
  }

  private async gated(
    act: Extract<keyed.LeaderAct, { t: 'rewrite' }>,
    event: keyed.BaseWake,
    version: number
  ): Promise<Applied> {
    const m = this.m;
    const dest = m.planDir(version);
    const parsed = await readFile(path.join(act.folder, 'contract.md'), 'utf8').then(
      parseContract,
      (e: Error) =>
        ({ t: 'invalid', issues: [`contract.md could not be read: ${e.message}`] }) as const
    );
    if (parsed.t === 'invalid') return reject('contract', parsed.issues);
    const checked = await checkPlan(m.deps, dest, m.state().contract, (a) =>
      knownOutcome(m, a, dest)
    );
    if (checked.t === 'failed') return reject(checked.gate, checked.issues);
    const diff = diffOf(m.state(), checked.asked);
    const choose = diff.dropped.filter((k) => DISPOSAL[attached(m.state(), k).call.t] === 'choose');
    const disposed: Disposed =
      choose.length > 0
        ? await m.deps.leader.dispose(
            { expedition: m.id, folder: act.folder },
            diff,
            droppedInfo(m, choose)
          )
        : { t: 'decided', dispositions: {} };
    if (disposed.t === 'invalid') return reject('dispositions', disposed.issues);
    const { dispositions } = disposed;
    const proposal = { version, contract: parsed.contract, asked: checked.asked, dispositions };
    const verdict = judgeRewrite(m.state(), proposal);
    if (verdict.t === 'reject') return reject('rules', [describe(verdict.why)]);
    if (verdict.t === 'needs-owner') {
      const reasons = verdict.why.map((w) =>
        w.t === 'over-auto-apply'
          ? `new cost $${w.newCostUsd} is over the auto-apply limit $${w.limitUsd}`
          : 'no judged pass since the last rewrite'
      );
      const approved = await m.deps.owner.approve({
        expedition: m.id,
        diff: verdict.diff,
        why: act.why,
        reasons,
      });
      if (!approved) return reject('owner', [`the owner declined: ${reasons.join('; ')}`]);
    }
    // Judged again on the state at apply time: calls kept running while the gates ran.
    return m.serial(async () => {
      const fresh = judgeRewrite(m.state(), proposal);
      if (fresh.t === 'reject') return reject('rules', [describe(fresh.why)]);
      if (event.t === 'review')
        await m.append({
          t: 'review',
          planVersion: m.version(),
          question: event.question,
          decision: 'rewrite',
          why: act.why,
        });
      await m.append({
        t: 'plan',
        version,
        by: m.state().contract.leader,
        why: act.why,
        diff: fresh.diff,
        dropped: { ...fresh.dropped },
      });
      // The `cancel` ones are cancelling now; the kernel re-derives their cancels from the log.
      m.restartPlan(version);
      return { t: 'applied' } as const;
    });
  }

  // ---- ending: the host evaluates `done` ----

  /** The plan returned `candidate`. Checks and reviews first, together; the owner only on a
   * candidate that passed them. All met: `finished: met`. Otherwise the leader hears the gaps. */
  evaluate(candidate: keyed.RefId): void {
    if (this.evaluating) return;
    this.evaluating = true;
    void evaluateDone(this.m, candidate)
      .catch((e: unknown) => {
        this.m.fault(`done: ${(e as Error).stack ?? String(e)}`);
        return 'closed' as const;
      })
      .then(async (gaps) => {
        this.evaluating = false;
        if (gaps === 'closed') return;
        if (gaps.length === 0) await this.m.serial(() => this.m.finish({ t: 'met', candidate }));
        else this.wake({ t: 'ended-unmet', gaps });
      });
  }
}

// ---- tables ----

const reject = (gate: string, issues: readonly string[]): Applied => ({
  t: 'rejected',
  issues: issues.map((i) => `${gate}: ${i}`),
});

type ActHandler<K extends keyed.LeaderAct['t']> = (
  c: Change,
  act: Extract<keyed.LeaderAct, { t: K }>,
  event: keyed.BaseWake
) => Promise<Resolution | Rejected>;
const ACT: { [K in keyed.LeaderAct['t']]: ActHandler<K> } = {
  continue: async () => ({ t: 'continue' }),
  stop: async (_c, act) => ({ t: 'stop', why: act.why }),
  rewrite: (c, act, event) => c.rewrite(act, event),
  retry: (c, act) => c.retry(act.keys),
};

type Woke =
  | { readonly t: 'act'; readonly act: keyed.LeaderAct }
  | { readonly t: 'done'; readonly resolution: Resolution };
/** A leader call settles `passed` with its act as `out`, `errored`, or `refused` (no budget or no
 * time left to reflect). */
function actOf(o: keyed.Outcome): Woke {
  if (o.t === 'passed') {
    const act = keyed.LeaderAct.safeParse(o.out);
    return act.success
      ? { t: 'act', act: act.data }
      : {
          t: 'done',
          resolution: {
            t: 'errored',
            why: `the leader's answer is not an act: ${act.error.message}`,
          },
        };
  }
  if (o.t === 'refused') return { t: 'done', resolution: { t: 'refused', reason: o.reason } };
  if (o.t === 'errored') return { t: 'done', resolution: { t: 'errored', why: o.why } };
  return { t: 'done', resolution: { t: 'errored', why: `a leader wake cannot settle ${o.t}` } };
}

/** What each resolution means, per event. A stop is the run ending "with a gap" (DESIGN §5). */
type Resolve<K extends keyed.BaseWake['t']> = (
  m: Expedition,
  event: Extract<keyed.BaseWake, { t: K }>,
  r: Resolution
) => Promise<void>;
const notMet = (m: Expedition, gaps: readonly string[]) =>
  m.finish({ t: 'not-met', gaps: [...gaps] });
async function onlyStop(m: Expedition, _event: keyed.BaseWake, r: Resolution): Promise<void> {
  if (r.t === 'stop') await notMet(m, [r.why]);
}
const ENDS_THE_PLAN: { readonly [K in keyed.BaseWake['t']]: boolean } = {
  review: false,
  'ended-unmet': true,
  stuck: false,
  'budget-mark': false,
  drained: false,
};
const RESOLVED: { [K in keyed.BaseWake['t']]: Resolve<K> } = {
  review: async (m, event, r) => {
    const review = (decision: 'continue' | 'retry' | 'stop', why: string) =>
      m.append({ t: 'review', planVersion: m.version(), question: event.question, decision, why });
    if (r.t === 'continue') {
      await review('continue', '');
      m.answerReview(event.question);
    } else if (r.t === 'stop' || r.t === 'errored') {
      await review('stop', r.why);
      await notMet(m, [r.why]);
    } else if (r.t === 'retried') await review('retry', 'retried failed calls');
    else if (r.t === 'refused' && r.reason === 'budget') await m.finish({ t: 'budget' });
    // rewritten: the review entry went in with the plan entry. refused for the deadline: the plan
    // waits at the review and `due` finishes it. closed: nothing to do.
  },
  'ended-unmet': async (m, event, r) => {
    if (r.t === 'rewritten' || r.t === 'retried' || r.t === 'closed') return;
    await notMet(m, r.t === 'stop' || r.t === 'errored' ? [...event.gaps, r.why] : event.gaps);
  },
  stuck: onlyStop,
  'budget-mark': onlyStop,
  drained: onlyStop,
};

function leaderCall(s: State, event: keyed.WakeEvent, deps: KernelDeps): keyed.Call {
  let n = 0;
  for (const byHash of s.calls.values())
    for (const r of byHash.values()) if (r.call.t === 'leader') n++;
  return { t: 'leader', key: `leader/${n + 1}`, event, max: deps.limits.leaderWake };
}

/** The dry run of a rewrite answers from the log: a settled call's logged outcome, else nothing. */
function knownOutcome(m: Expedition, a: Authored, folder: string): keyed.Outcome | undefined {
  const s = m.state();
  const canon = canonicalise(a, { contract: s.contract, folder, providerOf: m.deps.providerOf });
  if (canon.t === 'invalid') return undefined;
  const found = lookup(s, canon.call.key, hashOf(canon.call));
  return found.t === 'known' && found.record.status.t === 'settled'
    ? found.record.status.outcome
    : undefined;
}

function attached(s: State, key: keyed.Key) {
  for (const [hash, r] of s.calls.get(key) ?? []) if (ATTACHED[r.status.t]) return { hash, ...r };
  throw new Error(`${key} has no attached call`);
}

function droppedInfo(m: Expedition, keys: readonly keyed.Key[]): DroppedInfo[] {
  return keys.map((key) => {
    const r = attached(m.state(), key);
    const started = [...m.entries()]
      .reverse()
      .find((e) => e.t === 'started' && e.key === key && e.hash === r.hash);
    if (!started) throw new Error(`${key} is attached but its start is not in the log`);
    if (r.status.t !== 'running' && r.status.t !== 'judging')
      throw new Error(`${key} is not attached`);
    return {
      key,
      startedAt: started.at,
      reserved: r.status.run.reserved,
      stage: stageOf(r.status).t,
    };
  });
}

const DESCRIBE: { [K in Rejection['t']]: (r: Extract<Rejection, { t: K }>) => string } = {
  'no-plan-yet': () => 'there is no launch plan yet',
  finished: () => 'the expedition has finished',
  'contract-changed': () => 'the contract is the owner’s; the rewrite changed it',
  'stale-version': (r) => `version ${r.proposed} does not follow ${r.current}`,
  'duplicate-key': (r) => `the key ${r.key} appears twice`,
  'hash-mismatch': (r) => `the hash of ${r.key} is not its call's`,
  undecided: (r) => `no cancel or finish for the dropped running calls ${r.keys.join(', ')}`,
  'stray-disposition': (r) => `dispositions for calls that are not dropped: ${r.keys.join(', ')}`,
  'ask-cancelled': (r) => `an ask is never cancelled: ${r.keys.join(', ')}`,
};
const describe = (r: Rejection): string => DESCRIBE[r.t](r as never);
