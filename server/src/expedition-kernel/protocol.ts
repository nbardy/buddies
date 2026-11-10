import { z } from 'zod';
import { Base, Input, Judge, Key, Outcome, RefId, Who } from './types';

// The wire between the plan process and the host (IPC, one JSON message per send).
// The plan process holds no state that matters: the host may kill it and start a fresh one at any
// time, and every call it re-issues is answered from the log.
//
// A plan imports the authoring library by the bare specifier `expedition`. The runner and the
// typecheck gate both resolve that to server/src/expedition-kernel/authoring/index.ts.

const v = <T extends string, S extends z.ZodRawShape>(t: T, shape: S) =>
  z.object({ t: z.literal(t), ...shape }).strict();

/** A call as the plan authored it. The host canonicalises it into a `Call`: it renders the brief
 * (`briefs/<step>.md` with `item` slots, plus the contract's rules), adds the provider's pool, and
 * fills the launch base. */
export const Authored = z.discriminatedUnion('t', [
  v('agent', {
    key: Key,
    /** The cast-table name: the brief is `briefs/<step>.md`. */
    step: z.string().min(1),
    item: z.record(z.unknown()),
    by: Who,
    inputs: z.array(Input),
    output: z.unknown(),
    tree: z.enum(['none', 'checkout']),
    base: Base,
    grant: z.object({ reads: z.array(z.string()), web: z.boolean() }).strict(),
    context: z.discriminatedUnion('t', [v('cold', {}), v('continue', { of: RefId })]),
    /** Extra pools from `.needs(...)`. */
    needs: z.array(z.string()),
    max: z.object({ usd: z.number().positive(), minutes: z.number().positive() }).strict(),
    judge: Judge,
  }),
  v('command', {
    key: Key,
    step: z.string().min(1),
    /** With `{{slots}}` still in it; the host fills them from `item`. */
    command: z.string().min(1),
    item: z.record(z.unknown()),
    on: Base,
    output: z.unknown(),
    needs: z.array(z.string()),
    maxMinutes: z.number().positive(),
  }),
  v('ask', { key: Key, question: z.string().min(1), answer: z.enum(['text', 'confirm']) }),
]);
export type Authored = z.infer<typeof Authored>;

/** plan process → host */
export const FromPlan = z.discriminatedUnion('t', [
  v('call', { seq: z.number().int(), call: Authored }),
  v('phase', { name: z.string().min(1), edge: z.enum(['open', 'close']) }),
  v('review', { seq: z.number().int(), question: z.string() }),
  /** Nothing left to do but wait on these calls and reviews. */
  v('waiting', { on: z.array(z.number().int()) }),
  /** The plan returned its candidate. */
  v('candidate', { ref: RefId }),
  /** `need(...)` ended the plan: no result, and this is why. */
  v('gap', { why: z.string(), evidence: z.array(Input) }),
  v('threw', { message: z.string() }),
]);
export type FromPlan = z.infer<typeof FromPlan>;

/** host → plan process */
export const ToPlan = z.discriminatedUnion('t', [
  v('outcome', { seq: z.number().int(), outcome: Outcome }),
  /** The leader chose `continue`. (A rewrite or a stop ends this process instead.) */
  v('reviewed', { seq: z.number().int() }),
]);
export type ToPlan = z.infer<typeof ToPlan>;
