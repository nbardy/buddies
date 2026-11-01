import type { BuddiesCore, Run } from '@unleashd/buddies-core';
import type { ConversationRecord } from '../conversations/config-records';
import type { IngestAccessor } from '../ingest/instance';
import type { AttemptCost } from './model';

// Measured attempt cost (design.md R6): the I/O half. An attempt is one Buddy request; the runs
// that executed it (a retry continues in the same conversation, runner.ts `requestJob`) each ran in
// a conversation of their own (`buddy-run-<runId>`), so the provider-counted totals of the sessions
// those conversations bound are exactly what the attempt spent. Nothing is priced: the crate keeps
// token counts, and a dollar figure would be an estimate (usage-routes.ts RATES).

/** The provider sessions a conversation bound (history and current), or no such record. */
export type BoundSessions = { t: 'record'; sessionIds: string[] } | { t: 'missing' };

/** κ over a conversation record read: its bound sessions, earlier ones and the current one. */
export function boundSessions(record: ConversationRecord | undefined): BoundSessions {
  if (!record) return { t: 'missing' };
  const bindings = [
    ...record.sessionBindings,
    ...(record.currentSession ? [record.currentSession] : []),
  ];
  return { t: 'record', sessionIds: bindings.map((b) => b.sessionId) };
}

export interface MeterPorts {
  sessionsOf(conversationId: string): Promise<BoundSessions>;
  ingest: IngestAccessor;
}

/** `settling`: a run is still live, its transcript may not be indexed yet, or the store is
 * starting; the host writes nothing and meters again on a later tick. */
export type Metering = { t: 'settling' } | { t: 'metered'; cost: AttemptCost };

/**
 * A settled run's last transcript lines reach the ingest store through its file watcher a moment
 * after the provider process exits; reading before then would undercount (record a measurement
 * that is wrong, not missing). Fix-guard: metering waits this long after the run ended.
 */
export const INDEX_GRACE_MS = 15_000;
/** A crew Buddy's runs: its attempts plus chat deliveries; far below this for one expedition. */
export const RUN_SCAN_LIMIT = 2_000;
export const SETTLED: ReadonlySet<Run['status']> = new Set(['complete', 'failed', 'cancelled']);

const unmeasured = (reason: string): Metering => ({
  t: 'metered',
  cost: { t: 'unmeasured', reason },
});

/**
 * Metering is display only, so it never holds an expedition open for long: past this window after
 * the attempt ended, a run still settling is recorded "not measured" with the reason. Audit
 * 2026-11-01: a run that never settled kept a finished expedition active (ticked every minute)
 * forever, its only pending effect a read.
 */
export const SETTLE_WINDOW_MS = 60 * 60_000;

/** An attempt's cost over every request it posted (its brief and a repair, design.md R11). */
export async function meterRequest(
  core: BuddiesCore,
  ports: MeterPorts,
  crewBuddyId: string,
  requestIds: readonly string[],
  nowMs: number,
  endedAtMs: number
): Promise<Metering> {
  const metering = await measure(core, ports, crewBuddyId, new Set(requestIds), nowMs);
  switch (metering.t) {
    case 'metered':
      return metering;
    case 'settling':
      return nowMs - endedAtMs > SETTLE_WINDOW_MS
        ? unmeasured(`its runs did not settle within ${SETTLE_WINDOW_MS / 60_000} minutes`)
        : metering;
  }
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
    // A run that never reached its spawn (still queued, or the request was answered first) spent
    // nothing and may never run.
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
