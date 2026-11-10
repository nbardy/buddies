import type { BuddiesCore } from '../../buddies/core';
import { OWNER } from '../../buddies/core';

// The seat Buddy (D1): one per workspace, the identity every anonymous seat call (`by: seat`) runs
// as, on the call's own config. Its soul and memory stay empty (nothing writes them, and a call
// turn has no memory review, D4), so a call's briefing carries no one's memory, and the leader's
// and other Buddies' run slots are not taken by expedition work.
//
// Run slots: a seat call waits `pool_full` while the seat holds `maxActiveRuns` runs (crate default
// 5, CONNECT_PLAN §0.9). The contract's pools already cap how many calls an expedition runs at once,
// so the seat needs at least Σ pools for one expedition. The cap only GROWS: it is raised to
// max(SEAT_MIN_RUNS, Σ pools of the asking expedition) the first time a larger one asks, never
// lowered (another expedition in the workspace may be using the slots). Two large expeditions at
// once can still queue on each other; that wait is visible as `pool_full`, never a lost call.

export const SEAT_MIN_RUNS = 12;
const SLUG = 'expedition-seat';

/** Created idempotently by its key; resolved once per workspace per process. */
export class Seats {
  private readonly known = new Map<string, Promise<{ id: string; runs: number }>>();

  constructor(private readonly core: BuddiesCore) {}

  /** The workspace's seat Buddy, with at least `slots` run slots. Raises chain on the last known
   * state of the workspace's seat, so two first uses at once cannot race a smaller cap over a
   * larger one (2026-11-11: two calls launched together left the seat at 12, not 20). */
  async seatFor(workspaceId: string, slots: number): Promise<string> {
    const want = Math.max(SEAT_MIN_RUNS, slots);
    const before = this.known.get(workspaceId) ?? this.create(workspaceId);
    const next = before.then((seat) =>
      seat.runs >= want ? seat : this.raise(workspaceId, seat.id, want)
    );
    this.known.set(workspaceId, next);
    // A failed read or write is not remembered: the next call starts over from the crate.
    next.catch(() => {
      if (this.known.get(workspaceId) === next) this.known.delete(workspaceId);
    });
    return (await next).id;
  }

  private async create(workspaceId: string): Promise<{ id: string; runs: number }> {
    const buddy = await this.core.createBuddy(OWNER, {
      workspaceId,
      slug: SLUG,
      name: 'Expedition seat',
      role: 'Runs expedition calls: each turn is one call, briefed by its expedition, answering in the format it names.',
      manager: { kind: 'nobody' },
      key: `xk:seat:${workspaceId}`,
    });
    if (buddy.status !== 'active')
      throw new Error(`the expedition seat Buddy ${buddy.id} is ${buddy.status}`);
    return { id: buddy.id, runs: buddy.maxActiveRuns };
  }

  private async raise(
    workspaceId: string,
    buddyId: string,
    runs: number
  ): Promise<{ id: string; runs: number }> {
    const buddy = await this.core.updateBuddy(OWNER, {
      buddyId,
      changes: { maxActiveRuns: runs },
      key: `xk:seat:${workspaceId}:runs:${runs}`,
    });
    return { id: buddy.id, runs: buddy.maxActiveRuns };
  }
}
