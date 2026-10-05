/**
 * The conversation list and its message history as read models of the ingest store (T13b): each
 * active record joined with its bound sessions' rows, and bodies = merge(each session's SETTLED
 * prefix, the runtime's live-turn overlay). Changes queue while a turn runs and settle at idle, so
 * overlay and native rows never both show (docs/architecture.md, "List"). Row count = settled
 * count + overlay grown since. Guards: ingest-list.test.ts, ingest-history.test.ts.
 */
// Pattern: one-write-path (docs/patterns.md#one-write-path)

import type { ChangeEvent, Ingest, RecordSummary, SessionRow } from '@unleashd/ingest';
import {
  type ConversationRow,
  type Message,
  type MessagePage,
  type RowPatch,
  type ConversationKind as SharedKind,
  encodeRows,
  rowKind,
} from '@unleashd/shared';
import type { CompletionSuppression, ExternalActivity } from '../application/context';
import type { ConversationRecord } from '../conversations/config-records';
import {
  type ConversationBroadcast,
  type HistoryRowFields,
  type HistorySubject,
  conversationLabel,
  overlayHistoryFields,
} from '../conversations/runtime';
import { mergeSessionMessages } from '../lifecycle/session-history';
import { extendsHistory, sessionMessages } from './history';

type Records = {
  listSummaries(): Promise<RecordSummary[]>;
  findBySession(
    provider: RecordSummary['provider'],
    sessionId: string
  ): Promise<ConversationRecord | undefined>;
};

/**
 * What the list reads from a runtime the server holds (created or opened this run): a title the
 * provider streamed this run, and the live-turn overlay (never disk history).
 */
export type ListedRuntime = Omit<HistorySubject, 'createdAt'>;

/**
 * A listed row without its run state. `run` is never cached: it is read from external activity
 * whenever a row is served (`servedRow`). Incident 2026-10-01
 * (agent_notes/2026-10-01_product_lead_dispatch_fanout_handoff.md): an open tab showed two Codex
 * native children "running" an hour after their parents finished. The cache kept the `run` of
 * each row's last publish, which is always `running` (relist marks the session active before the
 * settle publishes), and the quiet backstop (`expireExternal`) only broadcast `idle`. Every hello
 * after that (a reconnect) re-served the frozen `running`, the activity had already expired so
 * no patch ever followed, and the client kept it. A fresh hello said idle only because a detail
 * GET (the worker badge loads one for each row it sees running) had materialized the child into
 * a runtime, whose own row is idle; that sends no patch either. Omitting the
 * field makes that stale copy unrepresentable. Guard: ingest-list.test.ts "a hello after the
 * quiet backstop agrees with the patched tab; a child outliving its parent stays running".
 */
export type ListedRow = Omit<ConversationRow, 'run'>;

/** What one record contributes to the list. A sum, so the join never guesses a row. */
type Listing =
  | { t: 'listed'; row: ListedRow }
  /** No bound transcript in the store: only a runtime (app-created, not yet run) shows it. */
  | { t: 'no_transcript' }
  /** No cwd in record or transcripts (Muse approval-review children); never guessed, counted. */
  | { t: 'no_cwd' };

/** A settle: the sessions' counts the served history is cut at, and that history's length. */
interface Settled {
  counts: ReadonlyMap<string, number>;
  count: number;
  /** Overlay length the merge saw; overlay beyond it is appended after `count`. */
  overlayAt: number;
  /** MessagePage.epoch: moves when history was replaced rather than appended. */
  epoch: number;
}

const EMPTY: readonly Message[] = [];
const SETTLE_CONCURRENCY = 8;
/** Merged histories kept for paging (a client reads one in 500-message pages). */
const SERVED_CACHE = 8;

function cwdOf(record: RecordSummary, sessions: readonly SessionRow[]): string | null {
  if (record.workingDirectory) return record.workingDirectory;
  for (const session of sessions) {
    if (session.cwd.t !== 'unknown') return session.cwd.path;
  }
  return null;
}

/**
 * The one label rule, whichever path serves the row: the transcript's provider title, else a
 * title streamed this run, else the store's first-prompt label, else the overlay's first prompt
 * under the same rule (`conversationLabel` folds onto one line at 60 units, like the crate).
 */
