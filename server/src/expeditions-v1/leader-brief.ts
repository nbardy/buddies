import { keyed } from '@unleashd/shared';
import { type CallRecord, type State, chargeOf, usd } from '../expedition-kernel/core';
import type { ExpeditionView } from '../expedition-kernel/ports';
import { answerInstruction } from './executor/answer';
import type { Note } from './owner/book';

// What a leader wake is told (CONNECT_PLAN §2): a compact JSON projection of the kernel's view,
// rendered as a few lines of JSON, then where its folders are and the exact answer format. Never
// page dumps: a call's output is named by the path of its answer file (its "ref"), never inlined,
// so the prompt stays small however much the calls wrote, and the leader reads what it needs.
// Pure: the body is computed once per wake and stored with its request (its key replays it).

export type LeaderBriefInput = {
  readonly runId: string;
  /** `leader/<n>`. */
  readonly key: keyed.Key;
  readonly view: ExpeditionView;
  readonly event: keyed.WakeEvent;
  /** The wake's draft folder: an editable copy of the current plan file. */
  readonly draft: string;
  readonly plans: string;
  readonly notes: readonly Note[];
  /** Answer files of the stored outputs, by ref (only refs whose output is stored). */
  readonly refPaths: ReadonlyMap<keyed.RefId, string>;
};

/** One key's newest call, as the leader reads it. */
export type CallRow = {
  readonly key: keyed.Key;
  readonly kind: keyed.CallKind;
  readonly attempt: number;
  readonly status: CallRecord['status']['t'];
  readonly outcome: keyed.Outcome['t'] | 'none';
  readonly why: string;
  /** What the key has cost so far, every attempt: `$x`, or a charged reservation flagged as such. */
  readonly spent: string;
  /** The answer file of its stored output, or '' when it has none. */
  readonly ref: string;
};
export type LeaderProjection = {
  readonly expedition: string;
  readonly wake: keyed.Key;
  readonly goal: string;
  readonly budget: keyed.Budget;
  readonly spentUsd: number;
  readonly reservedUsd: number;
  readonly deadline: string;
  readonly paused: boolean;
  readonly planVersion: number;
  readonly event: keyed.WakeEvent;
  readonly calls: readonly CallRow[];
  readonly pendingAsks: readonly {
    readonly key: keyed.Key;
    readonly question: string;
    readonly answer: 'text' | 'confirm';
  }[];
  readonly faults: readonly keyed.Fault[];
  readonly ownerNotes: readonly { readonly at: string; readonly text: string }[];
};

const LAST_FAULTS = 10;
const LAST_NOTES = 20;

export function leaderProjection(x: LeaderBriefInput): LeaderProjection {
  const s = x.view.state;
  const spent = spentByKey(x.view.entries);
  return {
    expedition: s.id,
    wake: x.key,
    goal: s.contract.goal,
    budget: s.contract.budget,
    spentUsd: s.spentUsd,
    reservedUsd: s.reservedUsd,
    deadline: new Date(s.deadlineMs).toISOString(),
    paused: s.paused,
    planVersion: versionOf(s),
    event: x.event,
    calls: [...s.calls].map(([key, byHash]) => rowOf(key, newestOf(byHash), spent, x.refPaths)),
    pendingAsks: pendingAsks(s),
    faults: x.view.faults.slice(-LAST_FAULTS),
    ownerNotes: x.notes.slice(-LAST_NOTES).map((n) => ({ at: n.at, text: n.text })),
  };
}

/** The wake's request body. */
export function leaderBody(x: LeaderBriefInput): string {
  const p = leaderProjection(x);
  const { calls, goal, event, ...state } = p;
  return [
    `Leader wake ${x.key} of expedition ${p.expedition} (run ${x.runId}).`,
    'You lead this expedition. Read its state below, decide ONE act and answer with it. You have no Buddy tools in this turn; your working directory is your draft folder.',
    '',
    'WHY YOU ARE WOKEN',
    eventLine(event),
    '',
    'GOAL',
    goal,
    '',
    'STATE',
    JSON.stringify({ ...state, event }),
    '',
    `CALLS (one row per key, its newest call: ${CALL_FIELDS.join(', ')}; "ref" is the answer file of its stored output)`,
    ...(calls.length > 0 ? calls.map((c) => JSON.stringify(c)) : ['(none yet)']),
    '',
    'FOLDERS',
    `- Your draft folder: ${x.draft}. It holds a copy of plan v${p.planVersion} as plan.expedition.ts. The inline contract is the owner's: a rewrite whose evaluated contract differs canonically from the launched one is rejected at the rules gate.`,
    `- To change the plan, edit plan.expedition.ts in the draft folder, then answer rewrite. If the new plan drops calls that are still running, write ${x.draft}/dispositions.json first: {"<key>": "cancel" | "finish"} for each of them.`,
    `- Plan versions so far: ${x.plans}/v<n>.expedition.ts.`,
    '- Read a call output from its "ref" file only when you need it.',
    '',
    answerInstruction({ t: 'act', folder: x.draft }),
  ].join('\n');
}

