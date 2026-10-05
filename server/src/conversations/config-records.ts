import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type {
  ConversationConfig,
  ConversationCreationMetadata,
  ConversationKind,
  Provider,
  ProviderTurnUsage,
  ResolvedExecutionConfig,
} from '@unleashd/shared';
import type * as Addon from '../../../crates/unleashd-ingest/index';

/**
 * Durable authority for conversation records: a thin mapping onto the Rust
 * `ConversationRecords` store (crates/unleashd-ingest/src/records). Until T23b
 * (2026-09-26) this was config-store.ts: one pretty-printed JSON file per
 * conversation plus one per session (16.8k files, 78 MB, all read at startup),
 * with an in-memory session index and per-process promise locks. The Rust store
 * owns validation, the session index (written in the record's own transaction)
 * and compare-and-set (`BEGIN IMMEDIATE`, exact across processes).
 *
 * Hazard: only the addon may open the file in this process. node:sqlite is a
 * second SQLite library; two in one process broke POSIX locking and killed the
 * T12 parity run with SIGBUS.
 */

// Loaded by path so the server package does not depend on the crate's package
// name. Same depth from src/conversations and dist/conversations.
const { ConversationRecords } = createRequire(__filename)(
  '../../../crates/unleashd-ingest/index.js'
) as typeof Addon;

export const INITIAL_MESSAGE_DISPATCH_LEASE_MS = 15_000;
export const RECORDS_FILE = 'conversation-records.sqlite';

/** The generated native contract is the stored record; shared schemas describe active inputs. */
// Pattern: one-type-source (docs/patterns.md#one-type-source)
export type ConversationRecord = Addon.ConversationRecord;
export type SessionBinding = ConversationRecord['sessionBindings'][number];
export type ConfigProvenance = ConversationRecord['provenance'];

export class ConfigRevisionConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number | undefined
  ) {
    super(
      `Configuration revision conflict: expected ${expectedRevision}, actual ${
        actualRevision ?? 'missing'
      }`
    );
    this.name = 'ConfigRevisionConflictError';
  }
}

/** Where the records live, decided once at boot. */
export type RecordsLocation =
  | { t: 'records'; file: string }
  /** A data dir that never had records (first run, tests): the store creates the file. */
  | { t: 'fresh'; file: string }
  /** The JSON records exist but were never imported: boot must stop. */
  | { t: 'unimported'; file: string; appDataRoot: string };

export function recordsLocation(appDataRoot: string): RecordsLocation {
  const file = path.join(appDataRoot, RECORDS_FILE);
  const legacyDirectory = path.join(appDataRoot, 'conversation-config', 'v1');
  if (fs.existsSync(file)) return { t: 'records', file };
  if (fs.existsSync(path.join(legacyDirectory, 'by-conversation'))) {
    return { t: 'unimported', file, appDataRoot };
  }
  return { t: 'fresh', file };
}

/**
 * Pattern: fix-guards (docs/patterns.md#fix-guards) — no silent fallback.
 * Opening a missing file creates an EMPTY store, so a data dir that still holds
 * the JSON records would boot with no conversation config at all and quietly
 * re-infer every one as `external_discovered`. Boot stops with the import
 * command instead. Guard: 'a data dir with unimported JSON records refuses to
 * boot' in server/test/config-service.test.ts.
 */
export function openRecords(location: RecordsLocation): Promise<Addon.ConversationRecords> {
  switch (location.t) {
    case 'records':
      return ConversationRecords.open(location.file);
    case 'fresh':
      fs.mkdirSync(path.dirname(location.file), { recursive: true });
      return ConversationRecords.open(location.file);
    case 'unimported':
      return Promise.reject(new Error(unimportedMessage(location)));
  }
}

function unimportedMessage(location: Extract<RecordsLocation, { t: 'unimported' }>): string {
  const root = location.appDataRoot;
  return [
    `Conversation records ${location.file} do not exist, but ${root}/conversation-config does.`,
    'They need the one-time records import, whose tools (unleashd-records-tool, record-migration.ts)',
    'were deleted after the 2026-09-27 swap: check out commit 03fc931 and follow',
    'agent_notes/2026-09-25_lean-rewrite/T15-RUNBOOK.md with the backend stopped.',
    'Keep conversation-config/ until the owner approves deleting it.',
  ].join('\n');
}

const maybe = (r: Addon.ConversationRecord | null): ConversationRecord | undefined =>
  r ?? undefined;

export type SetConfigResult = Addon.SetConfigOutcome;

/** Pattern: deep-modules (docs/patterns.md#deep-modules) — one call per store operation. */
export class ConversationRecordStore {
  constructor(
    private readonly ready: Promise<Addon.ConversationRecords>,
    private readonly now: () => Date = () => new Date()
  ) {
    // Observed by `opened()` (boot) and every call; this only stops Node from
    // treating a failed open as an unhandled rejection before boot awaits it.
    ready.catch(() => {});
  }

