/**
 * Runtimes built from durable records, never from transcripts (T13b S2): at boot only the records
 * that NEED a live runtime become one (`needsRuntime`); every other listed conversation, app-created
 * or discovered, becomes one on first use through `materialize`. Before, a conversation outside the
 * loader's 500-row window 404'd on open. Guards: server/test/ingest-history.test.ts and
 * server/test/lazy-recovery.test.ts.
 */

import type { SubAgent as NativeSubAgent, RecordSummary, SessionRow } from '@unleashd/ingest';
import type { BuddyContext, ConversationRow, SubAgent } from '@unleashd/shared';
import { encodeRows } from '@unleashd/shared';
import type { ConversationRegistry } from '../application/context';
import type { MemoryGenerationInput } from '../buddies/turn-policy';
import type { ConversationRecord, ConversationRecordStore } from '../conversations/config-records';
import type { ConversationConfigService } from '../conversations/config-service';
import type {
  ConversationBroadcast,
  ConversationOptions,
  ConversationRuntime,
} from '../conversations/runtime';
import { type JoinedConversation, forEachConcurrently } from './conversation-list';

const RECOVERY_CONCURRENCY = 16;
const ROW_BATCH = 100;

export interface RuntimeBuilderDependencies {
  registry: ConversationRegistry<ConversationRuntime>;
  records: Pick<ConversationRecordStore, 'getByConversationId' | 'listSummaries'>;
  configService: Pick<ConversationConfigService, 'hydrate'>;
  /** The list's join of a record with its sessions (undefined before the list booted). */
  joined(conversationId: string): JoinedConversation | undefined;
  /** Conversations that run or hold input with no command to open them: queued owner inputs and live Buddy runs. */
  pinned(): Promise<ReadonlySet<string>>;
  createConversation(options: ConversationOptions): ConversationRuntime;
  resolveBuddyConversation(context: BuddyContext): Promise<{
    context: BuddyContext;
    briefing: string;
    memoryGeneration?: MemoryGenerationInput | null;
  }>;
  dispatchInitialMessage(conversation: ConversationRuntime): Promise<void>;
  broadcast(data: ConversationBroadcast): void;
  logger?: Pick<Console, 'error' | 'log' | 'warn'>;
}

export interface RuntimeBuilder {
  /** Boot: a runtime for every app-created record that needs one now (the rest: on first use). */
  recover(): Promise<void>;
  /** The runtime of a conversation, built from its record on first use. */
  materialize(conversationId: string): Promise<ConversationRuntime | undefined>;
}

/** A sub-agent the transcript recorded: finished by definition (no process is running it). */
function recordedSubAgent(agent: NativeSubAgent, session: SessionRow): SubAgent {
  const startedAt = new Date(agent.startedAt ?? session.createdAt);
  return {
    id: agent.id,
    description: agent.description,
    status: 'completed',
    toolUses: agent.toolUses,
    tokens: 0,
    ...(agent.currentAction ? { currentAction: agent.currentAction } : {}),
    startedAt,
    completedAt: agent.completedAt !== undefined ? new Date(agent.completedAt) : startedAt,
  };
}

