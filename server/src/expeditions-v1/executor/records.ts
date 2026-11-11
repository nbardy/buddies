import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { TurnCapabilities } from '@nbardy/agent-cli';
import { keyed } from '@unleashd/shared';
import { z } from 'zod';
import type { RawOutcome, RunSpec } from '../../expedition-kernel/ports';
import { type Read, readJson, writeJsonAtomic } from './durable';

// One durable record per run (CONNECT_PLAN §1 "Durable state"), at `<expDir>/runs/<name>.json`.
// It is what makes `start` idempotent and what `status` answers from, across restarts:
//   host runs (command, check):           (none) → running → settled → closed
//   Buddy calls (agent, review, leader):  (none) → posting → posted → settled → closed
//   owner asks (ask):                     (none) → asking → asked → settled → closed
// and (none) → closed for an id closed before it ever started (a late start is then a no-op).
// A leader wake is not a kernel run kind (the Leader port runs it, leader.ts) but it is a Buddy
// call like any other, so it has the same record under the run id the kernel logged for it.
// A call's record holds everything its settle needs (the answer it expects, its tree, its caps),
// because `status` after a restart has only the run id: the spec is not passed again.

const v = <T extends string, S extends z.ZodRawShape>(t: T, shape: S) =>
  z.object({ t: z.literal(t), ...shape }).strict();

/** zod infers `z.unknown()` fields as optional; the port's `ok` always carries `out`. */
const Ok = v('ok', { out: z.unknown() }).transform((o): RawOutcome => ({ t: 'ok', out: o.out }));
export const RawOutcomeSchema = z.union([
  Ok,
  v('no', { why: z.string() }),
  v('errored', { why: z.string() }),
  v('cancelled', {}),
]);
// What the schema parses to is the port's type (a drift in either is a compile error here).
const _sameRaw: z.ZodType<RawOutcome, z.ZodTypeDef, unknown> = RawOutcomeSchema;
void _sameRaw;

/** What a record runs: a kernel run kind, or a leader wake. */
export type RecordKind = RunSpec['t'] | 'leader';
const RunKind = z.enum(['agent', 'command', 'ask', 'check', 'review', 'leader']);
const _sameKind: z.ZodType<RecordKind> = RunKind;
void _sameKind;

/** The host process that started a host run. A record whose host is not this process belongs to
 * a host that died (one executor per data root per process; two servers never share a root). */
const Host = z.object({ pid: z.number().int().positive() }).strict();
/** The process group of a host run. `leaderStart` is `ps -o lstart=` of the group leader taken
 * right after spawn: a pgid alone could be reused by an unrelated group after a reboot or a long
 * outage, so a restarted host kills the group only while that same leader still runs. */
const Process = z.discriminatedUnion('t', [
  v('starting', {}),
  v('spawned', { pgid: z.number().int().positive(), leaderStart: z.string().min(1) }),
]);
export type Process = z.infer<typeof Process>;
const Tree = z.discriminatedUnion('t', [
  v('none', {}),
  /** A host run's detached worktree, removed when it ends. */
  v('detached', { path: z.string() }),
  /** A `tree: 'none'` call's own working directory (`<run>/work`): kept, never the owner's
   * checkout (briefing.ts TurnDirectory). */
  v('dir', { path: z.string() }),
  /** A `tree: 'checkout'` call's Cambium worktree on its own branch from `base`; released at the
   * end, dirty work kept at a salvage ref. */
  v('checkout', {
    path: z.string(),
    branch: z.string().min(1),
    workspace: z.string().min(1),
    salvageRef: z.string().min(1),
  }),
]);
export type Tree = z.infer<typeof Tree>;

const live = {
  runId: z.string().min(1),
  kind: RunKind,
  /** Past this the run is killed; a restart does not extend it. */
  deadlineAt: z.string(),
  tree: Tree,
};
/** What a closed id settled as, if it did. */
const Last = z.discriminatedUnion('t', [
  v('settled', { raw: RawOutcomeSchema, spent: keyed.Usage }),
  v('never-settled', {}),
]);
export type Last = z.infer<typeof Last>;

/** How a call's turn runs: on its Buddy's own profile, or (a seat) on the call's config. */
const RunOn = z.discriminatedUnion('t', [
  v('profile', {}),
  v('config', {
    config: z
      .object({
        provider: z.string().min(1),
        model: z.string().min(1),
        reasoningEffort: z.string(),
      })
      .strict(),
  }),
]);
export type RunOn = z.infer<typeof RunOn>;
/** What the answer must be: a JSON value of the call's schema, or a review's verdict. */
const Typed = v('typed', { schema: z.unknown() }).transform(
  (a): { readonly t: 'typed'; readonly schema: unknown } => ({ t: 'typed', schema: a.schema })
);
/** A leader wake's answer: one `LeaderAct`; a rewrite must name `folder`, the wake's own draft. */
const Expected = z.union([Typed, v('verdict', {}), v('act', { folder: z.string().min(1) })]);
export type Expected = z.infer<typeof Expected>;
/** Why a call was stopped before it ended on its own: the kernel's cancel, or a cap (a cap is an
 * expiry, recorded as such: its outcome is `errored("exceeded …")`, never a user's cancel). */
