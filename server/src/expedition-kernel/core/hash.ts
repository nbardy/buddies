import { createHash } from 'node:crypto';
import type { Call, Hash } from '../types';

// A call's identity (DESIGN §4: "Hash covers the whole call, brief text included"). Reconcile by
// key trusts it completely: two encodings of one call that hashed differently would start the
// same work twice (I1), so the encoding is canonical: object keys sorted, `undefined` members
// dropped (as JSON drops them), arrays kept in order (order is meaning there).

/** Sorted-key JSON. Throws on values JSON cannot carry, rather than hashing a lossy encoding. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map((item) => (item === undefined ? null : canonical(item)));
  if (typeof value === 'number' && !Number.isFinite(value))
    throw new TypeError(`cannot hash the non-finite number ${value}`);
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol')
    throw new TypeError(`cannot hash a ${typeof value}`);
  if (value === null || typeof value !== 'object') return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const member = (value as Record<string, unknown>)[key];
    if (member !== undefined) sorted[key] = canonical(member);
  }
  return sorted;
}

export function hashOf(call: Call): Hash {
  return createHash('sha256').update(canonicalJson(call)).digest('hex');
}
