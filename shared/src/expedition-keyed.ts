import { z } from 'zod';

// Keyed expeditions (docs/expeditions/keyed/v1/DESIGN.md §4): the canonical types. One source for
// the Contract, a Call, its Outcome, the Log, the timeline fold over it, and the wire projection a
// client reads (KeyedRow, KeyedView). Everything read from disk, from a plan process or off the
// wire is parsed with these once (κ); the kernel works on the parsed values only.
// Exported from index.ts as the namespace `keyed`: names collide with the old expedition.ts.
// Pattern: one type source (docs/patterns.md#one-type-source)

const str = z.string();
const nonEmpty = z.string().min(1);
/** One variant of a `t`-tagged union. */
const v = <T extends string, S extends z.ZodRawShape>(t: T, shape: S) =>
  z.object({ t: z.literal(t), ...shape }).strict();

/** `phase/step/id`, built by the authoring library. */
export const Key = nonEmpty;
export type Key = string;
/** Covers the whole canonical call, brief text included. */
export type Hash = string;
/** The address of a stored output: `<key>@<hash>`. */
export const RefId = nonEmpty;
export type RefId = string;
export const refOf = (key: Key, hash: Hash): RefId => `${key}@${hash}`;

export const Seat = v('seat', { provider: nonEmpty, model: nonEmpty, effort: nonEmpty });
export type Seat = z.infer<typeof Seat>;
export const Who = z.discriminatedUnion('t', [v('buddy', { id: nonEmpty }), Seat]);
export type Who = z.infer<typeof Who>;

/** A judge as the plan authors it: a review names its rubric brief. */
export const Judge = z.discriminatedUnion('t', [
  v('none', {}),
  v('check', { command: nonEmpty }),
  v('review', { rubric: nonEmpty, by: Who }),
]);
export type Judge = z.infer<typeof Judge>;
/** A judge as a canonical call carries it: a review's rubric is rendered into `brief`, so the
 * call's hash covers the rubric's words (editing a rubric re-judges, like editing a brief). */
export const CallJudge = z.discriminatedUnion('t', [
  v('none', {}),
  v('check', { command: nonEmpty }),
  v('review', { rubric: nonEmpty, by: Who, brief: nonEmpty }),
]);
export type CallJudge = z.infer<typeof CallJudge>;
/** What judges an existing output: a judge's run, or a done criterion the host evaluates. */
export const Verdict = z.discriminatedUnion('t', [
  v('check', { command: nonEmpty }),
  v('review', { rubric: nonEmpty, by: Who, brief: nonEmpty }),
]);
export type Verdict = z.infer<typeof Verdict>;

// ---- Contract: the owner's ----
export const Criterion = z.discriminatedUnion('t', [
  v('check', { command: nonEmpty }),
  v('review', { rubric: nonEmpty, by: Seat }),
  v('owner', { question: nonEmpty }),
]);
export type Criterion = z.infer<typeof Criterion>;
export const Budget = z
  .object({ usd: z.number().positive(), hours: z.number().positive() })
  .strict();
export type Budget = z.infer<typeof Budget>;
export const Contract = z
  .object({
    goal: nonEmpty,
    done: z.array(Criterion).min(1),
    budget: Budget,
    /** Concurrency caps by pool name. An agent call reserves the pool named for its provider. */
    pools: z.record(nonEmpty, z.number().int().positive()),
    /** Appended verbatim to every brief. */
    rules: z.array(nonEmpty),
    leader: nonEmpty,
    repo: nonEmpty,
    /** A rewrite adding more new cost than this waits for the owner. */
    autoApply: z.object({ usd: z.number().nonnegative() }).strict(),
  })
  .strict();
export type Contract = z.infer<typeof Contract>;

// ---- A call: the only thing that runs ----
/** What a call may read: a stored output, or plain text (an owner's answer, a note). */
export const Input = z.discriminatedUnion('t', [
  v('ref', { ref: RefId }),
  v('text', { text: str }),
]);
export type Input = z.infer<typeof Input>;
/** The commit a checkout or command starts from. */
export const Base = z.discriminatedUnion('t', [v('launch', {}), v('ref', { ref: RefId })]);
export type Base = z.infer<typeof Base>;
export const Max = z
  .object({ usd: z.number().positive(), minutes: z.number().positive() })
  .strict();
