import { z } from 'zod';

// Expeditions (docs/expeditions-lean-design.md): one source for the record, its acts and labels.
// The server parses records with these once, at load; the client reads the inferred types.

const str = z.string();
const nonEmpty = z.string().min(1);
/** One variant of a `t`-tagged union. */
const v = <T extends string, S extends z.ZodRawShape>(t: T, shape: S) =>
  z.object({ t: z.literal(t), ...shape });

/** One host-run check: execFile argv, no shell; exit 0 passes. */
export const Argv = z
  .array(nonEmpty.refine((w) => !w.includes('\0'), 'no NUL bytes'))
  .min(1)
  .max(64);
export const Done = z.discriminatedUnion('t', [
  v('checks', { checks: z.array(Argv).min(1).max(10) }).strict(),
  v('owner', {}).strict(),
]);
export type Done = z.infer<typeof Done>;
/** The crew's one seat. model/effort absent = the provider's default (absence is the meaning). */
const Seat = z
  .object({ provider: nonEmpty, model: nonEmpty.optional(), reasoningEffort: nonEmpty.optional() })
  .strict();
export const Charter = z
  .object({
    name: str.trim().min(1).max(60),
    goal: str.trim().min(1).max(8000),
    done: Done,
    maxAttempts: z.number().int().min(1).max(60),
    maxLive: z.number().int().min(1).max(4),
    hours: z.number().min(0.25).max(72),
    seat: Seat,
  })
  .strict();
export type Charter = z.infer<typeof Charter>;
/** What the Buddy tool may leave out, and the named defaults it then takes (listed in the reply). */
export const CHARTER_DEFAULTS = { maxLive: 1, hours: 8, seat: { provider: 'claude' } } as const;
export const CharterInput = Charter.partial({ maxLive: true, hours: true, seat: true });

const Lesson = z.discriminatedUnion('t', [v('lesson', { text: str }), v('none', {})]);
export type Lesson = z.infer<typeof Lesson>;
export const CheckOutcome = z.discriminatedUnion('t', [
  v('passed', {}),
  v('failed', { exitCode: z.number(), tail: str }),
  v('timed_out', { tail: str }),
  v('error', { message: str }),
]);
export type CheckOutcome = z.infer<typeof CheckOutcome>;
const CheckRun = z.object({ argv: Argv, outcome: CheckOutcome });
export type CheckRun = z.infer<typeof CheckRun>;
/** `skipped`: not judged, because the expedition finished first or the turn did not answer. */
const Verdict = z.discriminatedUnion('t', [
  v('checks', { pass: z.boolean(), runs: z.array(CheckRun) }),
  v('owner', { pass: z.boolean() }),
  v('skipped', {}),
]);
export type Verdict = z.infer<typeof Verdict>;
/** How the crew turn ended; sha = the attempt branch tip at turn end (= base if never committed).
 * `lost`: neither the branch nor the attempt's tree resolved, so sha is the base. Only an
 * `answered` turn is judged; the others end `skipped`. */
const TurnEnd = z.object({
  at: str,
  turn: z.enum(['answered', 'failed', 'cancelled', 'lost']),
  sha: str,
  lesson: Lesson,
});
export type TurnEnd = z.infer<typeof TurnEnd>;
/** `interrupted` (a restart) is not counted against the budget. */
const AttemptPhase = z.discriminatedUnion('t', [
  v('starting', {}),
  v('running', { requestId: str }),
  v('interrupted', { at: str }),
  v('judging', { end: TurnEnd }),
  v('judged', { end: TurnEnd, verdict: Verdict }),
]);
/** released.salvageRef null: the tree was clean. absent: never created. left: Cambium refused. */
const Tree = z.discriminatedUnion('t', [
  v('planned', {}),
  v('live', { path: str }),
  v('released', { salvageRef: str.nullable() }),
  v('absent', {}),
  v('left', { reason: str }),
]);
export type Tree = z.infer<typeof Tree>;
const Attempt = z.object({
  n: z.number().int().min(1),
  workspace: str,
  branch: str,
  startedAt: str,
  tree: Tree,
  phase: AttemptPhase,
});
export type Attempt = z.infer<typeof Attempt>;

const Origin = z.discriminatedUnion('t', [
  v('thread', { channelId: str, rootId: str }),
  v('direct', {}),
]);
export type Origin = z.infer<typeof Origin>;
/** baseSha: main at launch, every attempt's base and the oracle source. chatSeenOrd '' = none. */
const Launch = z.object({
  at: str,
  deadline: str,
  repoRoot: str,
  baseSha: str,
  crewBuddyId: str,
  chatChannelId: str,
  chatSeenOrd: str,
});
export type Launch = z.infer<typeof Launch>;
const FinishReason = z.discriminatedUnion('t', [
  v('passed', { n: z.number() }),
  v('budget', {}),
  v('deadline', {}),
  v('stopped', { by: str }),
  v('setup_failed', { detail: str }),
]);
export type FinishReason = z.infer<typeof FinishReason>;
const State = z.discriminatedUnion('t', [
  v('draft', { issues: z.array(str) }),
  v('running', { launch: Launch }),
  v('paused', { launch: Launch }),
  v('finished', { launch: Launch, at: str, reason: FinishReason }),
]);
export type State = z.infer<typeof State>;
export const Expedition = z
  .object({
    v: z.literal(1),
    id: str,
    workspaceId: str,
    createdAt: str,
    launcherId: str,
    origin: Origin,
    charter: Charter,
    state: State,
    attempts: z.array(Attempt),
    notes: z.array(z.object({ at: str, by: str, text: str })),
  })
  .strict();
