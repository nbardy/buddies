import { keyed } from '@unleashd/shared';
import { z } from 'zod';

// The wire between the plan process and the host (IPC, one JSON message per send).
// The plan process holds no state that matters: the host may kill it and start a fresh one at any
// time, and every call it re-issues is answered from the log.
//
// A plan imports the authoring library by the bare specifier `expedition`. The runner and the
// typecheck gate both resolve that to server/src/expedition-kernel/authoring/index.ts.

const v = <T extends string, S extends z.ZodRawShape>(t: T, shape: S) =>
  z.object({ t: z.literal(t), ...shape }).strict();

/** A call as the plan authored it. The host canonicalises it into a `Call`: it appends the
 * contract's rules to the rendered text, adds the provider's pool, and
 * fills the launch base. */
export const Authored = z.discriminatedUnion('t', [
  v('agent', {
    key: keyed.Key,
    /** The cast-table name. */
    step: z.string().min(1),
    brief: z.string().min(1),
    by: keyed.Who,
    inputs: z.array(keyed.Input),
    output: z.unknown(),
    tree: z.enum(['none', 'checkout']),
    base: keyed.Base,
    grant: z.object({ reads: z.array(z.string()), web: z.boolean() }).strict(),
    context: z.discriminatedUnion('t', [v('cold', {}), v('continue', { of: keyed.RefId })]),
    /** Extra pools from `.needs(...)`. */
    needs: z.array(z.string()),
    max: z.object({ usd: z.number().positive(), minutes: z.number().positive() }).strict(),
    judge: keyed.Judge,
  }),
  v('command', {
    key: keyed.Key,
    step: z.string().min(1),
    /** Rendered by the authoring library. */
    command: z.string().min(1),
    on: keyed.Base,
    output: z.unknown(),
    needs: z.array(z.string()),
    maxMinutes: z.number().positive(),
  }),
  v('ask', { key: keyed.Key, question: z.string().min(1), answer: z.enum(['text', 'confirm']) }),
]);
export type Authored = z.infer<typeof Authored>;

/** One row of the plan's cast table (`steps({...})`): what every call of that step will be, known
 * before any call is made. The preview reports each agent row's limits, so a step the dry run
 * never reaches is still previewed (CONNECT_PLAN §10: the second run's checkout calls were not). */
export const CastRow = z.discriminatedUnion('t', [
  v('agent', {
    step: z.string().min(1),
    by: keyed.Who,
    tree: z.enum(['none', 'checkout']),
    grant: z.object({ reads: z.array(z.string()), web: z.boolean() }).strict(),
    judge: keyed.Judge,
    hasBrief: z.boolean(),
    needs: z.array(z.string()),
  }),
  /** A host command: no agent turn, so no limits to report. */
  v('command', { step: z.string().min(1) }),
]);
export type CastRow = z.infer<typeof CastRow>;

/** plan process → host */
export const FromPlan = z.discriminatedUnion('t', [
  /** The owner literal, always first. */
  v('contract', { value: z.unknown() }),
  /** The cast table, before any of its calls. */
  v('cast', { rows: z.array(CastRow) }),
  v('call', { seq: z.number().int(), call: Authored }),
  v('phase', { name: z.string().min(1), edge: z.enum(['open', 'close']) }),
  v('review', { seq: z.number().int(), question: z.string() }),
  /** Nothing left to do but wait on these calls and reviews. */
  v('waiting', { on: z.array(z.number().int()) }),
  /** The plan returned its candidate. */
  v('candidate', { ref: keyed.RefId }),
  /** `need(...)` ended the plan: no result, and this is why. */
  v('gap', { why: z.string(), evidence: z.array(keyed.Input) }),
  v('threw', { message: z.string() }),
]);
export type FromPlan = z.infer<typeof FromPlan>;

/** host → plan process */
export const ToPlan = z.discriminatedUnion('t', [
  v('outcome', { seq: z.number().int(), outcome: keyed.Outcome }),
  /** The leader chose `continue`. (A rewrite or a stop ends this process instead.) */
  v('reviewed', { seq: z.number().int() }),
]);
export type ToPlan = z.infer<typeof ToPlan>;