export type Max = z.infer<typeof Max>;

export const AgentCall = v('agent', {
  key: Key,
  by: Who,
  /** The rendered brief: `briefs/<step>.md` with slots filled and the contract's rules appended. */
  brief: nonEmpty,
  inputs: z.array(Input),
  /** JSON Schema of the answer the plan reads. */
  output: z.unknown(),
  tree: z.enum(['none', 'checkout']),
  base: Base,
  grant: z.object({ reads: z.array(nonEmpty), web: z.boolean() }).strict(),
  context: z.discriminatedUnion('t', [v('cold', {}), v('continue', { of: RefId })]),
  /** Every pool this call reserves, its provider's included. */
  pools: z.array(nonEmpty),
  /** Covers the producer and its judge. */
  max: Max,
  judge: CallJudge,
});
export const CommandCall = v('command', {
  key: Key,
  /** Argv as one string, without a shell: tokenised by the host (quotes and escapes only). */
  command: nonEmpty,
  on: Base,
  /** JSON Schema of stdout parsed as JSON, or `null` when stdout is not read. */
  output: z.unknown(),
  pools: z.array(nonEmpty),
  maxMinutes: z.number().positive(),
});
export const AskCall = v('ask', {
  key: Key,
  question: nonEmpty,
  answer: z.enum(['text', 'confirm']),
});
/** Host-made, never authored: one done criterion of the contract evaluated on the plan's
 * candidate (`of`). Judgment, not work: it runs past the deadline, like a judge. `max` bounds a
 * review (a check reserves nothing; its minutes bound the check). */
export const VerdictCall = v('verdict', {
  key: Key,
  of: RefId,
  verdict: Verdict,
  pools: z.array(nonEmpty),
  max: Max,
});

/** Why the host wakes the leader (DESIGN §5). */
export const BaseWake = z.discriminatedUnion('t', [
  v('review', { question: str }),
  v('ended-unmet', { gaps: z.array(str) }),
  /** The plan cannot go on: it threw, or its process died. */
  v('stuck', { why: str }),
  v('budget-mark', { percent: z.union([z.literal(50), z.literal(80)]) }),
  v('drained', { key: Key }),
]);
export type BaseWake = z.infer<typeof BaseWake>;
/** What the leader decides at a wake: the `out` of its `leader` call. */
export const LeaderAct = z.discriminatedUnion('t', [
  v('continue', {}),
  v('stop', { why: str }),
  v('rewrite', { folder: nonEmpty, why: str }),
  v('retry', { keys: z.array(Key).min(1) }),
]);
export type LeaderAct = z.infer<typeof LeaderAct>;
export const WakeEvent = z.union([
  BaseWake,
  /** The rewrite or retry the leader asked for at `after` failed and changed nothing. */
  v('rejected', { after: BaseWake, act: LeaderAct, issues: z.array(str) }),
]);
export type WakeEvent = z.infer<typeof WakeEvent>;
/** Host-made: one leader wake, charged to the budget like any call ("reflection is never free").
 * Its key is `leader/<n>`. */
export const LeaderCall = v('leader', { key: Key, event: WakeEvent, max: Max });

export const Call = z.discriminatedUnion('t', [
  AgentCall,
  CommandCall,
  AskCall,
  VerdictCall,
  LeaderCall,
]);
export type Call = z.infer<typeof Call>;
export type AgentCall = z.infer<typeof AgentCall>;
export type CommandCall = z.infer<typeof CommandCall>;
export type AskCall = z.infer<typeof AskCall>;
export type VerdictCall = z.infer<typeof VerdictCall>;
export type LeaderCall = z.infer<typeof LeaderCall>;
export const CallKind = z.enum(['agent', 'command', 'ask', 'verdict', 'leader']);
export type CallKind = Call['t'];