export type Expedition = z.infer<typeof Expedition>;

/** GET /api/buddies/expeditions. An unreadable file is a row too: it shows in every rail. */
export type ExpeditionRow =
  | ({ t: 'ok' } & ExpeditionSummary)
  | { t: 'unreadable'; id: string; reason: string };
/** needsOwner: an attempt waits on the owner's verdict. crewBuddyId null: not launched. */
export type ExpeditionSummary = {
  id: string;
  name: string;
  workspaceId: string;
  state: State['t'];
  label: string;
  needsOwner: boolean;
  crewBuddyId: string | null;
};

const ACT = {
  launch: z.object({ do: z.literal('launch') }).strict(),
  pause: z.object({ do: z.literal('pause') }).strict(),
  resume: z.object({ do: z.literal('resume') }).strict(),
  stop: z.object({ do: z.literal('stop') }).strict(),
  extend: z.object({ do: z.literal('extend'), hours: z.number().positive().max(72) }).strict(),
  verdict: z.object({ do: z.literal('verdict'), n: z.number().int(), pass: z.boolean() }).strict(),
  note: z.object({ do: z.literal('note'), text: str.trim().min(1).max(2000) }).strict(),
  retire: z.object({ do: z.literal('retire') }).strict(),
};
/** Owner/Buddy acts: one schema for HTTP, chat and tool. */
export const Act = z.discriminatedUnion('do', [
  ACT.launch,
  ACT.pause,
  ACT.resume,
  ACT.stop,
  ACT.extend,
  ACT.verdict,
  ACT.note,
  ACT.retire,
]);
export type Act = z.infer<typeof Act>;
/** The Buddy tool's acts, chosen by name (launch, verdict and retire are the owner's). */
export const BuddyAct = z.discriminatedUnion('do', [
  ACT.pause,
  ACT.resume,
  ACT.stop,
  ACT.extend,
  ACT.note,
]);
const LIVE = ['running', 'paused'] as const;
/** The one guard table: which states accept which act (server refuses; client shows buttons). */
export const ALLOWED: Record<Act['do'], readonly State['t'][]> = {
  launch: ['draft'],
  pause: ['running'],
  resume: ['paused'],
  stop: LIVE,
  extend: LIVE,
  verdict: LIVE,
  note: LIVE,
  retire: ['draft', 'finished'],
};
/** Attempts the budget counts (everything but interrupted). */
export const counted = (x: Expedition) =>
  x.attempts.filter((a) => a.phase.t !== 'interrupted').length;

export function stateLabel(x: Expedition): string {
  const s = x.state;
  switch (s.t) {
    case 'draft':
      return 'Draft';
    case 'running':
      return `Running · ${counted(x)}/${x.charter.maxAttempts}`;
    case 'paused':
      return 'Paused';
    case 'finished':
      return finishedLabel(s.reason);
  }
}
const FINISHED: { [K in FinishReason['t']]: (r: Extract<FinishReason, { t: K }>) => string } = {
  passed: (r) => `Passed (a${r.n})`,
  budget: () => 'Stopped · budget spent',
  deadline: () => 'Stopped · deadline',
  stopped: (r) => (r.by === 'owner' ? 'Stopped by you' : 'Stopped by a Buddy'),
  setup_failed: (r) => `Setup failed: ${r.detail}`,
};
const finishedLabel = (r: FinishReason) => (FINISHED[r.t] as (r: FinishReason) => string)(r);
/** "checking" or "needs your verdict" while judging, by the charter's done. */
export function attemptResult(a: Attempt, done: Done): string {
  const p = a.phase;
  switch (p.t) {
    case 'starting':
    case 'running':
    case 'interrupted':
      return p.t;
    case 'judging':
      return done.t === 'checks' ? 'checking' : 'needs your verdict';
    case 'judged':
      return p.end.turn === 'answered'
        ? verdictLabel(p.verdict)
        : `${verdictLabel(p.verdict)} (turn ${p.end.turn})`;
  }
}
function verdictLabel(v: Verdict): string {
  switch (v.t) {
    case 'checks':
      return v.pass ? 'pass' : `fail (${v.runs.map((r) => r.outcome.t).join(', ')})`;
    case 'owner':
      return v.pass ? 'pass' : 'fail';
    case 'skipped':
      return 'skipped';
  }
}
