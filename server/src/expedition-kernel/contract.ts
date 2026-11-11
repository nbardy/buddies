import { listHarnesses } from '@nbardy/agent-cli';
import { keyed } from '@unleashd/shared';
import { z } from 'zod';
import { whoOf } from './authoring/who';

// Pattern: one parse at the boundary (docs/patterns.md#sum-types)
export type ParsedContract =
  | { t: 'ok'; contract: keyed.Contract; defaults: keyed.PreviewDefaults }
  | { t: 'invalid'; issues: string[] };

// The cap of one leader wake or done review when the contract names none, ONE rule:
//   usd     = min(budget.usd, clamp(10% of budget.usd, $0.25, $1.00))
//   minutes = min(budget.hours * 60, clamp(10% of budget.hours * 60, 5, 20))
// The real run (2026-11-11) paid $0.039 and 12 s for a wake, so the $0.25 floor is ~6x a real wake
// and a cap that ends a turn is rare; the 10% share keeps a bigger budget's wakes proportionate
// (a $3 budget reserves $0.30 per wake, not the $2 that held most of it); the $1 ceiling stops a
// large budget reserving an agent-sized sum per wake. Never above what the budget itself allows.
const WAKE_USD = { share: 0.1, floor: 0.25, ceiling: 1 } as const;
const WAKE_MINUTES = { share: 0.1, floor: 5, ceiling: 20 } as const;
const clamp = (x: number, r: { floor: number; ceiling: number }) =>
  Math.min(r.ceiling, Math.max(r.floor, x));
const cents = (x: number) => Math.round(x * 100) / 100;
/** A cap as the `max` of the call it bounds. */
export const maxOfCap = (c: keyed.Cap): keyed.Max => ({ usd: c.usd, minutes: c.minutes });
export function defaultCap(budget: keyed.Budget): keyed.Cap {
  const budgetMinutes = budget.hours * 60;
  return {
    t: 'defaulted',
    usd: cents(Math.min(budget.usd, clamp(budget.usd * WAKE_USD.share, WAKE_USD))),
    minutes: Math.min(budgetMinutes, clamp(budgetMinutes * WAKE_MINUTES.share, WAKE_MINUTES)),
  };
}

// Reject lossy JSON before IPC: JSON.stringify alone silently drops functions, undefined and
// symbols, and invokes toJSON/getters. Guard: expedition-kernel-contract plain-data cases.
export function assertPlainJson(value: unknown, at = 'contract', seen = new Set<object>()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || value === null)
    throw new TypeError(`${at}: must be plain JSON data`);
  if (seen.has(value)) throw new TypeError(`${at}: circular data`);
  const proto: unknown = Object.getPrototypeOf(value);
  if (
    Array.isArray(value) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null
  )
    throw new TypeError(`${at}: must be a plain object`);
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    if (typeof key !== 'string') throw new TypeError(`${at}: symbol key`);
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !('value' in d) || !d.enumerable)
      throw new TypeError(`${at}.${key}: must be plain data`);
    assertPlainJson(d.value, `${at}.${key}`, seen);
  }
  if (Array.isArray(value) && Object.keys(value).length !== value.length)
    throw new TypeError(`${at}: sparse or extended array`);
  seen.delete(value);
}

const Done = z.union([
  z
    .object({ check: z.string() })
    .strict()
    .transform((c) => ({ t: 'check' as const, command: c.check })),
  z
    .object({ review: z.string(), by: z.string() })
    .strict()
    .transform((c) => {
      const by = whoOf(c.by, 'contract.done review');
      if (by.t !== 'seat')
        throw new TypeError('contract.done review: the kernel requires a seat reviewer.');
      return { t: 'review' as const, rubric: c.review, by };
    }),
  z
    .object({ owner: z.string() })
    .strict()
    .transform((c) => ({ t: 'owner' as const, question: c.owner })),
]);
const Literal = keyed.Contract.omit({ done: true, leaderWake: true, doneReview: true })
  .extend({
    done: z.array(Done),
    leader: z.string().min(1),
    pools: keyed.Contract.shape.pools.optional(),
    autoApply: keyed.Contract.shape.autoApply.optional(),
    call: keyed.Max.partial().optional(),
    leaderWake: keyed.Max.optional(),
    doneReview: keyed.Max.optional(),
  })
  .strict();