export const Refusal = z.enum(['budget', 'deadline', 'pool', 'needs-owner']);
export type Refusal = z.infer<typeof Refusal>;
/** `out` is the typed answer (an ask's answer is its `out`). */
export const Outcome = z.discriminatedUnion('t', [
  v('passed', { ref: RefId, out: z.unknown() }),
  /** It ran and its judge said no. The output exists. */
  v('failed', { ref: RefId, out: z.unknown(), why: str }),
  /** The turn or command failed. No output; never judged. */
  v('errored', { why: str }),
  /** Partial work is kept at `partial`. */
  v('cancelled', { partial: RefId }),
  v('refused', { reason: Refusal }),
]);
export type Outcome = z.infer<typeof Outcome>;

/** What a call holds while it runs. `usd` is its `max.usd` (0 for a command, an ask or a check). */
export const Reservation = z
  .object({ usd: z.number().nonnegative(), pools: z.array(nonEmpty) })
  .strict();
export type Reservation = z.infer<typeof Reservation>;
/** A harness that reports no usage is charged its whole reservation. */
export const Usage = z.discriminatedUnion('t', [
  v('reported', { usd: z.number().nonnegative() }),
  v('unreported', {}),
]);
export type Usage = z.infer<typeof Usage>;

// ---- The log: append-only; all state is a fold over it ----
export const Disposition = z.enum(['cancel', 'finish']);
export type Disposition = z.infer<typeof Disposition>;
export const Diff = z
  .object({
    /** Finished under the same key and hash: returned from the log, nothing spent. */
    reused: z.array(Key),
    /** Running under the same key and hash: kept. */
    attached: z.array(Key),
    /** Running, and the new plan does not ask for them: each needs a disposition. */
    dropped: z.array(Key),
    /** New, or the same key with a different hash. */
    started: z.array(Key),
    newCostUsd: z.number().nonnegative(),
  })
  .strict();
export type Diff = z.infer<typeof Diff>;
export const Finish = z.discriminatedUnion('t', [
  v('met', { candidate: RefId }),
  v('not-met', { gaps: z.array(str) }),
  v('budget', {}),
  v('deadline', {}),
  v('stopped', { by: str }),
]);
export type Finish = z.infer<typeof Finish>;
export const OwnerAct = z.discriminatedUnion('t', [
  v('pause', {}),
  v('resume', {}),
  v('extend', { hours: z.number().positive() }),
]);
export type OwnerAct = z.infer<typeof OwnerAct>;
export const ReviewDecision = z.enum(['continue', 'rewrite', 'retry', 'stop']);
export type ReviewDecision = z.infer<typeof ReviewDecision>;

/** The Buddy workspace an expedition's agent calls run in (its seat Buddy lives there). A log
 * written before step 4 has none: `.default` keeps it readable, and an agent call in it settles
 * `errored` with that reason instead of guessing a workspace (CONNECT_PLAN §8 step 4). */
export const LaunchWorkspace = z.discriminatedUnion('t', [
  v('workspace', { id: nonEmpty }),
  v('none', {}),
]);
export type LaunchWorkspace = z.infer<typeof LaunchWorkspace>;

const at = { at: str };
export const Entry = z.discriminatedUnion('t', [
  /** `id` names the expedition; every run id is derived from it (core/tables.ts `runIdOf`). */
  v('launched', {
    ...at,
    id: nonEmpty,
    contract: Contract,
    baseSha: nonEmpty,
    workspace: LaunchWorkspace.default({ t: 'none' }),
  }),
  /** Owner only: the new Contract, whole. */
  v('contract', { ...at, contract: Contract, change: str }),
  v('plan', {
    ...at,
    version: z.number().int().nonnegative(),
    by: str,
    why: str,
    diff: Diff,
    dropped: z.record(Key, Disposition),
  }),
  v('declared', { ...at, call: Call, hash: nonEmpty, planVersion: z.number().int().nonnegative() }),
  /** Written BEFORE the executor is asked to start `runId` (log first, R1). */
  v('started', { ...at, key: Key, hash: nonEmpty, runId: nonEmpty, reserved: Reservation }),
  /** An agent's answer exists and its judge has not spoken yet. Written before the judge starts;
   * `spent` is the producer's, kept so the call's total survives a restart. */
  v('produced', {
    ...at,
    key: Key,
    hash: nonEmpty,
    ref: RefId,
    out: z.unknown(),
    judgeRunId: nonEmpty,
    spent: Usage,
  }),
  v('settled', { ...at, key: Key, hash: nonEmpty, outcome: Outcome, spent: Usage }),
  /** An owner or leader act: an `errored`, `cancelled` or `refused` call becomes `declared` again
   * as its next attempt, so the next plan evaluation starts it. */
  v('retried', { ...at, key: Key, hash: nonEmpty, by: nonEmpty }),
  v('review', {
    ...at,
    planVersion: z.number().int().nonnegative(),
    question: str,
    decision: ReviewDecision,
    why: str,
  }),
  v('owner', { ...at, act: OwnerAct }),
  v('finished', { ...at, reason: Finish }),
]);
export type Entry = z.infer<typeof Entry>;

