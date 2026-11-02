import type { BuddiesCore, Run } from '@unleashd/buddies-core';
import type { ConversationRecord } from '../conversations/config-records';
import type { IngestAccessor } from '../ingest/instance';
import type { AttemptCost } from './model';

// Measured attempt cost (R6): provider-counted totals of the sessions bound by the conversation of
// every run that executed the attempt's requests. Unpriced: a dollar figure would be an estimate.

export type BoundSessions = { t: 'record'; sessionIds: string[] } | { t: 'missing' };

/** κ over a conversation record: its earlier and current bound sessions. */
export function boundSessions(record: ConversationRecord | undefined): BoundSessions {
  if (!record) return { t: 'missing' };
  const bindings = [...record.sessionBindings, record.currentSession].flatMap((b) =>
    b ? [b] : []
  );
  return { t: 'record', sessionIds: bindings.map((b) => b.sessionId) };
}

export interface MeterPorts {
  sessionsOf(conversationId: string): Promise<BoundSessions>;
  ingest: IngestAccessor;
}

/** `settling`: try again on a later tick (a live run, an unindexed transcript, a starting store). */
export type Metering = { t: 'settling' } | { t: 'metered'; cost: AttemptCost };

/** Fix-guard: a run's last transcript lines are indexed a moment after it exits; reading earlier
 * would record an undercount. */
export const INDEX_GRACE_MS = 15_000;
export const RUN_SCAN_LIMIT = 2_000;
export const SETTLED: ReadonlySet<Run['status']> = new Set(['complete', 'failed', 'cancelled']);
/** Audit 2026-11-01: a never-settling run kept a finished expedition ticking forever; past this it
 * is recorded unmeasured. */
export const SETTLE_WINDOW_MS = 60 * 60_000;

const unmeasured = (reason: string): Metering => ({
  t: 'metered',
  cost: { t: 'unmeasured', reason },
});

/** An attempt's cost over every request it posted (its brief and a repair, R11). */
export async function meterRequest(
  core: BuddiesCore,
  ports: MeterPorts,
  crewBuddyId: string,
  requestIds: readonly string[],
  nowMs: number,
  endedAtMs: number
): Promise<Metering> {
  const metering = await measure(core, ports, crewBuddyId, new Set(requestIds), nowMs);
  return metering.t === 'settling' && nowMs - endedAtMs > SETTLE_WINDOW_MS
    ? unmeasured(`its runs did not settle within ${SETTLE_WINDOW_MS / 60_000} minutes`)
    : metering;
}

async function measure(
  core: BuddiesCore,
  ports: MeterPorts,
  crewBuddyId: string,
  requestIds: ReadonlySet<string>,
  nowMs: number
): Promise<Metering> {
  const runs = (await core.listRuns({ kind: 'buddy', buddyId: crewBuddyId }, RUN_SCAN_LIMIT))
    .filter((r) => r.input.kind === 'post' && requestIds.has(r.input.postId))
    // A run that never reached its spawn spent nothing and may never run.
    .filter((r) => r.executingAt !== undefined);
  if (runs.length === 0) return unmeasured('no Buddy run executed this request');
  for (const r of runs) {
    if (!SETTLED.has(r.status)) return { t: 'settling' };
    if (r.endedAt === undefined) return unmeasured(`run ${r.id} settled without an end time`);
    if (nowMs - Date.parse(r.endedAt) < INDEX_GRACE_MS) return { t: 'settling' };
  }
  const slot = ports.ingest();
  if (slot.t === 'starting') return { t: 'settling' };

  const sessionIds = new Set<string>();
  for (const r of runs) {
    if (r.conversationId === undefined)
      return unmeasured(`run ${r.id} executed in no conversation`);
    const bound = await ports.sessionsOf(r.conversationId);
    if (bound.t === 'missing') return unmeasured(`conversation ${r.conversationId} has no record`);
    for (const id of bound.sessionIds) sessionIds.add(id);
  }
  if (sessionIds.size === 0) return unmeasured('its runs bound no provider session');

  const cost = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  for (const id of sessionIds) {
    const row = await slot.ingest.session(id);
    if (!row) return unmeasured(`session ${id} is not in the transcript store`);
    // Claude, Codex and OpenCode transcripts record usage; other providers record none.
    if (!row.usage) return unmeasured(`${row.provider} records no token usage (session ${id})`);
    cost.inputTokens += row.usage.input;
    cost.outputTokens += row.usage.output;
    cost.cacheReadTokens += row.usage.cacheRead;
    cost.cacheWriteTokens += row.usage.cacheWrite;
  }
  return { t: 'metered', cost: { t: 'measured', ...cost } };
}