export type ContractInput = z.input<typeof Literal>;

/** The one-file literal -> canonical owner contract, including the two budget-derived caps. */
function parseLiteral(raw: unknown): ParsedContract {
  try {
    assertPlainJson(raw);
  } catch (e) {
    return { t: 'invalid', issues: [(e as Error).message] };
  }
  const literal = Literal.safeParse(raw);
  if (!literal.success)
    return {
      t: 'invalid',
      issues: literal.error.issues.map((i) => `${i.path.join('.') || 'contract'}: ${i.message}`),
    };
  const { leaderWake, doneReview, pools, autoApply, call, ...given } = literal.data;
  const leader = whoOf(given.leader, 'contract.leader');
  if (leader.t !== 'buddy')
    throw new TypeError('contract.leader: the kernel requires a Buddy leader.');
  const cap = (kind: 'leaderWake' | 'doneReview', c: keyed.Max | undefined): keyed.Cap =>
    c ? { t: 'given', ...c } : AUTHORING_DEFAULTS[kind](given.budget);
  const canonical = keyed.Contract.safeParse({
    ...given,
    leader: leader.id,
    call: {
      usd: call?.usd ?? AUTHORING_DEFAULTS.call.usd,
      minutes: call?.minutes ?? AUTHORING_DEFAULTS.call.minutes,
    },
    pools: pools ?? AUTHORING_DEFAULTS.pools,
    autoApply: autoApply ?? AUTHORING_DEFAULTS.autoApply,
    leaderWake: cap('leaderWake', leaderWake),
    doneReview: cap('doneReview', doneReview),
  });
  return canonical.success
    ? {
        t: 'ok',
        contract: canonical.data,
        defaults: {
          pools: { t: pools ? 'given' : 'defaulted', value: canonical.data.pools },
          autoApply: { t: autoApply ? 'given' : 'defaulted', value: canonical.data.autoApply },
          leaderWake: canonical.data.leaderWake,
          doneReview: canonical.data.doneReview,
          call: {
            usd: {
              t: call?.usd === undefined ? 'defaulted' : 'contract',
              value: call?.usd ?? AUTHORING_DEFAULTS.call.usd,
            },
            minutes: {
              t: call?.minutes === undefined ? 'defaulted' : 'contract',
              value: call?.minutes ?? AUTHORING_DEFAULTS.call.minutes,
            },
          },
          steps: [],
        },
      }
    : {
        t: 'invalid',
        issues: canonical.error.issues.map(
          (i) => `${i.path.join('.') || 'contract'}: ${i.message}`
        ),
      };
}

/** `~/x` becomes `<home>/x`. Kept out of parseContract so the parse stays pure. */
export function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  return path.startsWith('~/') ? `${home.replace(/\/+$/, '')}/${path.slice(2)}` : path;
}

/** Pattern: table-driven (docs/patterns.md#table-driven)
 * All authoring defaults live here. PreviewDefaults records every resolution, even unreached steps.
 * Pool defaults serialize each catalog harness independently; explicit pools replace the table.
 */
export const AUTHORING_DEFAULTS = {
  pools: Object.fromEntries(listHarnesses().map((harness) => [harness, 1])),
  autoApply: { usd: 0 },
  call: { usd: 1, minutes: 20 },
  leaderWake: defaultCap,
  doneReview: defaultCap,
} as const;
export function parseContract(raw: unknown): ParsedContract {
  try {
    return parseLiteral(raw);
  } catch (error) {
    return { t: 'invalid', issues: [(error as Error).message] };
  }
}
