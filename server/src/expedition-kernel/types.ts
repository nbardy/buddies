import { z } from 'zod';

// Expeditions v1 kernel: the canonical types (docs/expeditions/keyed/v1/DESIGN.md §4).
// One source for the Contract, a Call, its Outcome and the Log. Everything read from disk or from
// the plan process is parsed with these once (κ); the core works on the parsed values only.
// They live here until the client needs them; then they move to shared/src (one type source).

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
export const Contract = z
  .object({
    goal: nonEmpty,
    done: z.array(Criterion).min(1),
    budget: z.object({ usd: z.number().positive(), hours: z.number().positive() }).strict(),
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
 * review (a check reserves nothing). */
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

const at = { at: str };
export const Entry = z.discriminatedUnion('t', [
  /** `id` names the expedition; every run id is derived from it (core/tables.ts `runIdOf`). */
  v('launched', { ...at, id: nonEmpty, contract: Contract, baseSha: nonEmpty }),
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
    decision: z.enum(['continue', 'rewrite', 'retry', 'stop']),
    why: str,
  }),
  v('owner', { ...at, act: OwnerAct }),
  v('finished', { ...at, reason: Finish }),
]);
export type Entry = z.infer<typeof Entry>;