function labelOf(
  record: RecordSummary,
  sessions: readonly SessionRow[],
  runtime: ListedRuntime | undefined
): string {
  const current = currentSession(record, sessions);
  return (
    current?.title?.trim() ||
    runtime?.title?.trim() ||
    sessions.find((session) => session.label)?.label ||
    conversationLabel(undefined, runtime?.messages ?? EMPTY)
  );
}

function currentSession(record: RecordSummary, sessions: readonly SessionRow[]) {
  return (
    sessions.find((session) => session.sessionId === record.currentSession?.sessionId) ??
    sessions[sessions.length - 1]
  );
}

function createdAtOf(record: RecordSummary, sessions: readonly SessionRow[]): number {
  const recordCreated = Date.parse(record.createdAt);
  // Discovered records were stamped at import time; the transcript's own birth is the truth.
  return record.provenance === 'external_discovered'
    ? Math.min(recordCreated, ...sessions.map((session) => session.createdAt))
    : recordCreated;
}

function overlayCount(settled: Settled, overlay: readonly Message[]): number {
  return settled.count + Math.max(0, overlay.length - settled.overlayAt);
}

function historyFields(
  record: RecordSummary,
  sessions: readonly SessionRow[],
  settled: Settled,
  runtime: ListedRuntime | undefined
): HistoryRowFields {
  const createdAt = createdAtOf(record, sessions);
  const overlay = runtime?.messages ?? EMPTY;
  const last = overlay.at(-1);
  return {
    label: labelOf(record, sessions, runtime),
    createdAt,
    activityAt: Math.max(
      createdAt,
      ...sessions.map((session) => session.activityAt),
      last ? new Date(last.timestamp).getTime() : createdAt
    ),
    messageCount: overlayCount(settled, overlay),
  };
}

/** Pure join of one record with its sessions (oldest first) and its settle. */
export function listingFor(
  record: RecordSummary,
  sessions: readonly SessionRow[],
  settled: Settled,
  conversationOfSession: (sessionId: string) => string | undefined
): Listing {
  if (sessions.length === 0) return { t: 'no_transcript' };
  const cwd = cwdOf(record, sessions);
  if (cwd === null) return { t: 'no_cwd' };
  const parentSession = sessions.find((session) => session.parentSessionId)?.parentSessionId;
  return {
    t: 'listed',
    row: {
      id: record.conversationId,
      kind: rowKind(record.kind as SharedKind),
      parent: parentSession ? (conversationOfSession(parentSession) ?? parentSession) : null,
      resumedFrom:
        sessions.find((s) => s.resumedFromConversationId)?.resumedFromConversationId ?? null,
      provider: record.provider,
      cwd,
      ...historyFields(record, sessions, settled, undefined),
      done: record.done,
    },
  };
}

