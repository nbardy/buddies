import { randomBytes } from 'node:crypto';
import type { keyed } from '@unleashd/shared';
import type { OwnerThread, Thread } from '../../buddies/owner-thread';
import type { Owner, RewriteForOwner } from '../../expedition-kernel/ports';

// The real Owner port (CONNECT_PLAN §2): a rewrite the rules gate sent to the owner is posted in
// the expedition's thread with its diff, the leader's reason and why it needs approval, and waits
// for a bare `approve` or `decline` reply (owner/inbox.ts) or the route (`decide`). It lives in
// memory only: after a restart the waiting rewrite is abandoned (its post stays, and an `approve`
// then answers "nothing is waiting"), and the replayed plan wakes the leader again (kernel.ts).

export type ApprovalDeps = {
  readonly thread: OwnerThread;
  /** The expedition's thread (the host knows its leader and goal). */
  readonly threadOf: (expedition: string) => Promise<Thread>;
};

type Pending = {
  readonly rewrite: RewriteForOwner;
  readonly key: string;
  readonly resolve: (approved: boolean) => void;
};
export type Decided = { readonly t: 'decided' } | { readonly t: 'nothing-pending' };

const LISTED = 20;
const keys = (label: string, ks: readonly string[]) =>
  `${label} ${ks.length}${ks.length > 0 ? `: ${ks.slice(0, LISTED).join(', ')}${ks.length > LISTED ? ', …' : ''}` : ''}`;

/** The approval request: the diff, the leader's reason and why the owner is asked. */
export function approvalBody(r: RewriteForOwner): string {
  return [
    `The leader wants to rewrite the plan, and it needs your approval: ${r.reasons.join('; ')}.`,
    `Why: ${r.why}`,
    keys('Reused', r.diff.reused),
    keys('Attached', r.diff.attached),
    keys('Dropped', r.diff.dropped),
    keys('Started', r.diff.started),
    `New cost: $${r.diff.newCostUsd.toFixed(2)}`,
    'Reply approve or decline.',
  ].join('\n');
}

const DECIDED_LINE = {
  true: 'Approved · the rewrite is applied if it still passes the rules.',
  false: 'Declined · the plan stays as it is; the leader hears why at its next wake.',
} as const;

export class Approvals implements Owner {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly d: ApprovalDeps) {}

  /** One at a time per expedition: the kernel's wakes, and so its rewrites, run one at a time. */
  async approve(rewrite: RewriteForOwner): Promise<boolean> {
    if (this.pending.has(rewrite.expedition))
      throw new Error(`${rewrite.expedition} already has a rewrite waiting for the owner`);
    // A fresh key per request: the same rewrite submitted again must post again (the owner may
    // have declined the first), and nothing replays a request (it lives in this process only).
    const key = `xk:${rewrite.expedition}:approval:${randomBytes(8).toString('hex')}`;
    const answered = new Promise<boolean>((resolve) =>
      this.pending.set(rewrite.expedition, { rewrite, key, resolve })
    );
    try {
      const thread = await this.d.threadOf(rewrite.expedition);
      await this.d.thread.postStatus(thread, key, approvalBody(rewrite));
    } catch (e) {
      this.pending.delete(rewrite.expedition);
      throw e;
    }
    return answered;
  }

  /** The wire's view of it (projection.ts `keyedViewOf`). */
  pendingOf(expedition: string): keyed.PendingApproval {
    const p = this.pending.get(expedition);
    return p
      ? { t: 'pending', diff: p.rewrite.diff, why: p.rewrite.why, reasons: [...p.rewrite.reasons] }
      : { t: 'none' };
  }

  /** The owner's answer, from the thread or the route; acknowledged once in the thread. */
  async decide(expedition: string, approved: boolean): Promise<Decided> {
    const p = this.pending.get(expedition);
    if (!p) return { t: 'nothing-pending' };
    this.pending.delete(expedition);
    p.resolve(approved);
    const thread = await this.d.threadOf(expedition);
    await this.d.thread.postStatus(thread, `${p.key}:decided`, DECIDED_LINE[`${approved}`]);
    return { t: 'decided' };
  }
}