  /** Resolves once the store is open; rejects with the import command when it cannot be. */
  async opened(): Promise<void> {
    await this.ready;
  }

  private at(): number {
    return this.now().getTime();
  }

  async getByConversationId(conversationId: string): Promise<ConversationRecord | undefined> {
    return maybe(await (await this.ready).get(conversationId));
  }

  async findBySession(
    provider: Provider,
    sessionId: string
  ): Promise<ConversationRecord | undefined> {
    return maybe(await (await this.ready).findBySession(provider, sessionId));
  }

  listSummaries(): Promise<Addon.RecordSummary[]> {
    return this.ready.then((store) => store.listSummaries());
  }

  /** An existing id is `ConfigRevisionConflictError(-1)`; the caller decides replay. */
  async create(input: {
    conversationId: string;
    kind: ConversationKind;
    sessionBindings?: readonly SessionBinding[];
    currentSession?: SessionBinding;
    workingDirectory?: string;
    creation?: ConversationCreationMetadata;
    config: ConversationConfig;
    lastResolvedConfig?: ResolvedExecutionConfig;
    provenance: ConfigProvenance;
  }): Promise<ConversationRecord> {
    const outcome = await (await this.ready).create(
      {
        conversationId: input.conversationId,
        kind: input.kind,
        sessionBindings: [...(input.sessionBindings ?? [])],
        currentSession: input.currentSession,
        workingDirectory: input.workingDirectory,
        creation: input.creation,
        config: input.config,
        lastResolvedConfig: input.lastResolvedConfig,
        provenance: input.provenance,
      },
      this.at()
    );
    switch (outcome.t) {
      case 'created':
        return outcome.record;
      case 'exists':
        throw new ConfigRevisionConflictError(-1, outcome.current.configRevision);
    }
  }

  /** Compare-and-set on `configRevision`; ordinary edits have `user` provenance. */
  async setConfig(input: {
    conversationId: string;
    expectedConfigRevision: number;
    config: ConversationConfig;
    lastResolvedConfig: ResolvedExecutionConfig;
    provenance?: ConfigProvenance;
  }): Promise<SetConfigResult> {
    const outcome = await (await this.ready).setConfig(
      {
        conversationId: input.conversationId,
        expectedConfigRevision: input.expectedConfigRevision,
        config: input.config,
        lastResolvedConfig: input.lastResolvedConfig,
        provenance: input.provenance,
      },
      this.at()
    );
    return outcome;
  }

  /** Tombstone; the session index stays so transcripts remain recognisable. */
  async delete(conversationId: string): Promise<boolean> {
    return (await this.ready).markDeleted(conversationId, this.at());
  }

  /** Remove the row: rollback of a creation that was never exposed. */
  async purge(conversationId: string): Promise<boolean> {
    return (await this.ready).purge(conversationId);
  }

  /** Undefined when no record exists for this id. */
  async setDone(conversationId: string, done: boolean): Promise<ConversationRecord | undefined> {
    return maybe(await (await this.ready).setDone(conversationId, done, this.at()));
  }

  async setCurrentSession(
    conversationId: string,
    currentSession: SessionBinding
  ): Promise<ConversationRecord | undefined> {
    return maybe(
      await (await this.ready).setCurrentSession(conversationId, currentSession, this.at())
    );
  }

  /** Dropped (no-op) when the record's current session has moved on. */
  async setCurrentSessionUsage(
    conversationId: string,
    sessionId: string,
    latestUsage: ProviderTurnUsage
  ): Promise<ConversationRecord | undefined> {
    return maybe(
      await (await this.ready).setCurrentSessionUsage(
        conversationId,
        sessionId,
        latestUsage,
        this.at()
      )
    );
  }

  async addSessionBinding(
    conversationId: string,
    sessionBinding: SessionBinding
  ): Promise<ConversationRecord | undefined> {
    return maybe(
      await (await this.ready).addSessionBinding(conversationId, sessionBinding, this.at())
    );
  }

  /** Lease delivery of the creation message; undefined = not claimed. */
  async claimInitialMessageDispatch(
    conversationId: string,
    claimedAt = this.now()
  ): Promise<ConversationRecord | undefined> {
    return maybe(
      await (await this.ready).claimInitialMessageDispatch(
        conversationId,
        randomUUID(),
        claimedAt.getTime()
      )
    );
  }

  async completeInitialMessageDispatch(
    conversationId: string,
    claimToken: string,
    dispatchedAt = this.now()
  ): Promise<ConversationRecord | undefined> {
    return maybe(
      await (await this.ready).completeInitialMessageDispatch(
        conversationId,
        claimToken,
        dispatchedAt.getTime()
      )
    );
  }
}
