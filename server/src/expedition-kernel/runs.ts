import type { Judging, Profile, Stage } from './core';
import type { RawOutcome, RunSpec } from './ports';
import type { AgentCall, Call, CallJudge, Outcome, RefId, Usage, Verdict } from './types';

// Calls ↔ raw runs, as tables. Pure: what the executor is asked to run for a call, and what a
// raw run's end means for the call it belongs to. The kernel only dispatches on these.

type PerCall<R> = { [K in Call['t']]: (c: Extract<Call, { t: K }>) => R };

/** The producer run of a call. A leader wake is not an executor run (the Leader port runs it). */
export type ProducerRun =
  | { readonly t: 'executor'; readonly spec: RunSpec }
  | { readonly t: 'leader' };
const PRODUCER: PerCall<ProducerRun> = {
  agent: (call) => ({ t: 'executor', spec: { t: 'agent', call } }),
  command: (call) => ({ t: 'executor', spec: { t: 'command', call } }),
  ask: (call) => ({ t: 'executor', spec: { t: 'ask', call } }),
  verdict: (call) => ({ t: 'executor', spec: verdictSpec(call.verdict, call.of) }),
  leader: () => ({ t: 'leader' }),
};
export const producerRun = (call: Call): ProducerRun => PRODUCER[call.t](call as never);

const VERDICT: { [K in Verdict['t']]: (v: Extract<Verdict, { t: K }>, of: RefId) => RunSpec } = {
  check: (v, of) => ({ t: 'check', command: v.command, of }),
  review: (v, of) => ({ t: 'review', by: v.by, brief: v.brief, of }),
};
const verdictSpec = (v: Verdict, of: RefId): RunSpec => VERDICT[v.t](v as never, of);

/** The judge run of a judged agent call, on what its producer stored at `of`. */
export function judgeSpec(call: AgentCall, of: RefId): RunSpec {
  return JUDGE_SPEC[call.judge.t](call.judge as never, of);
}
const JUDGE_SPEC: {
  [K in CallJudge['t']]: (j: Extract<CallJudge, { t: K }>, of: RefId) => RunSpec;
} = {
  none: () => {
    throw new Error('an unjudged call has no judge run');
  },
  check: (j, of) => verdictSpec(j, of),
  review: (j, of) => verdictSpec(j, of),
};

/** The judge run of a call that produced: only a judged agent call does. */
export const judgeRunOf = (call: Call, of: RefId): RunSpec => JUDGE_OF[call.t](call as never, of);
const notJudged = (c: Call): never => {
  throw new Error(`${c.key} is a ${c.t} call; only an agent call has a judge`);
};
const JUDGE_OF: { [K in Call['t']]: (c: Extract<Call, { t: K }>, of: RefId) => RunSpec } = {
  agent: (c, of) => judgeSpec(c, of),
  command: notJudged,
  ask: notJudged,
  verdict: notJudged,
  leader: notJudged,
};

// ---- a raw run ended: what it means for its call ----

export type Ending =
  /** The call settles. `spent` is the call's total (producer and judge). */
  | { readonly t: 'settle'; readonly outcome: Outcome; readonly spent: Usage }
  /** A judged agent answered; its judge starts next. */
  | { readonly t: 'produce'; readonly out: unknown; readonly spent: Usage }
  /** The run ended in a way its kind cannot (an ask that did not get an answer): the call stays
   * as it is and the kernel reports a fault. */
  | { readonly t: 'fault'; readonly why: string };

export type RawEnd = {
  readonly ref: RefId;
  readonly raw: RawOutcome;
  readonly spent: Usage;
  /** The call is being cancelled: an answer that lands now is not judged. */
  readonly cancelling: boolean;
  readonly stage: Stage;
};

const settle = (outcome: Outcome, spent: Usage): Ending => ({ t: 'settle', outcome, spent });
type RawTable = {
  readonly [R in RawOutcome['t']]: (raw: Extract<RawOutcome, { t: R }>, e: RawEnd) => Ending;
};
const ERRORED_OR_CANCELLED = {
  errored: (raw: { why: string }, e: RawEnd) => settle({ t: 'errored', why: raw.why }, e.spent),
  cancelled: (_raw: unknown, e: RawEnd) => settle({ t: 'cancelled', partial: e.ref }, e.spent),
};
/** An agent turn cannot say "no"; only a command, a check or a review can. */
const agentNo = (raw: { why: string }, e: RawEnd): Ending =>
  settle(
    { t: 'errored', why: `the agent run reported "no" (${raw.why}); only a judge says no` },
    e.spent
  );

