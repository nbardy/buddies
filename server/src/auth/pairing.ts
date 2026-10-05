import { randomBytes } from 'node:crypto';

/**
 * One-time pairing codes for the Connect-mobile QR. A code stands in for the
 * key in the URL the phone opens, so the key itself never lands in the phone's
 * history, a proxy log or a screenshot of the QR. Single use, five minutes,
 * in memory: a restart voids every outstanding code, which is the safe side.
 */

export const PAIRING_TTL_MS = 5 * 60_000;
/** Codes nobody scanned: keep the newest few, never an unbounded map. */
const MAX_OUTSTANDING = 8;

export interface PairingCode {
  readonly code: string;
  readonly expiresAt: number;
}

export class PairingCodes {
  private readonly outstanding = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(ttlMs = PAIRING_TTL_MS, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  issue(): PairingCode {
    const oldest = this.outstanding.keys().next();
    if (this.outstanding.size >= MAX_OUTSTANDING && !oldest.done) {
      this.outstanding.delete(oldest.value);
    }
    const code = randomBytes(16).toString('base64url');
    const expiresAt = this.now() + this.ttlMs;
    this.outstanding.set(code, expiresAt);
    return { code, expiresAt };
  }

  /** Consumes the code whether or not it is still live: a second scan never works. */
  redeem(code: string): boolean {
    const expiresAt = this.outstanding.get(code);
    this.outstanding.delete(code);
    return expiresAt !== undefined && expiresAt > this.now();
  }
}
