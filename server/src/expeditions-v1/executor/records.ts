import { keyed } from '@unleashd/shared';
import { z } from 'zod';
import type { RawOutcome, RunSpec } from '../../expedition-kernel/ports';
import { type Read, readJson, writeJsonAtomic } from './durable';

// One durable record per run (CONNECT_PLAN §1 "Durable state"), at `<expDir>/runs/<name>.json`.
// It is what makes `start` idempotent and what `status` answers from, across restarts:
//   (none) → running → settled → closed
// and (none) → closed for an id closed before it ever started (a late start is then a no-op).
// Agent-backed kinds add `posting` / `posted` in a later step.

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

const RunKind = z.enum(['agent', 'command', 'ask', 'check', 'review']);
const _sameKind: z.ZodType<RunSpec['t']> = RunKind;
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
const Tree = z.discriminatedUnion('t', [v('none', {}), v('detached', { path: z.string() })]);

const live = {
  runId: z.string().min(1),
  kind: RunKind,
  /** Past this the run is killed; a restart does not extend it. */
  deadlineAt: z.string(),
  tree: Tree,
};
const Settled = v('settled', { ...live, raw: RawOutcomeSchema, spent: keyed.Usage });
export const RunRecord = z.discriminatedUnion('t', [
  v('running', { ...live, host: Host, process: Process }),
  Settled,
  /** Tombstone: nothing runs under this id again. `last` is what it settled as, if it did. */
  v('closed', {
    runId: z.string().min(1),
    last: z.discriminatedUnion('t', [
      v('settled', { raw: RawOutcomeSchema, spent: keyed.Usage }),
      v('never-settled', {}),
    ]),
  }),
]);
export type RunRecord = z.infer<typeof RunRecord>;
export type Running = Extract<RunRecord, { t: 'running' }>;

export const readRecord = (file: string): Promise<Read<RunRecord>> => readJson(file, RunRecord);
export const writeRecord = (file: string, record: RunRecord): Promise<void> =>
  writeJsonAtomic(file, RunRecord.parse(record));