const Stop = z.discriminatedUnion('t', [
  v('none', {}),
  v('cancel', {}),
  v('minutes', { minutes: z.number().positive() }),
  v('usd', { usd: z.number().positive(), spent: z.number().nonnegative() }),
]);
export type Stop = z.infer<typeof Stop>;
/** `stop`: what stopped it before it ended on its own, kept so a capped call reads as an expiry
 * after it settled. A host run (and a record written before calls) has `none`. */
const Settled = v('settled', {
  ...live,
  raw: RawOutcomeSchema,
  spent: keyed.Usage,
  stop: Stop.default({ t: 'none' }),
});
/** What the call's turn may do (expedition-kernel/access.ts), decided at start and read by the
 * Buddy server when the turn spawns (call-directory.ts): the record is the authority, never the
 * post. A record written before capability sets does not parse; that is deliberate (a call must
 * never run without its limits). */
const Files = z.discriminatedUnion('t', [
  v('read', { roots: z.array(z.string().min(1)).readonly() }),
  v('write', {
    dir: z.string().min(1),
    reads: z.array(z.string().min(1)).readonly(),
    shell: z.enum(['off', 'on']),
    // A record written before `git` existed (2026-11-11) ran with no git metadata writable:
    // `none` is what its turn had, not a guess.
    git: z
      .discriminatedUnion('t', [
        v('none', {}),
        v('worktree', { dirs: z.array(z.string().min(1)).readonly() }),
      ])
      .default({ t: 'none' }),
  }),
]);
export const Capabilities = z
  .object({
    files: Files,
    web: z.enum(['off', 'on']),
    instructions: z.enum(['none', 'project']),
    agents: z.literal('off'),
    schedule: z.literal('off'),
    mcp: z.literal('none'),
  })
  .strict();
// The harness wrapper's type, exactly (a drift in either is a compile error here).
const _sameCaps: z.ZodType<TurnCapabilities, z.ZodTypeDef, unknown> = Capabilities;
void _sameCaps;

const call = {
  ...live,
  capabilities: Capabilities,
  /** The Buddy the request is from and to (a self-DM). */
  buddyId: z.string().min(1),
  /** The request body, exactly as posted: the key `xk:<runId>` replays only an identical body. */
  body: z.string().min(1),
  runOn: RunOn,
  expected: Expected,
  /** The commit the work starts from: what a `tree: 'none'` answer's ref records. */
  base: z.string().min(1),
  /** The caps on its turns: past `deadlineAt` (posting time + `maxMinutes`) or at 100% of
   * `maxUsd` the call is stopped and settles `errored("exceeded …")`. */
  maxMinutes: z.number().positive(),
  maxUsd: z.number().positive(),
};

/** An owner ask: a root post in the owner↔leader DM (executor/asks.ts). It holds nothing and has
 * no deadline; its answer is read from its thread whenever it is observed. */
const ask = {
  runId: z.string().min(1),
  /** The contract's leader: the ask is its post, in its DM with the owner. */
  buddyId: z.string().min(1),
  /** The question post's body, exactly as posted (its key `xk:<runId>` replays only this body). */
  body: z.string().min(1),
  answer: z.enum(['text', 'confirm']),
};

export const RunRecord = z.discriminatedUnion('t', [
  v('running', { ...live, host: Host, process: Process }),
  /** Written BEFORE the request is posted: a crash before the post finishes it at the next
   * `status` or `start`, under the same key, so there is never a second request. */
  v('posting', call),
  v('posted', {
    ...call,
    postId: z.string().min(1),
    postedAt: z.string(),
    /** Every crate run seen under the post (the crate has no post → run lookup, CONNECT_PLAN
     * §0.7): a run once seen is read by id, whatever the Buddy's run list holds since. */
    crateRunIds: z.array(z.string().min(1)),
    stop: Stop,
  }),
  Settled,
  /** Written BEFORE the question is posted, so a crash between finishes the post under its key. */
  v('asking', ask),
  v('asked', {
    ...ask,
    channelId: z.string().min(1),
    postId: z.string().min(1),
    postedAt: z.string(),
  }),
  /** Tombstone: nothing runs under this id again. `last` is what it settled as, if it did. */
  v('closed', { runId: z.string().min(1), last: Last }),
]);
export type RunRecord = z.infer<typeof RunRecord>;
export type Running = Extract<RunRecord, { t: 'running' }>;
export type Posting = Extract<RunRecord, { t: 'posting' }>;
export type Posted = Extract<RunRecord, { t: 'posted' }>;
export type SettledRecord = Extract<RunRecord, { t: 'settled' }>;
export type Asking = Extract<RunRecord, { t: 'asking' }>;
export type Asked = Extract<RunRecord, { t: 'asked' }>;

export const readRecord = (file: string): Promise<Read<RunRecord>> => readJson(file, RunRecord);

/** Every record under a data root (`<root>/<expedition>/runs/*.json`): what a restarted host
 * observes of what the dead one left. One that does not read is skipped here; the run's own
 * operations read it again and fail loudly. */
export async function recordsUnder(root: string): Promise<RunRecord[]> {
  const out: RunRecord[] = [];
  for (const exp of await readdir(root).catch(() => [] as string[])) {
    const dir = path.join(root, exp, 'runs');
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!name.endsWith('.json')) continue;
      const found = await readRecord(path.join(dir, name)).catch(() => ({ t: 'missing' }) as const);
      if (found.t === 'found') out.push(found.value);
    }
  }
  return out;
}
export const writeRecord = (file: string, record: RunRecord): Promise<void> =>
  writeJsonAtomic(file, RunRecord.parse(record));
