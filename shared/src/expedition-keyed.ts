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
/** What one leader wake, or one done review, may cost and how long it may run. `given` is the
 * owner's own number; `defaulted` is the host's rule applied to the budget (contract.ts
 * `defaultCap`), shown as such so a preview never passes a guess off as the owner's choice. */
const capShape = { usd: z.number().positive(), minutes: z.number().positive() };
export const Cap = z.discriminatedUnion('t', [v('given', capShape), v('defaulted', capShape)]);
export type Cap = z.infer<typeof Cap>;
/** A log written before the caps were in the contract ran every wake and review at $2 / 20 min. */
const OLD_CAP: Cap = { t: 'defaulted', usd: 2, minutes: 20 };
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
    /** Each leader wake is charged to the budget (DESIGN §5): this bounds one. */
    leaderWake: Cap.default(OLD_CAP),
    /** Bounds each host-run done review (and the minutes of a done check). */
    doneReview: Cap.default(OLD_CAP),
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
  /** `why` is required of a new answer (executor/answer.ts refuses an empty one); `.default`
   * keeps a log written before it existed readable, with the reason it never recorded. */
  v('continue', { why: str.default('') }),
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
/** The owner's ruling when the leader's acts at one wake point were rejected twice in a row (the
 * host stopped waking it and asked: kernel change.ts). `unclear`: the reply named none of the
 * three, so the host asks again. */
