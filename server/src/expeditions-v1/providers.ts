import type { Buddy } from '@unleashd/buddies-core';
import type { InstalledAgent, keyed } from '@unleashd/shared';
import { profileExecution } from '../buddies/briefing';
import type { BuddiesCore } from '../buddies/core';
import type { ProviderOf } from '../expedition-kernel/canonical';

// `providerOf` for named Buddies (CONNECT_PLAN §0.10): which harness a `by: buddy` call runs on,
// so the kernel can reserve its pool. The kernel asks synchronously while canonicalising a plan,
// and Buddy profiles are in the crate (async), so the answer is read from a snapshot the host
// refreshes before it launches or opens an expedition. The rule is the one turn creation uses
// (briefing.ts `profileExecution`): an explicit provider, else the model's one harness, else the
// install's agent. A Buddy the snapshot does not hold is `unknown`, never a guess.

export type BuddyProviders = {
  /** Re-read every workspace's Buddies. */
  refresh(): Promise<void>;
  readonly providerOf: ProviderOf;
};

export function buddyProviders(core: BuddiesCore, installed: () => InstalledAgent): BuddyProviders {
  let known = new Map<string, Buddy>();
  const WHO: {
    readonly [K in keyed.Who['t']]: (w: Extract<keyed.Who, { t: K }>) => ReturnType<ProviderOf>;
  } = {
    seat: (w) => ({ t: 'known', provider: w.provider }),
    buddy: (w) => {
      const buddy = known.get(w.id);
      if (!buddy) return { t: 'unknown', why: `no Buddy ${w.id} (as of the last refresh)` };
      if (buddy.status !== 'active')
        return { t: 'unknown', why: `Buddy ${w.id} is ${buddy.status}` };
      const execution = profileExecution(buddy, installed());
      return execution.kind === 'run'
        ? { t: 'known', provider: execution.provider }
        : { t: 'unknown', why: `Buddy ${w.id} has no agent to run on` };
    },
  };
  return {
    async refresh() {
      const next = new Map<string, Buddy>();
      for (const ws of await core.listWorkspaces())
        for (const buddy of await core.listBuddies(ws.id)) next.set(buddy.id, buddy);
      known = next;
    },
    providerOf: (who) => WHO[who.t](who as never),
  };
}
