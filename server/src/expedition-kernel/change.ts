import { keyed } from '@unleashd/shared';
import { canonicalise } from './canonical';
import { maxOfCap, parseContract } from './contract';
import {
  ATTACHED,
  type Asked,
  DISPOSAL,
  type LeaderActs,
  type RejectedAct,
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
  | {
      readonly t: 'ok';
      readonly contract: keyed.Contract;
      readonly asked: readonly Asked[];
      /** What every turn it may run may do (gates.ts `turnAccessOf`). */
      readonly access: readonly keyed.TurnAccess[];
    }
  | {
      readonly t: 'failed';
      readonly gate: 'contract' | 'typecheck' | 'dry-run' | 'static';
      readonly issues: readonly string[];
    };

/** Typecheck, then a dry run answered only with what `known` returns, then the static checks on
 * the calls it made. `asked`: those calls, canonical and hashed. */
export async function checkPlan(
  deps: KernelDeps,
  file: string,
  known: (call: Authored) => keyed.Outcome | undefined
): Promise<Checked> {
  const typed = await typecheckGate(file, deps.gates);
  if (typed.t === 'failed') return { t: 'failed', gate: 'typecheck', issues: typed.errors };
  const dry = await dryRun({ file, known, reviewed: () => false });
  const parsed = parseContract(dry.contract);
  if (parsed.t === 'invalid') return { t: 'failed', gate: 'contract', issues: parsed.issues };
  const contract = parsed.contract;
  if (dry.end.t === 'threw' || dry.end.t === 'crashed')
    return { t: 'failed', gate: 'dry-run', issues: [JSON.stringify(dry.end)] };
  const checked = staticGate({
    contract,
    cast: dry.cast,
    calls: dry.calls,
    providerOf: deps.providerOf,
  });
  if (checked.t === 'failed') return { t: 'failed', gate: 'static', issues: checked.issues };
  const asked: Asked[] = [];
  for (const a of dry.calls) {
    const canon = canonicalise(a, { contract, providerOf: deps.providerOf });
    if (canon.t === 'invalid') return { t: 'failed', gate: 'static', issues: canon.issues };
    asked.push({ call: canon.call, hash: hashOf(canon.call) });
  }
  return { t: 'ok', contract, asked, access: checked.access };
}

// ---- wakes ----

type Resolution =
  | { readonly t: 'continue'; readonly why: string }
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

  /** Wake the leader until it settles on something other than a rewrite or retry that failed;
   * after two such in a row at this wake point, ask the owner instead of waking it a third time.
   * Each act's fate is logged (`act`), so the count survives a restart (state `leaderActs`). */
  private async resolve(event: keyed.BaseWake): Promise<Resolution> {
    for (;;) {
      const at = atWake(this.m.state().leaderActs, event);
      if (at.t === 'stuck') {
        const ruled = await this.askOwner(event, at.acts);
        if (ruled.t === 'resolved') return ruled.resolution;
        continue;
      }
      let key = '';
      const d = await this.m.hostCall((s) => {
        const call = leaderCall(s, WAKE_EVENT[at.t](event, at as never));
        key = call.key;
        return call;
      });
      if (d.t === 'closed') return { t: 'closed' };
      const act = actOf(d.outcome);
      if (act.t !== 'act') return act.resolution;
      const done = await ACT[act.act.t](this, act.act as never, event);
      const verdict: keyed.ActVerdict =
        done.t === 'rejected' ? { t: 'rejected', issues: [...done.issues] } : { t: 'accepted' };
      await this.m.serial(async () => {
        if (this.m.state().progress.t === 'open')
          await this.m.append({ t: 'act', key, after: event, act: act.act, verdict });
      });
      if (done.t !== 'rejected') return done;
    }
  }

  /** The owner rules on a leader whose acts at `event` were rejected twice in a row: an ask in
   * the expedition thread, its answer logged as the owner's `leader-stuck` act. */
  private async askOwner(
    event: keyed.BaseWake,
    acts: readonly RejectedAct[]
  ): Promise<{ t: 'resolved'; resolution: Resolution } | { t: 'ask-again' }> {
    const key = `owner/leader-stuck-${this.m.state().ownerRulings + 1}`;
    const d = await this.m.hostCall(() => ({
      t: 'ask',
      key,
      question: stuckQuestion(event, acts),
      answer: 'text',
    }));
    if (d.t === 'closed') return { t: 'resolved', resolution: { t: 'closed' } };
    if (d.outcome.t !== 'passed')
      return {
        t: 'resolved',
        resolution: { t: 'errored', why: `the owner's ruling was not given (${d.outcome.t})` },
      };
    const ruling = rulingOf(d.outcome.out);
    await this.m.serial(async () => {
      if (this.m.state().progress.t === 'open')
        await this.m.append({ t: 'owner', act: { t: 'leader-stuck', ruling } });
    });
    return RULED[ruling.t];
  }

  async retry(keys: readonly keyed.Key[]): Promise<Resolution | Rejected> {
    const r = await this.m.serial(() => this.m.retryKeys(keys, this.m.state().contract.leader));
    return r.t === 'done' ? { t: 'retried' } : { t: 'rejected', issues: [r.why] };
  }

  // ---- a rewrite ----

  /** Copy the file as the next version, run the gates in order, and apply. A rejection changes
   * nothing: no entry is written and the copy is removed (I8). */
  async rewrite(
    act: Extract<keyed.LeaderAct, { t: 'rewrite' }>,
    event: keyed.BaseWake
  ): Promise<Resolution | Rejected> {
    const version = this.m.version() + 1;
    // Anything but an applied rewrite removes the copy, a kernel fault included.
    let result: Applied = reject('kernel', ['the rewrite did not complete']);
    try {
      result = await this.m.store.copyPlan(act.file, version).then(
        () => this.gated(act, event, version),
        (e: Error) => reject('file', [`it could not be copied: ${e.message}`])
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
    const dest = m.planFile(version);
    const checked = await checkPlan(m.deps, dest, (a) => knownOutcome(m, a));
    if (checked.t === 'failed') return reject(checked.gate, checked.issues);
    const diff = diffOf(m.state(), checked.asked);
    const choose = diff.dropped.filter((k) => DISPOSAL[attached(m.state(), k).call.t] === 'choose');
    const disposed: Disposed =
      choose.length > 0
        ? await m.deps.leader.dispose(
            { expedition: m.id, file: act.file },
            diff,
            droppedInfo(m, choose)
          )
        : { t: 'decided', dispositions: {} };
    if (disposed.t === 'invalid') return reject('dispositions', disposed.issues);
    const { dispositions } = disposed;
    const proposal = { version, contract: checked.contract, asked: checked.asked, dispositions };
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
  continue: async (_c, act) => ({ t: 'continue', why: act.why }),
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
      await review('continue', r.why);
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

// ---- a leader whose acts keep being rejected ----

/** Rejected acts in a row at one wake point before the host stops waking the leader there. */
export const REJECTED_BEFORE_OWNER = 2;

/** Where the leader stands at this wake point, from the folded log. */
type AtWake =
  | { readonly t: 'fresh' }
  | { readonly t: 'rejected'; readonly last: RejectedAct }
  | { readonly t: 'stuck'; readonly acts: readonly RejectedAct[] }
  | { readonly t: 'rewrite-asked'; readonly last: RejectedAct };
const AT_WAKE: {
  readonly [K in LeaderActs['t']]: (a: Extract<LeaderActs, { t: K }>) => AtWake;
} = {
  clear: () => ({ t: 'fresh' }),
  rejected: (a) =>
    a.acts.length >= REJECTED_BEFORE_OWNER
      ? { t: 'stuck', acts: a.acts }
      : { t: 'rejected', last: a.acts.at(-1) as RejectedAct },
  'rewrite-asked': (a) => ({ t: 'rewrite-asked', last: a.last }),
};
/** A run at another wake point says nothing about this one. */
function atWake(acts: LeaderActs, event: keyed.BaseWake): AtWake {
  if (acts.t !== 'clear' && canonicalJson(acts.after) !== canonicalJson(event))
    return { t: 'fresh' };
  return AT_WAKE[acts.t](acts as never);
}

const OWNER_WANTS_REWRITE =
  'The owner was asked after your acts here were rejected twice, and chose to wait for a rewrite: submit one.';
/** The event a wake carries: the base event, or the rejection it follows (with the owner's
 * request for a rewrite, when there was one). */
const WAKE_EVENT: {
  readonly [K in Exclude<AtWake['t'], 'stuck'>]: (
    event: keyed.BaseWake,
    at: Extract<AtWake, { t: K }>
  ) => keyed.WakeEvent;
} = {
  fresh: (event) => event,
  rejected: (event, at) => ({
    t: 'rejected',
    after: event,
    act: at.last.act,
    issues: [...at.last.issues],
  }),
  'rewrite-asked': (event, at) => ({
    t: 'rejected',
    after: event,
    act: at.last.act,
    issues: [...at.last.issues, OWNER_WANTS_REWRITE],
  }),
};

const RULED: {
  readonly [K in keyed.LeaderRuling['t']]:
    | { t: 'resolved'; resolution: Resolution }
    | { t: 'ask-again' };
} = {
  continue: {
    t: 'resolved',
    resolution: {
      t: 'continue',
      why: 'the owner chose to continue as planned after two rejected leader acts',
    },
  },
  stop: {
    t: 'resolved',
    resolution: { t: 'stop', why: 'the owner stopped it after two rejected leader acts' },
  },
  // The fold now holds `rewrite-asked`: the loop wakes the leader once more, saying so.
  rewrite: { t: 'ask-again' },
  // The fold is unchanged: the loop asks again, under the next key.
  unclear: { t: 'ask-again' },
};

/** The owner's reply, by its first word. */
export function rulingOf(out: unknown): keyed.LeaderRuling {
  const said = typeof out === 'string' ? out : JSON.stringify(out);
  const word = /^\W*(\w+)/.exec(said)?.[1]?.toLowerCase();
  return word === 'continue' || word === 'stop' || word === 'rewrite'
    ? { t: word }
    : { t: 'unclear', said };
}

const EVENT_WORDS: {
  readonly [K in keyed.BaseWake['t']]: (e: Extract<keyed.BaseWake, { t: K }>) => string;
} = {
  review: (e) => `the review "${e.question}"`,
  'ended-unmet': (e) => `the plan's end with done not met (${e.gaps.join('; ')})`,
  stuck: (e) => `the plan being stuck (${e.why})`,
  'budget-mark': (e) => `the ${e.percent}% budget mark`,
  drained: (e) => `the end of the dropped call ${e.key}`,
};
const ACT_WORDS: {
  readonly [K in keyed.LeaderAct['t']]: (a: Extract<keyed.LeaderAct, { t: K }>) => string;
} = {
  continue: () => 'continue',
  stop: () => 'stop',
  rewrite: (a) => `rewrite (${a.why})`,
  retry: (a) => `retry ${a.keys.join(', ')}`,
};
/** Deterministic in the log (a restart asks the same question under the same key). */
export function stuckQuestion(event: keyed.BaseWake, acts: readonly RejectedAct[]): string {
  return [
    `The leader's last ${acts.length} acts at ${EVENT_WORDS[event.t](event as never)} were rejected, so it is not being woken again until you decide.`,
    ...acts.map(
      (a, i) =>
        `${i + 1}. ${a.key}: ${ACT_WORDS[a.act.t](a.act as never)}. Rejected: ${a.issues.join('; ')}`
    ),
    'Reply with one word: "continue" (go on as planned), "stop" (end the expedition, not met), or "rewrite" (wake the leader once more and ask it for a rewrite).',
  ].join('\n');
}

function leaderCall(s: State, event: keyed.WakeEvent): keyed.Call {
  let n = 0;
  for (const byHash of s.calls.values())
    for (const r of byHash.values()) if (r.call.t === 'leader') n++;
  return { t: 'leader', key: `leader/${n + 1}`, event, max: maxOfCap(s.contract.leaderWake) };
}

/** The dry run of a rewrite answers from the log: a settled call's logged outcome, else nothing. */
function knownOutcome(m: Expedition, a: Authored): keyed.Outcome | undefined {
  const s = m.state();
  const canon = canonicalise(a, { contract: s.contract, providerOf: m.deps.providerOf });
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