function normalizeMemoryGeneration(value: MemoryGenerationInput | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

export function createRuntimeBuilder(dependencies: RuntimeBuilderDependencies): RuntimeBuilder {
  const logger = dependencies.logger ?? console;
  const building = new Map<string, Promise<ConversationRuntime | undefined>>();

  async function build(record: ConversationRecord): Promise<ConversationRuntime | null> {
    const joined = dependencies.joined(record.conversationId);
    const workingDirectory = record.workingDirectory ?? joined?.row?.cwd;
    if (!workingDirectory) return null;
    // The fork source's runtime is read SYNCHRONOUSLY by the first turn (runtime.ts
    // `chatForkSource`), so a runtime that has not started a session holds its source's first.
    const forkSource = record.creation?.resumedFromConversationId;
    if (forkSource && !record.currentSession) await materialize(forkSource);
    const hydrated = await dependencies.configService.hydrate(
      {
        conversationId: record.conversationId,
        sessionBindings: [],
        discoveredKind: record.kind,
        sessionEvidence: {
          provider: record.config.provider,
          reportedModel: record.lastResolvedConfig?.modelId,
          source: 'external_session',
        },
      },
      record
    );
    const currentSession =
      hydrated.record.currentSession?.provider === hydrated.state.config.provider
        ? hydrated.record.currentSession
        : undefined;
    // A resumed session is no memory-generation boundary: only a record without one (a pending
    // first message) gets the latest briefing.
    const buddy =
      record.kind.t === 'buddy' && !currentSession
        ? await dependencies.resolveBuddyConversation(record.kind.context).catch((error) => {
            logger.warn(`[buddies] Could not rebuild ${record.conversationId} briefing:`, error);
            return null;
          })
        : null;
    const sessions = joined?.sessions ?? [];
    const current =
      sessions.find((session) => session.sessionId === currentSession?.sessionId) ??
      sessions.at(-1);
    const conversation = dependencies.createConversation({
      id: record.conversationId,
      workingDirectory,
      configState: hydrated.state,
      done: hydrated.record.done,
      existingSessionId: currentSession?.sessionId,
      existingSessionAudienceKey: currentSession?.buddyAudienceKey,
      // Provider-counted context measured before the restart keeps the meter honest.
      existingProviderUsage: currentSession?.latestUsage ?? null,
      swarmDebugPrefix: record.creation?.swarmDebugPrefix ?? current?.swarmDebugPrefix ?? null,
      resumedFromConversationId:
        record.creation?.resumedFromConversationId ?? joined?.row?.resumedFrom ?? null,
      parentConversationId: joined?.row?.parent ?? null,
      observedModel: current?.observedModel ?? null,
      title: current?.title ?? null,
      kind:
        record.kind.t === 'buddy' && buddy
          ? { ...record.kind, context: buddy.context }
          : record.kind,
      buddyBriefing: buddy?.briefing ?? null,
      buddyMemoryGeneration: normalizeMemoryGeneration(buddy?.memoryGeneration),
    });
    // The record's (discovered: the transcript's) birth, not `new Date()` ("1m ago" on old history).
    conversation.createdAt = new Date(joined?.row?.createdAt ?? record.createdAt);
    conversation.subAgents = current
      ? current.subAgents.map((agent) => recordedSubAgent(agent, current))
      : [];
    return conversation;
  }

  /** One build per id at a time; a runtime registered meanwhile (a create command) wins. */
  function register(
    conversationId: string,
    read: () => Promise<ConversationRecord | undefined>
  ): Promise<ConversationRuntime | undefined> {
    const existing = dependencies.registry.get(conversationId);
    if (existing) return Promise.resolve(existing);
    const inFlight = building.get(conversationId);
    if (inFlight) return inFlight;
    const promise = (async () => {
      const record = await read();
      if (!record || record.status !== 'active') return undefined;
      const conversation = await build(record);
      if (!conversation) return undefined;
      const raced = dependencies.registry.get(conversationId);
      if (raced) return raced;
      dependencies.registry.set(conversation);
      return conversation;
    })().finally(() => building.delete(conversationId));
    building.set(conversationId, promise);
    return promise;
  }

  function materialize(conversationId: string): Promise<ConversationRuntime | undefined> {
    return register(conversationId, () => dependencies.records.getByConversationId(conversationId));
  }

  /**
   * Whether a record's runtime must exist before anyone opens it. Pattern: lazy-runtimes
   * (docs/patterns.md#lazy-runtimes). Eager recovery built a runtime per app-created record (8,176
   * on 2026-10-23, ~4-5 s of boot) though the list index already serves their rows. Every reader
   * of a runtime by id (runner host, Buddy seats, branches, WS create) now goes through
   * `materialize`, so a cold record is never "absent" and never re-created. A runtime is needed now
   * when
   *  - it is pinned (queued inputs, live Buddy runs), or
   *  - its first message was never dispatched (nothing else would send it).
   * Everything else, of any kind, is cold: a record with no transcript is listed from the record
   * alone (`bareRowOf`), not from a runtime (4,114 runtimes, 0.8-2.8 s of boot, 2026-10-23).
   * Guards: server/test/ingest-history.test.ts "boot materializes only the records that need a
   * runtime" and server/test/lazy-buddy-runtimes.test.ts.
   */
  function needsRuntime(summary: RecordSummary, pinned: ReadonlySet<string>): boolean {
    return (
      pinned.has(summary.conversationId) ||
      (dependencies.joined(summary.conversationId)?.pendingFirstMessage ?? false)
    );
  }

  async function recover(): Promise<void> {
    const [summaries, pinned] = await Promise.all([
      dependencies.records.listSummaries(),
      dependencies.pinned(),
    ]);
    // Discovered records materialize only on use (eager recovery made 5,275 empty rows, 2026-09-06).
    const appCreated = summaries.filter(
      (summary) =>
        summary.status === 'active' &&
        summary.provenance !== 'external_discovered' &&
        needsRuntime(summary, pinned)
    );
    const rows: ConversationRow[] = [];
    const flush = () => {
      const batch = rows.splice(0);
      if (batch.length > 0) dependencies.broadcast({ type: 'rows', ...encodeRows(batch) });
    };
    await forEachConcurrently(appCreated, RECOVERY_CONCURRENCY, async (summary) => {
      // Per-record isolation: this runs inside the startup barrier, and one unreadable record
      // used to exit the process (incident 2026-08-20).
      try {
        if (dependencies.registry.has(summary.conversationId)) return;
        const record = await dependencies.records.getByConversationId(summary.conversationId);
        const conversation = await register(summary.conversationId, async () => record);
        if (!conversation) return;
        rows.push(conversation.toRow());
        if (rows.length >= ROW_BATCH) flush();
        // Only a still-pending first message pays the claim (two record reads).
        const creation = record?.creation;
        if (creation?.initialMessage && !creation.initialMessageDispatchedAt) {
          await dependencies.dispatchInitialMessage(conversation);
        }
      } catch (error) {
        logger.error(`Failed to recover conversation ${summary.conversationId}:`, error);
      }
    });
    flush();
    logger.log(
      `Recovered ${dependencies.registry.size} of ${summaries.length} records as runtimes (the rest materialize on first use)`
    );
  }

  return { recover, materialize };
}