// ---- The timeline: a pure fold over the log, for a UI ----
// A bar is one attempt of one (key, hash): from `started` to `settled`. A call refused before it
// started is a zero-length bar, so every key the plan asked for appears.

export const BarEnd = z.discriminatedUnion('t', [
  v('open', {}),
  v('settled', { at: str, outcome: Outcome }),
]);
export type BarEnd = z.infer<typeof BarEnd>;
export const Bar = z
  .object({
    key: Key,
    hash: nonEmpty,
    kind: CallKind,
    attempt: z.number().int().positive(),
    /** The plan version current when it started (or was refused). */
    planVersion: z.number().int(),
    start: str,
    end: BarEnd,
  })
  .strict();
export type Bar = z.infer<typeof Bar>;
export const Marker = z.discriminatedUnion('t', [
  v('plan', {
    at: str,
    version: z.number().int().nonnegative(),
    by: str,
    why: str,
    diff: Diff,
    dropped: z.record(Key, Disposition),
  }),
  v('review', {
    at: str,
    planVersion: z.number().int().nonnegative(),
    question: str,
    decision: ReviewDecision,
    why: str,
  }),
  v('finished', { at: str, reason: Finish }),
]);
export type Marker = z.infer<typeof Marker>;
export type Timeline = { readonly bars: readonly Bar[]; readonly markers: readonly Marker[] };

/** What the kernel could not act on (an executor reporting what a run cannot do, a plan call
 * that would not canonicalise). Never silent; never state. */
export const Fault = z.object({ at: str, what: str }).strict();
export type Fault = z.infer<typeof Fault>;

type Fold = {
  version: number;
  kinds: Map<string, CallKind>;
  attempts: Map<string, number>;
  open: Map<string, number>;
  bars: Bar[];
  markers: Marker[];
};

export function timelineOf(entries: readonly Entry[]): Timeline {
  const f: Fold = {
    version: -1,
    kinds: new Map(),
    attempts: new Map(),
    open: new Map(),
    bars: [],
    markers: [],
  };
  for (const e of entries) (ON[e.t] as (f: Fold, e: Entry) => void)(f, e);
  return { bars: f.bars, markers: f.markers };
}

const attemptOf = (f: Fold, ref: string) => f.attempts.get(ref) ?? 1;
const kindOf = (f: Fold, ref: string): CallKind => {
  const kind = f.kinds.get(ref);
  if (kind === undefined) throw new Error(`timeline: ${ref} was never declared`);
  return kind;
};