const CALL_FIELDS = ['key', 'kind', 'attempt', 'status', 'outcome', 'why', 'spent', 'ref'] as const;
const _rowFields: readonly (keyof CallRow)[] = CALL_FIELDS;
void _rowFields;

const EVENT: {
  readonly [K in keyed.WakeEvent['t']]: (e: Extract<keyed.WakeEvent, { t: K }>) => string;
} = {
  review: (e) =>
    `The plan reached its review "${e.question}". continue lets it past; rewrite or retry changes course; stop ends the expedition.`,
  'ended-unmet': (e) =>
    `The plan ended without meeting the goal: ${e.gaps.join('; ')}. Rewrite (or retry an errored, cancelled or refused call) to go on; anything else ends the expedition not met.`,
  stuck: (e) => `The plan cannot go on: ${e.why}.`,
  'budget-mark': (e) => `The expedition has spent ${e.percent}% of its budget.`,
  drained: (e) => `${e.key}, dropped by a rewrite and told to finish, has settled.`,
  rejected: (e) =>
    `Your ${e.act.t} at the previous wake changed nothing; it was rejected: ${e.issues.join('; ')}. The event it answered: ${eventLine(e.after)} After two rejected acts in a row at one event, the owner is asked to decide and you are not woken for it again.`,
};
const eventLine = (e: keyed.WakeEvent): string => EVENT[e.t](e as never);

const versionOf = (s: State): number => {
  if (s.plan.t === 'unplanned') throw new Error('a leader wake needs a plan: launch writes v0');
  return s.plan.version;
};

/** The record the newest plan version declared (a key keeps its kind across hashes). */
function newestOf(byHash: ReadonlyMap<keyed.Hash, CallRecord>): [keyed.Hash, CallRecord] {
  const [first, ...rest] = [...byHash];
  if (!first) throw new Error('a declared key has no call');
  return rest.reduce((a, b) => (b[1].declaredIn >= a[1].declaredIn ? b : a), first);
}

const WHY: { readonly [K in keyed.Outcome['t']]: (o: Extract<keyed.Outcome, { t: K }>) => string } =
  {
    passed: () => '',
    failed: (o) => o.why,
    errored: (o) => o.why,
    cancelled: () => '',
    refused: (o) => o.reason,
  };
const SETTLED_AS: {
  readonly [K in CallRecord['status']['t']]: (
    st: Extract<CallRecord['status'], { t: K }>
  ) => Pick<CallRow, 'outcome' | 'why'>;
} = {
  declared: () => ({ outcome: 'none', why: '' }),
  running: () => ({ outcome: 'none', why: '' }),
  judging: () => ({ outcome: 'none', why: '' }),
  draining: () => ({ outcome: 'none', why: '' }),
  cancelling: () => ({ outcome: 'none', why: '' }),
  settled: (st) => ({ outcome: st.outcome.t, why: WHY[st.outcome.t](st.outcome as never) }),
};

function rowOf(
  key: keyed.Key,
  [hash, r]: [keyed.Hash, CallRecord],
  spent: ReadonlyMap<keyed.Key, Spent>,
  refPaths: ReadonlyMap<keyed.RefId, string>
): CallRow {
  const cost = spent.get(key) ?? { usd: 0, unreported: false };
  return {
    key,
    kind: r.call.t,
    attempt: r.attempt,
    status: r.status.t,
    ...(SETTLED_AS[r.status.t] as (st: CallRecord['status']) => Pick<CallRow, 'outcome' | 'why'>)(
      r.status
    ),
    spent: `$${cost.usd.toFixed(2)}${cost.unreported ? ' (some unreported: charged its reservation)' : ''}`,
    ref: refPaths.get(keyed.refOf(key, hash)) ?? '',
  };
}

type Spent = { readonly usd: number; readonly unreported: boolean };
/** What each key has been charged, from the log: each settle charged against its start's
 * reservation (an unreported usage is charged the whole reservation, as the kernel does). */
function spentByKey(entries: readonly keyed.Entry[]): Map<keyed.Key, Spent> {
  const reserved = new Map<keyed.RefId, number>();
  const out = new Map<keyed.Key, Spent>();
  const add = (key: keyed.Key, usdNow: number, unreported: boolean) => {
    const was = out.get(key) ?? { usd: 0, unreported: false };
    out.set(key, { usd: usd(was.usd + usdNow), unreported: was.unreported || unreported });
  };
  for (const e of entries) {
    if (e.t === 'started') reserved.set(keyed.refOf(e.key, e.hash), e.reserved.usd);
    if (e.t === 'settled')
      add(
        e.key,
        chargeOf(e.spent, reserved.get(keyed.refOf(e.key, e.hash)) ?? 0),
        e.spent.t === 'unreported'
      );
  }
  return out;
}

function pendingAsks(s: State): LeaderProjection['pendingAsks'] {
  const out: { key: keyed.Key; question: string; answer: 'text' | 'confirm' }[] = [];
  for (const [key, byHash] of s.calls)
    for (const [hash, r] of byHash)
      if (r.call.t === 'ask' && s.pendingAsks.has(keyed.refOf(key, hash)))
        out.push({ key, question: r.call.question, answer: r.call.answer });
  return out;
}