export const LeaderRuling = z.discriminatedUnion('t', [
  v('continue', {}),
  v('stop', {}),
  v('rewrite', {}),
  v('unclear', { said: str }),
]);
export type LeaderRuling = z.infer<typeof LeaderRuling>;
export const OwnerAct = z.discriminatedUnion('t', [
  v('pause', {}),
  v('resume', {}),
  v('extend', { hours: z.number().positive() }),
  /** Written by the host from the owner's answer to its ask, never sent by a client. */
  v('leader-stuck', { ruling: LeaderRuling }),
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

export const ActVerdict = z.discriminatedUnion('t', [
  v('accepted', {}),
  v('rejected', { issues: z.array(str) }),
]);
export type ActVerdict = z.infer<typeof ActVerdict>;

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
  /** What became of one leader act (`key`: its `leader/<n>` call) answering `after`: it took
   * effect, or a gate refused it and nothing changed. Two rejected in a row at one wake point
   * stop the host waking the leader there (kernel change.ts); the fold keeps the run. */
  v('act', { ...at, key: Key, after: BaseWake, act: LeaderAct, verdict: ActVerdict }),
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
/** What one bar cost, as the kernel charges it (core/tables.ts `chargeOf`). */
export const BarCost = z.discriminatedUnion('t', [
  /** Running: it holds its reservation (`max.usd`; 0 for a command, a check or an ask). */
  v('holding', { reservedUsd: z.number().nonnegative() }),
  /** Settled with a reported spend. */
  v('spent', { usd: z.number().nonnegative() }),
  /** Settled with no usage reported: charged its whole reservation (DESIGN q2). */
  v('charged', { usd: z.number().nonnegative() }),
  /** A server older than the cost field sent none (the wire default). */
  v('unknown', {}),
]);
export type BarCost = z.infer<typeof BarCost>;
/** The exact prompt one agent turn of a bar was sent, as a file in the expedition directory
 * (server executor/prompts.ts): its producer's, and its review judge's when it has one. */
export const BarPrompt = z.object({ role: z.enum(['producer', 'judge']), path: nonEmpty }).strict();
export type BarPrompt = z.infer<typeof BarPrompt>;
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
    cost: BarCost.default({ t: 'unknown' }),
    /** The log does not know where prompts are: the fold leaves this empty and the server adds
     * the files that exist. An older server sent none. */
    prompts: z.array(BarPrompt).default([]),
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
  /** Each open bar by ref: where it is, and the reservation an unreported settle is charged. */
  open: Map<string, { index: number; reservedUsd: number }>;
  bars: Bar[];
  markers: Marker[];
};

const CHARGED: { [K in Usage['t']]: (u: Extract<Usage, { t: K }>, reserved: number) => BarCost } = {
  reported: (u) => ({ t: 'spent', usd: u.usd }),
  unreported: (_u, reserved) => ({ t: 'charged', usd: reserved }),
};
const chargedOf = (u: Usage, reserved: number): BarCost => CHARGED[u.t](u as never, reserved);

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
    f.open.set(ref, { index: f.bars.length, reservedUsd: e.reserved.usd });
    f.bars.push({
      key: e.key,
      hash: e.hash,
      kind: kindOf(f, ref),
      attempt: attemptOf(f, ref),
      planVersion: f.version,
      start: e.at,
      end: { t: 'open' },
      cost: { t: 'holding', reservedUsd: e.reserved.usd },
      prompts: [],
    });
  },
  produced: () => {},
  settled: (f, e) => {
    const ref = refOf(e.key, e.hash);
    const end: BarEnd = { t: 'settled', at: e.at, outcome: e.outcome };
    const open = f.open.get(ref);
    if (open === undefined) {
      // Refused before it started: it held nothing.
      f.bars.push({
        key: e.key,
        hash: e.hash,
        kind: kindOf(f, ref),
        attempt: attemptOf(f, ref),
        planVersion: f.version,
        start: e.at,
        end,
        cost: chargedOf(e.spent, 0),
        prompts: [],
      });
      return;
    }
    f.open.delete(ref);
    f.bars[open.index] = {
      ...(f.bars[open.index] as Bar),
      end,
      cost: chargedOf(e.spent, open.reservedUsd),
    };
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
  act: () => {},
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
    /** An ask is unanswered or a rewrite waits for the owner's approval. */
    needsYou: z.boolean().default(false),
    /** The Buddy workspace it was launched in (a rail lists a workspace's own). */
    workspace: LaunchWorkspace.default({ t: 'none' }),
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
/** What an ask is about. The owner is asked to accept a candidate by an opaque ref; this is what
 * that ref holds: the standard report's `summary` (else a bounded excerpt of the typed answer as
 * text) and the path of its answer file. `.default` keeps an older server's frame readable. */
export const AskAbout = z.discriminatedUnion('t', [
  v('nothing', {}),
  v('candidate', { ref: RefId, summary: str, answerPath: nonEmpty }),
]);
export type AskAbout = z.infer<typeof AskAbout>;
export const PendingAsk = z
  .object({
    ref: RefId,
    key: Key,
    question: nonEmpty,
    answer: z.enum(['text', 'confirm']),
    askedAt: str,
    about: AskAbout.default({ t: 'nothing' }),
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

// ---- Launching (owner HTTP only: `POST /api/buddies/keyed-expeditions/{preview,launch}`) ----

/** Whether a turn's harness holds it to one capability, or can only tell it (agent-cli
 * `Enforcement`, by value: shared does not depend on the harness wrapper). */
export const GrantEnforcement = z.discriminatedUnion('t', [
  v('enforced', {}),
  v('advisory', { reason: nonEmpty }),
]);
export type GrantEnforcement = z.infer<typeof GrantEnforcement>;
/** One turn's capabilities, each enforced or advisory on its harness (agent-cli
 * `CapabilityReport`; `reads`/`writes` split its file access). */
export const TurnGrants = z
  .object({
    reads: GrantEnforcement,
    writes: GrantEnforcement,
    shell: GrantEnforcement,
    web: GrantEnforcement,
    agents: GrantEnforcement,
    schedule: GrantEnforcement,
    mcp: GrantEnforcement,
    instructions: GrantEnforcement,
  })
  .strict();
export type TurnGrants = z.infer<typeof TurnGrants>;
/** The kinds of expedition turn, each with its own limits (server expedition-kernel/access.ts):
 * an agent call without a tree, one with a checkout, a review judge, a leader wake. */
export const TurnKind = z.enum(['call', 'checkout', 'judge', 'leader']);
export type TurnKind = z.infer<typeof TurnKind>;
/** Where a preview's access row comes from: a step of the plan's cast table (every step, called
 * or not, known before any call), a call the dry run reached (the first wave), or the contract
 * (the leader's wakes, its done reviews). `unstated`: a server older than the field sent none. */
export const TurnSource = z.enum(['cast-table', 'first-wave', 'contract', 'unstated']);
export type TurnSource = z.infer<typeof TurnSource>;
/** What one turn of a launch would be allowed, on the harness it would run on. `label` is the
 * step's name for a cast-table row, the call's key for a first-wave one, `done/<i>` for a done
 * criterion's review, `leader` for the leader's wakes. */
export const TurnAccess = z
  .object({
    label: nonEmpty,
    from: TurnSource.default('unstated'),
    turn: TurnKind,
    harness: z.discriminatedUnion('t', [
      v('known', { provider: nonEmpty, grants: TurnGrants }),
      v('unknown', { why: nonEmpty }),
    ]),
  })
  .strict();
export type TurnAccess = z.infer<typeof TurnAccess>;

/** A plan folder's gates, run without writing anything: what a launch of it would start first. */
export const PreviewCall = z
  .object({ key: Key, kind: CallKind, reservedUsd: z.number().nonnegative() })
  .strict();
export type PreviewCall = z.infer<typeof PreviewCall>;
/** A first-wave call of a proposal, with who does it in words (`claude · opus-5 · high`,
 * `buddy <id>`, `host command`, `you`). */
export const ProposedCall = PreviewCall.extend({ who: nonEmpty }).strict();
export type ProposedCall = z.infer<typeof ProposedCall>;
const CleanPreview = v('clean', {
  goal: str,
  leader: nonEmpty,
  repo: nonEmpty,
  budget: Budget,
  /** The calls a dry run of the plan asked for before it waited on any answer. */
  firstWave: z.array(PreviewCall),
  /** Σ of their reservations: what the first wave may spend. */
  costUsd: z.number().nonnegative(),
  /** Per step of the cast table, per call of the first wave, and the leader and done reviews:
   * which of its limits its harness enforces and which are advisory. An older server sent none. */
  access: z.array(TurnAccess).default([]),
});
export const KeyedPreview = z.discriminatedUnion('t', [
  CleanPreview,
  v('rejected', { gate: nonEmpty, issues: z.array(str) }),
]);
export type KeyedPreview = z.infer<typeof KeyedPreview>;

/** The grants of one turn that its harness only advises (`advisory`), with why; or why the
 * harness is unknown. What a launch's reader must know before trusting "no web" or "read-only". */
export type AdvisoryGrants =
  | { readonly t: 'known'; readonly provider: string; readonly advisory: readonly string[] }
  | { readonly t: 'unknown'; readonly why: string };
export function advisoryGrants(a: TurnAccess): AdvisoryGrants {
  return a.harness.t === 'unknown'
    ? { t: 'unknown', why: a.harness.why }
    : {
        t: 'known',
        provider: a.harness.provider,
        advisory: Object.entries(a.harness.grants).flatMap(([name, g]) =>
          g.t === 'advisory' ? [`${name}: ${g.reason}`] : []
        ),
      };
}

// ---- Proposing (the Buddy tool `expedition` action `propose`; the chat card) ----

/** What a proposal card's post carries (as one `keyed-proposal:<json>` evidence entry): the clean
 * preview the Buddy was shown, where the folder is, and the digest of its files at that moment.
 * Launch sends the digest back; the server refuses a folder that no longer matches it. */
export const ProposedPreview = CleanPreview.extend({ firstWave: z.array(ProposedCall) }).strict();
export type ProposedPreview = z.infer<typeof ProposedPreview>;
export const KeyedProposal = z
  .object({ folder: nonEmpty, workspaceId: nonEmpty, digest: nonEmpty, preview: ProposedPreview })
  .strict();
export type KeyedProposal = z.infer<typeof KeyedProposal>;
export const PROPOSAL_EVIDENCE = 'keyed-proposal:';

/** Whether the keyed host can launch: live, or read-only with the reason (flag off, execution
 * disabled). */
export const KeyedMode = z.discriminatedUnion('t', [
  v('live', {}),
  v('read-only', { why: nonEmpty }),
]);
export type KeyedMode = z.infer<typeof KeyedMode>;
/** What a proposal card needs to know now (`GET …/proposals/:digest?folder=`). */
export const KeyedProposalStatus = z
  .object({
    mode: KeyedMode,
    /** The expedition started from this digest, when one was. */
    launched: z.discriminatedUnion('t', [v('no', {}), v('yes', { id: nonEmpty })]),
    /** The folder's files now against the proposal's digest. */
    folder: z.discriminatedUnion('t', [v('unchanged', {}), v('changed', { why: nonEmpty })]),
  })
  .strict();
export type KeyedProposalStatus = z.infer<typeof KeyedProposalStatus>;
