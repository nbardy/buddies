import type { keyed } from '@unleashd/shared';
import { ProviderSchema } from '@unleashd/shared';
import type { ConversationRecordStore } from '../../conversations/config-records';
import type { IngestAccessor } from '../../ingest/instance';
import { priceUsd } from '../../providers/pricing';

// What a call's turns cost (CONNECT_PLAN §1 "Usage", §0.4). The only dollar source is the ingest
// store's per-request rows: conversation `buddy-run-<crate run>` → its current provider session
// (conversation records) → ingest usage grouped by session, since the call was posted → priced per
// model (providers/pricing.ts). Ingest lags the transcript, so a read can be `pending`; the caller
// waits a bounded time and then reports `unreported` (the kernel charges the whole reservation).
// Known limit: a read taken after ingest saw some but not all of a turn's requests under-counts;
// nothing marks a session's ingest as complete.

/** A conversation's current provider session, or none yet (it never spawned). */
export type SessionOf = (
  conversationId: string
) => Promise<{ readonly t: 'session'; readonly sessionId: string } | { readonly t: 'none' }>;

export type Metered =
  | { readonly t: 'priced'; readonly usd: number }
  /** Not knowable yet: no session, or ingest has not seen it. */
  | { readonly t: 'pending'; readonly why: string }
  /** Never knowable: the provider records no usage, or the model has no list price. */
  | { readonly t: 'unpriced'; readonly why: string };

export interface UsageMeter {
  /** What these conversations' turns cost since `since` (epoch ms). */
  spent(conversationIds: readonly string[], since: number): Promise<Metered>;
}

/** The meter over the server's ingest store and conversation records. */
export function ingestMeter(deps: { sessionOf: SessionOf; ingest: IngestAccessor }): UsageMeter {
  return {
    async spent(conversationIds, since) {
      const slot = deps.ingest();
      if (slot.t === 'starting') return { t: 'pending', why: 'the transcript store is starting' };
      const sessions = await Promise.all(conversationIds.map(deps.sessionOf));
      const ids = new Set<string>();
      for (const s of sessions) {
        if (s.t === 'none') return { t: 'pending', why: 'a run has no provider session yet' };
        ids.add(s.sessionId);
      }
      const report = await slot.ingest.usage({ since, groupBy: 'session' });
      const groups = report.groups.flatMap((g) =>
        g.key.t === 'session' ? [{ g, key: g.key }] : []
      );
      // A call's sessions and every sub-agent session below them: a Codex sub-agent (which no
      // flag blocks) writes its own rollout, whose group names its parent. Until 2026-11-11 its
      // tokens were never charged (CONNECT_PLAN §10). Ingest may see a child after its call
      // settled; that spend is then missed (the same lag as the known limit above).
      const counted = new Set(ids);
      for (let grew = true; grew; ) {
        grew = false;
        for (const { key } of groups)
          if (
            key.parentSessionId &&
            counted.has(key.parentSessionId) &&
            !counted.has(key.sessionId)
          ) {
            counted.add(key.sessionId);
            grew = true;
          }
      }
      let usd = 0;
      const seen = new Set<string>();
      for (const { g, key } of groups) {
        if (!counted.has(key.sessionId)) continue;
        seen.add(key.sessionId);
        const price = priceUsd(ProviderSchema.parse(key.provider), key.model, g);
        if (price.t === 'unpriced') return price;
        usd += price.usd;
      }
      if ([...ids].some((id) => !seen.has(id)))
        return { t: 'pending', why: 'ingest has not seen every session' };
      return { t: 'priced', usd };
    },
  };
}

/** `SessionOf` over the conversation records (conversations/config-records.ts). */
export const recordsSessionOf =
  (records: Pick<ConversationRecordStore, 'getByConversationId'>): SessionOf =>
  async (conversationId) => {
    const session = (await records.getByConversationId(conversationId))?.currentSession;
    return session ? { t: 'session', sessionId: session.sessionId } : { t: 'none' };
  };

/** What a run that never reached a provider spent. */
export const NOTHING: keyed.Usage = { t: 'reported', usd: 0 };