/** The list's view of a record read after boot (`findBySession`, discovery). */
export function summaryOf(record: ConversationRecord): RecordSummary {
  const keys = [
    ...record.sessionBindings,
    ...(record.currentSession ? [record.currentSession] : []),
  ].map((binding) => ({ provider: binding.provider, sessionId: binding.sessionId }));
  return {
    conversationId: record.conversationId,
    status: record.status,
    done: record.done,
    kind: record.kind as RecordSummary['kind'],
    provenance: record.provenance,
    workingDirectory: record.workingDirectory,
    provider: record.config.provider,
    currentSession: record.currentSession
      ? { provider: record.currentSession.provider, sessionId: record.currentSession.sessionId }
      : undefined,
    sessions: [...new Map(keys.map((key) => [`${key.provider}:${key.sessionId}`, key])).values()],
    configRevision: record.configRevision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** What a runtime needs from the list when it is built (materialized) for a listed record. */
export interface JoinedConversation {
  record: RecordSummary;
  /** Bound sessions in the store, oldest first. */
  sessions: SessionRow[];
  /** Present when the record is listed (has a transcript and a working directory). */
  row: ListedRow | null;
}

export interface ConversationList {
  /** Rows for every listed conversation the server does NOT hold as a runtime. */
  rows(): ConversationRow[];
  ids(): string[];
  /** The record and sessions of a conversation the list knows, for building its runtime. */
  joined(conversationId: string): JoinedConversation | undefined;
  /** The listed conversation a session belongs to (search hits name sessions). */
  locate(sessionId: string): { conversationId: string; workingDirectory: string } | undefined;
  /** The history-owned row fields of a runtime (same rule as a listed row). */
  historyFields(runtime: HistorySubject): HistoryRowFields;
  /** One page of the conversation's history; null = the list knows no such conversation. */
  page(
    conversationId: string,
    page: { afterSeq: number; limit: number }
  ): Promise<MessagePage | null>;
  /** A runtime went idle: apply the transcript changes queued while its turn ran. */
  idle(conversationId: string): void;
  /** The conversation was deleted: stop listing it. */
  forget(conversationId: string): void;
  /** `Ingest.start`'s onChange: re-list the changed sessions and send field patches. */
  onChange(event: ChangeEvent): void;
  /** The external-activity backstop timer (armed only while a transcript is written elsewhere). */
  stop(): void;
}

export interface ConversationListDependencies {
  ingest: Pick<Ingest, 'listSessions' | 'messages'>;
  records: Records;
  /** The runtime the server holds for this id (it owns run state, config and the overlay). */
  runtime(conversationId: string): ListedRuntime | undefined;
  /**
   * A session with no record appeared (a CLI run outside the app). Returns its new record, or null
   * when it is not to be listed (deleted, ignored directory, tombstoned).
   */
  discover(session: SessionRow): Promise<ConversationRecord | null>;
  externalActivity: Pick<ExternalActivity, 'has' | 'set' | 'delete' | 'entries'>;
  completionSuppression: Pick<CompletionSuppression, 'isSuppressed'>;
  /** A transcript quiet this long is no longer "running elsewhere". */
  externalGraceMs: number;
  broadcast(data: ConversationBroadcast): void;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export async function forEachConcurrently<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await run(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Build the list once (boot), then keep it current from `onChange`. */
export async function createConversationList(
  dependencies: ConversationListDependencies
): Promise<ConversationList> {
  const logger = dependencies.logger ?? console;
  const sessions = new Map<string, SessionRow>();
  const recordOf = new Map<string, RecordSummary>();
  const conversationBySession = new Map<string, string>();
  const settledOf = new Map<string, Settled>();
  const rows = new Map<string, ListedRow>();
  /** Conversations whose transcript changed while their turn ran. */
  const queued = new Map<string, { rewritten: boolean }>();
  const served = new Map<string, { key: string; messages: Message[] }>();
  const settling = new Map<string, Promise<void>>();
  let rev = 0;
  let backstop: NodeJS.Timeout | null = null;

  const boundSessions = (record: RecordSummary): SessionRow[] =>
    record.sessions
      .map((key) => sessions.get(key.sessionId))
      .filter((row): row is SessionRow => row !== undefined)
      .sort((a, b) => a.createdAt - b.createdAt);

  const runOf = (record: RecordSummary): ConversationRow['run'] =>
    record.sessions.some((key) => dependencies.externalActivity.has(key.sessionId))
      ? 'running'
      : 'idle';

  /** A row as sent to clients: run state read now, never cached (see ListedRow). */
  const servedRow = (record: RecordSummary, row: ListedRow): ConversationRow => ({
    ...row,
    run: runOf(record),
  });

  function listing(record: RecordSummary): Listing {
    const settled = settledOf.get(record.conversationId) ?? unsettled(record);
    return listingFor(record, boundSessions(record), settled, (id) =>
      conversationBySession.get(id)
    );
  }

  /** Before the first settle of a record: nothing served yet. */
  function unsettled(record: RecordSummary): Settled {
    const bound = boundSessions(record);
    return {
      counts: new Map(bound.map((session) => [session.sessionId, session.messageCount])),
      count: bound.reduce((sum, session) => sum + session.messageCount, 0),
      overlayAt: 0,
      epoch: 0,
    };
  }

  function index(record: RecordSummary): void {
    recordOf.set(record.conversationId, record);
    for (const key of record.sessions)
      conversationBySession.set(key.sessionId, record.conversationId);
  }

  async function natives(record: RecordSummary, counts: ReadonlyMap<string, number>) {
    return Promise.all(
      boundSessions(record).map((session) =>
        sessionMessages(dependencies.ingest, session, counts.get(session.sessionId) ?? 0)
      )
    );
  }

  /** The history served at a settle (cached for paging; the key moves with the overlay). */
  async function history(record: RecordSummary, settled: Settled): Promise<Message[]> {
    const id = record.conversationId;
    const overlay = dependencies.runtime(id)?.messages ?? EMPTY;
    const key = servedKey(settled, overlay.length);
    const cached = served.get(id);
    if (cached?.key === key) return cached.messages;
    const messages = mergeSessionMessages(await natives(record, settled.counts), overlay);
    served.delete(id);
    served.set(id, { key, messages });
    if (served.size > SERVED_CACHE) served.delete(served.keys().next().value as string);
    return messages;
  }

  /**
   * Snapshot the bound sessions' counts and the length of the history they serve. A single
   * session with no overlay needs no read: its count is the history. Several sessions (880 of
   * 8,161 records on 2026-09-26) can repeat an inherited prefix, so they are merged to count once.
   */
  async function computeSettle(record: RecordSummary, rewritten: boolean): Promise<Settled> {
    const id = record.conversationId;
    const before = settledOf.get(id);
    const bound = boundSessions(record);
    const counts = new Map(bound.map((session) => [session.sessionId, session.messageCount]));
    const overlay = dependencies.runtime(id)?.messages ?? EMPTY;
    const epoch = before?.epoch ?? 0;
    if (bound.length <= 1 && overlay.length === 0) {
      const count = bound[0]?.messageCount ?? 0;
      const shrank = before !== undefined && count < before.count;
      return { counts, count, overlayAt: 0, epoch: rewritten || shrank ? epoch + 1 : epoch };
    }
    const previous = served.get(id)?.messages;
    const next: Settled = { counts, count: 0, overlayAt: overlay.length, epoch };
    const merged = await history(record, next);
    next.count = merged.length;
    const replaced =
      rewritten ||
      (previous !== undefined
        ? !extendsHistory(previous, merged)
        : before !== undefined && (next.count < before.count || overlay.length > 0));
    if (!replaced) return next;
    const bumped = { ...next, epoch: epoch + 1 };
    // Re-key the cached merge under the new epoch so the first page does not merge again.
    served.set(id, { key: servedKey(bumped, overlay.length), messages: merged });
    return bumped;
  }

  /** Serialized per conversation: each settle reads the counts the previous one left. */
  function settle(id: string, rewritten: boolean): Promise<void> {
    const run = async () => {
      const record = recordOf.get(id);
      if (!record) return;
      if (dependencies.runtime(id)?.hasActiveProcess()) {
        const already = queued.get(id);
        queued.set(id, { rewritten: rewritten || (already?.rewritten ?? false) });
        return;
      }
      queued.delete(id);
      const before = settledOf.get(id);
      const next = await computeSettle(record, rewritten);
      settledOf.set(id, next);
      publish(record, before, next);
    };
    const chained = (settling.get(id) ?? Promise.resolve()).then(run, run);
    settling.set(id, chained);
    void chained.finally(() => {
      if (settling.get(id) === chained) settling.delete(id);
    });
    return chained;
  }

  /** Send what moved: the row (new, gone or changed fields) and a refetch when history was replaced. */
  function publish(record: RecordSummary, before: Settled | undefined, next: Settled): void {
    const id = record.conversationId;
    const runtime = dependencies.runtime(id);
    const previous = rows.get(id);
    const result = listing(record);
    if (result.t !== 'listed') {
      rows.delete(id);
      if (previous && !runtime) dependencies.broadcast({ type: 'removed', ids: [id] });
      return;
    }
    rows.set(id, result.row);
    if (runtime) {
      // The runtime's row carries the same history fields (historyFields below).
      const fields = historyFields(record, boundSessions(record), next, runtime);
      dependencies.broadcast({
        type: 'patch',
        id,
        patch: { t: 'activity', activityAt: fields.activityAt, messageCount: fields.messageCount },
      });
      dependencies.broadcast({ type: 'patch', id, patch: { t: 'label', label: fields.label } });
    } else if (!previous) {
      dependencies.broadcast({ type: 'rows', ...encodeRows([servedRow(record, result.row)]) });
    } else {
      for (const patch of patchesBetween(previous, result.row)) {
        dependencies.broadcast({ type: 'patch', id, patch });
      }
    }
    if (before && next.epoch !== before.epoch) {
      dependencies.broadcast({ type: 'patch', id, patch: { t: 'rewritten' } });
    }
  }

  // ---- boot ---------------------------------------------------------------------------------

  const [page, summaries] = await Promise.all([
    dependencies.ingest.listSessions({ since: 0 }),
    dependencies.records.listSummaries(),
  ]);
  rev = page.rev;
  for (const row of page.rows) sessions.set(row.sessionId, row);
  for (const record of summaries) if (record.status === 'active') index(record);
  // Every session an active or deleted record binds is spoken for; the rest were never recorded.
  const spoken = new Set(
    summaries.flatMap((record) => record.sessions.map((key) => key.sessionId))
  );
  const unrecorded = page.rows.filter((row) => !spoken.has(row.sessionId));
  let discovered = 0;
  await forEachConcurrently(unrecorded, SETTLE_CONCURRENCY, async (row) => {
    const record = await dependencies.discover(row);
    if (!record) return;
    index(summaryOf(record));
    discovered++;
  });

  let withoutCwd = 0;
  const multiSession: RecordSummary[] = [];
  for (const record of recordOf.values()) {
    const bound = boundSessions(record);
    if (bound.length > 1) multiSession.push(record);
    else settledOf.set(record.conversationId, unsettled(record));
  }
  await forEachConcurrently(multiSession, SETTLE_CONCURRENCY, async (record) => {
    settledOf.set(record.conversationId, await computeSettle(record, false));
  });
  for (const record of recordOf.values()) {
    const result = listing(record);
    switch (result.t) {
      case 'listed':
        rows.set(record.conversationId, result.row);
        break;
      case 'no_cwd':
        withoutCwd++;
        break;
      case 'no_transcript':
        break;
    }
  }
  if (withoutCwd > 0) {
    logger.warn(
      `[ingest-list] ${withoutCwd} conversations have no working directory in their record or transcripts (Muse approval-review children); left out of the list`
    );
  }
  logger.log(
    `[ingest-list] ${rows.size} conversations listed from ${sessions.size} sessions (${discovered} discovered, ${multiSession.length} merged across sessions)`
  );

  // ---- changes ------------------------------------------------------------------------------

  async function join(session: SessionRow): Promise<string | undefined> {
    const found = await dependencies.records.findBySession(session.provider, session.sessionId);
    const record = found ?? (await dependencies.discover(session));
    if (!record || record.status !== 'active') return undefined;
    const summary = summaryOf(record);
    index(summary);
    return summary.conversationId;
  }

  function markExternal(sessionId: string, conversationId: string, now: number): void {
    if (dependencies.completionSuppression.isSuppressed(sessionId, now)) return;
    if (dependencies.runtime(conversationId)?.hasActiveProcess()) return;
    const first = !dependencies.externalActivity.has(sessionId);
    dependencies.externalActivity.set(sessionId, now);
    if (first) {
      dependencies.broadcast({
        type: 'patch',
        id: conversationId,
        patch: { t: 'run', run: 'running' },
      });
    }
    backstop ??= setTimeout(expireExternal, dependencies.externalGraceMs);
  }

  /** The one backstop: a transcript quiet for the grace period stops showing as running. */
  function expireExternal(): void {
    backstop = null;
    const now = Date.now();
    for (const [sessionId, lastSeen] of [...dependencies.externalActivity.entries()]) {
      if (now - lastSeen < dependencies.externalGraceMs) continue;
      dependencies.externalActivity.delete(sessionId);
      const id = conversationBySession.get(sessionId);
      const record = id ? recordOf.get(id) : undefined;
      if (!id || !record) continue;
      const stillRunning = runOf(record) === 'running';
      if (!stillRunning && !dependencies.runtime(id)?.hasActiveProcess()) {
        dependencies.broadcast({ type: 'patch', id, patch: { t: 'run', run: 'idle' } });
      }
    }
    if ([...dependencies.externalActivity.entries()].length > 0) {
      backstop = setTimeout(expireExternal, dependencies.externalGraceMs);
    }
  }

  async function relist(event: Extract<ChangeEvent, { t: 'changes' }>): Promise<void> {
    const next = await dependencies.ingest.listSessions({ since: rev });
    rev = next.rev;
    const rewritten = new Set(event.rewritten);
    const touched = new Map<string, boolean>();
    const now = Date.now();
    for (const row of next.rows) {
      sessions.set(row.sessionId, row);
      // An unknown session is a record bound after boot (created, resumed, rotated) or a CLI run
      // outside the app: re-read or discover its record, which then names all its sessions.
      const id = conversationBySession.get(row.sessionId) ?? (await join(row));
      if (!id) continue;
      touched.set(id, (touched.get(id) ?? false) || rewritten.has(row.sessionId));
      markExternal(row.sessionId, id, now);
    }
    for (const removed of next.removed) {
      sessions.delete(removed.sessionId);
      const id = conversationBySession.get(removed.sessionId);
      if (id) touched.set(id, true);
    }
    await Promise.all([...touched].map(([id, replaced]) => settle(id, replaced)));
  }

  let pending: Promise<void> = Promise.resolve();

  return {
    // `rows` and `recordOf` share keys (both set by a listed publish, both cleared by forget).
    rows: () =>
      [...rows].flatMap(([id, row]) => {
        const record = recordOf.get(id);
        return record && !dependencies.runtime(id) ? [servedRow(record, row)] : [];
      }),
    ids: () => [...rows.keys()],
    joined(conversationId) {
      const record = recordOf.get(conversationId);
      if (!record) return undefined;
      return { record, sessions: boundSessions(record), row: rows.get(conversationId) ?? null };
    },
    locate(sessionId) {
      const id = conversationBySession.get(sessionId);
      const row = id ? rows.get(id) : undefined;
      return id && row ? { conversationId: id, workingDirectory: row.cwd } : undefined;
    },
    historyFields(runtime) {
      const record = recordOf.get(runtime.id);
      if (!record || boundSessions(record).length === 0) {
        return overlayHistoryFields(runtime);
      }
      const settled = settledOf.get(runtime.id) ?? unsettled(record);
      return historyFields(record, boundSessions(record), settled, runtime);
    },
    async page(conversationId, { afterSeq, limit }) {
      const record = recordOf.get(conversationId);
      const runtime = dependencies.runtime(conversationId);
      if (!record) return runtime ? pageOf(0, runtime.messages, afterSeq, limit) : null;
      await settling.get(conversationId);
      const settled = settledOf.get(conversationId) ?? unsettled(record);
      return pageOf(settled.epoch, await history(record, settled), afterSeq, limit);
    },
    idle(conversationId) {
      const change = queued.get(conversationId);
      if (change) void settle(conversationId, change.rewritten);
      else if (recordOf.has(conversationId)) void settle(conversationId, false);
    },
    forget(conversationId) {
      const record = recordOf.get(conversationId);
      recordOf.delete(conversationId);
      rows.delete(conversationId);
      settledOf.delete(conversationId);
      served.delete(conversationId);
      queued.delete(conversationId);
      for (const key of record?.sessions ?? []) conversationBySession.delete(key.sessionId);
    },
    onChange(event) {
      switch (event.t) {
        case 'failed':
          logger.error(`[ingest-list] ingest watcher failed: ${event.message}`);
          return;
        case 'changes':
          pending = pending
            .then(() => relist(event))
            .catch((error: Error) => logger.error('[ingest-list] re-list failed:', error.message));
          return;
      }
    },
    stop() {
      if (backstop) clearTimeout(backstop);
      backstop = null;
    },
  };
}

function servedKey(settled: Settled, overlayLength: number): string {
  return `${settled.epoch}:${[...settled.counts.values()].join(',')}:${overlayLength}`;
}

function pageOf(
  epoch: number,
  messages: readonly Message[],
  afterSeq: number,
  limit: number
): MessagePage {
  return {
    epoch,
    total: messages.length,
    afterSeq,
    messages: messages.slice(afterSeq + 1, afterSeq + 1 + limit),
  };
}

// Pattern: patches-not-snapshots (docs/patterns.md#patches-not-snapshots)
/** The field patches that move `before` to `after` (only the fields the store derives). */
function patchesBetween(before: ListedRow, after: ListedRow): RowPatch[] {
  const patches: RowPatch[] = [];
  if (before.label !== after.label) patches.push({ t: 'label', label: after.label });
  if (before.activityAt !== after.activityAt || before.messageCount !== after.messageCount) {
    patches.push({
      t: 'activity',
      activityAt: after.activityAt,
      messageCount: after.messageCount,
    });
  }
  return patches;
}