const ON: { [K in Entry['t']]: (f: Fold, e: Extract<Entry, { t: K }>) => void } = {
  launched: () => {},
  contract: () => {},
  plan: (f, e) => {
    f.version = e.version;
    f.markers.push({
      t: 'plan',
      at: e.at,
      version: e.version,
      by: e.by,
      why: e.why,
      diff: e.diff,
      dropped: e.dropped,
    });
  },
  declared: (f, e) => {
    f.kinds.set(refOf(e.call.key, e.hash), e.call.t);
  },
  started: (f, e) => {
    const ref = refOf(e.key, e.hash);
    f.open.set(ref, f.bars.length);
    f.bars.push({
      key: e.key,
      hash: e.hash,
      kind: kindOf(f, ref),
      attempt: attemptOf(f, ref),
      planVersion: f.version,
      start: e.at,
      end: { t: 'open' },
    });
  },
  produced: () => {},
  settled: (f, e) => {
    const ref = refOf(e.key, e.hash);
    const end: BarEnd = { t: 'settled', at: e.at, outcome: e.outcome };
    const index = f.open.get(ref);
    if (index === undefined) {
      f.bars.push({
        key: e.key,
        hash: e.hash,
        kind: kindOf(f, ref),
        attempt: attemptOf(f, ref),
        planVersion: f.version,
        start: e.at,
        end,
      });
      return;
    }
    f.open.delete(ref);
    f.bars[index] = { ...(f.bars[index] as Bar), end };
  },
  retried: (f, e) => {
    const ref = refOf(e.key, e.hash);
    f.attempts.set(ref, attemptOf(f, ref) + 1);
  },
  review: (f, e) => {
    f.markers.push({
      t: 'review',
      at: e.at,
      planVersion: e.planVersion,
      question: e.question,
      decision: e.decision,
      why: e.why,
    });
  },
  owner: () => {},
  finished: (f, e) => {
    f.markers.push({ t: 'finished', at: e.at, reason: e.reason });
  },
};

// ---- The wire: plain JSON projections of one expedition (no Maps, no optional fields) ----
// Built on the server by a pure function of the kernel's state and timeline
// (server/src/expedition-kernel/projection.ts). A field added later needs `.default(...)` here,
// or a client parsing an older server's frame rejects it (AGENTS.md, `Conversation.done`).

export const KeyedStatus = z.discriminatedUnion('t', [
  v('running', {}),
  v('paused', {}),
  v('finished', { reason: Finish }),
]);
export type KeyedStatus = z.infer<typeof KeyedStatus>;
export const KeyedPlan = z.discriminatedUnion('t', [
  v('unplanned', {}),
  v('planned', { version: z.number().int().nonnegative() }),
]);
export type KeyedPlan = z.infer<typeof KeyedPlan>;

/** One expedition in a list. */
export const KeyedRow = z
  .object({
    id: nonEmpty,
    goal: str,
    status: KeyedStatus,
    plan: KeyedPlan,
    spentUsd: z.number().nonnegative(),
    reservedUsd: z.number().nonnegative(),
    budget: Budget,
    launchedAt: str,
    deadline: str,
  })
  .strict();
export type KeyedRow = z.infer<typeof KeyedRow>;

/** Where the newest call under a key stands (the kernel's CallStatus, by name). */
export const LaneStatus = z.enum([
  'declared',
  'running',
  'judging',
  'draining',
  'cancelling',
  'settled',
]);
export type LaneStatus = z.infer<typeof LaneStatus>;
/** One key's history: every attempt of every hash it was declared with, in start order. */
export const Lane = z
  .object({ key: Key, kind: CallKind, status: LaneStatus, bars: z.array(Bar) })
  .strict();
export type Lane = z.infer<typeof Lane>;
export const PendingAsk = z
  .object({
    ref: RefId,
    key: Key,
    question: nonEmpty,
    answer: z.enum(['text', 'confirm']),
    askedAt: str,
  })
  .strict();
export type PendingAsk = z.infer<typeof PendingAsk>;
/** A rewrite the rules gate sent to the owner. The kernel does not hold it (the Owner port does),
 * so the host passes it to the projection. */
export const PendingApproval = z.discriminatedUnion('t', [
  v('none', {}),
  v('pending', { diff: Diff, why: str, reasons: z.array(str) }),
]);
export type PendingApproval = z.infer<typeof PendingApproval>;

export const KeyedView = KeyedRow.extend({
  lanes: z.array(Lane),
  markers: z.array(Marker),
  asks: z.array(PendingAsk),
  approval: PendingApproval,
  faults: z.array(Fault),
}).strict();
export type KeyedView = z.infer<typeof KeyedView>;