const UNJUDGED_AGENT: RawTable = {
  ok: (raw, e) => settle({ t: 'passed', ref: e.ref, out: raw.out }, e.spent),
  no: agentNo,
  ...ERRORED_OR_CANCELLED,
};
/** The producer of a judged agent. An errored or cancelled producer is never judged (I7), and
 * neither is one that answered while its call is being cancelled. */
const JUDGED_PRODUCER: RawTable = {
  ok: (raw, e) =>
    e.cancelling
      ? settle({ t: 'cancelled', partial: e.ref }, e.spent)
      : { t: 'produce', out: raw.out, spent: e.spent },
  no: agentNo,
  ...ERRORED_OR_CANCELLED,
};
/** A command's exit code is its judge. A failed command's `out` is its output tail, the shape a
 * command step reads by default. */
const COMMAND: RawTable = {
  ok: (raw, e) => settle({ t: 'passed', ref: e.ref, out: raw.out }, e.spent),
  no: (raw, e) =>
    settle({ t: 'failed', ref: e.ref, out: { tail: raw.why }, why: raw.why }, e.spent),
  ...ERRORED_OR_CANCELLED,
};
/** An ask ends only by being answered (I6). */
const ASK: RawTable = {
  ok: (raw, e) => settle({ t: 'passed', ref: e.ref, out: raw.out }, e.spent),
  no: (raw) => ({
    t: 'fault',
    why: `an ask run reported "no" (${raw.why}); an ask only gets answered`,
  }),
  errored: (raw) => ({ t: 'fault', why: `an ask run errored (${raw.why}); it stays pending` }),
  cancelled: () => ({
    t: 'fault',
    why: 'an ask run reported cancelled; an ask is never cancelled',
  }),
};
const VERDICT_RUN: RawTable = {
  ok: (raw, e) => settle({ t: 'passed', ref: e.ref, out: raw.out }, e.spent),
  no: (raw, e) => settle({ t: 'failed', ref: e.ref, out: null, why: raw.why }, e.spent),
  ...ERRORED_OR_CANCELLED,
};
const NOT_AN_EXECUTOR_RUN: RawTable = {
  ok: () => ({ t: 'fault', why: 'a leader wake is not an executor run' }),
  no: () => ({ t: 'fault', why: 'a leader wake is not an executor run' }),
  errored: () => ({ t: 'fault', why: 'a leader wake is not an executor run' }),
  cancelled: () => ({ t: 'fault', why: 'a leader wake is not an executor run' }),
};

/** The judge of a judged agent spoke: its verdict is the call's. `spent` adds the producer's. */
const judgeTable = (j: Judging): RawTable => ({
  ok: (_raw, e) => settle({ t: 'passed', ref: j.ref, out: j.out }, e.spent),
  no: (raw, e) => settle({ t: 'failed', ref: j.ref, out: j.out, why: raw.why }, e.spent),
  errored: (raw, e) => settle({ t: 'errored', why: `the judge errored: ${raw.why}` }, e.spent),
  cancelled: (_raw, e) => settle({ t: 'cancelled', partial: j.ref }, e.spent),
});

const PRODUCING: { readonly [P in Profile]: RawTable } = {
  'judged-agent': JUDGED_PRODUCER,
  agent: UNJUDGED_AGENT,
  command: COMMAND,
  ask: ASK,
  verdict: VERDICT_RUN,
  leader: NOT_AN_EXECUTOR_RUN,
};

const STAGE: { [K in Stage['t']]: (profile: Profile, s: Extract<Stage, { t: K }>) => RawTable } = {
  producing: (profile) => PRODUCING[profile],
  judging: (_profile, s) => judgeTable(s),
};

/** What the end of the run a live call was waiting on means for it. */
export function endingOf(profile: Profile, e: RawEnd): Ending {
  const table = STAGE[e.stage.t](profile, e.stage as never);
  return table[e.raw.t](e.raw as never, e);
}
