import {
  type ConfigError,
  type ConfigResolution,
  type ConversationConfig,
  type ConversationConfigPatch,
  type ConversationConfigState,
  type ConversationCreationMetadata,
  type ConversationKind,
  type Provider,
  type ResolvedExecutionConfig,
  type Result,
  applyConversationConfigPatch as applyConversationConfigSelectionPatch,
  isEffortValidForProvider,
  isModelIdValidForProvider,
  normalizeModelId,
} from '@unleashd/shared';
import {
  type ConfigProvenance,
  ConfigRevisionConflictError,
  type ConversationRecord,
  type ConversationRecordStore,
  type SessionBinding,
} from './config-records';
import { creationFingerprint } from './creation-service';

export interface ConversationConfigResolver {
  resolve(config: ConversationConfig): Promise<ConfigResolution>;
}

export type { ConversationConfigState } from '@unleashd/shared';

export interface ConfigUpdateContext {
  isRunning: boolean;
  queueDepth: number;
  hasStartedSession: boolean;
}

export interface ConfigUpdateCommand {
  conversationId: string;
  commandId: string;
  expectedRevision: number;
  patch: ConversationConfigPatch;
  /** Host selection origin; never accepted from a WS/owner request. */
  provenance?: ConfigProvenance;
}

export interface ConfigUpdateSuccess {
  commandId: string;
  previous: ConversationConfigState;
  next: ConversationConfigState;
}

export interface NewConversationConfigInput {
  conversationId: string;
  kind: ConversationKind;
  config: ConversationConfig;
  sessionBindings?: readonly SessionBinding[];
  currentSession?: SessionBinding;
  workingDirectory?: string;
  creation?: ConversationCreationMetadata;
  provenance?: ConfigProvenance;
}

export interface CreateConversationConfigResult {
  state: ConversationConfigState;
  record: ConversationRecord;
  replayed: boolean;
}

export interface HydrateConversationConfigInput {
  conversationId: string;
  /** Kind of a discovered transcript, stored only when this creates its record. */
  discoveredKind: ConversationKind;
  sessionBindings: readonly SessionBinding[];
  currentSession?: SessionBinding;
  workingDirectory?: string;
  sessionEvidence: SessionConfigEvidence;
}

export interface HydratedConversationConfig {
  state: ConversationConfigState;
  record: ConversationRecord;
  migrated: boolean;
  diagnostics: SessionConfigDiagnostic[];
}

export interface ConversationConfigServiceOptions {
  store: ConversationRecordStore;
  resolver: ConversationConfigResolver;
}

/**
 * Applies lifecycle policy and produces a complete selection without I/O.
 * Relational provider/model/effort validation remains the resolver's job.
 */
export function applyConversationConfigPatch(
  current: ConversationConfig,
  context: ConfigUpdateContext,
  patch: ConversationConfigPatch
): Result<ConversationConfig, ConfigError> {
  const nextProvider =
    patch.kind === 'set_provider'
      ? patch.provider
      : patch.kind === 'replace'
        ? patch.config.provider
        : current.provider;
  const changesProvider = nextProvider !== current.provider;

  // A spawned turn holds an immutable config snapshot, so model/effort changes apply to the next
  // turn; a provider change would invalidate the active session and its resume state.
  if (changesProvider && (context.isRunning || context.queueDepth > 0)) {
    return failure(
      'conversation_busy',
      context.isRunning
        ? 'Provider cannot change while a turn is running'
        : 'Provider cannot change while messages are queued'
    );
  }
  if (changesProvider && context.hasStartedSession) {
    return failure(
      'provider_locked',
      'Provider cannot change after the conversation has started',
      current.provider
    );
  }
  if (patch.kind === 'set_provider' && !changesProvider) return { ok: true, value: current };
  return { ok: true, value: applyConversationConfigSelectionPatch(current, patch) };
}

export class ConversationConfigService {
  private readonly store: ConversationRecordStore;
  private readonly resolver: ConversationConfigResolver;

  constructor(options: ConversationConfigServiceOptions) {
    this.store = options.store;
    this.resolver = options.resolver;
  }

  resolve(config: ConversationConfig): Promise<ConfigResolution> {
    return this.resolver.resolve(config);
  }

  async create(input: NewConversationConfigInput): Promise<ConversationConfigState> {
    return (await this.createOrReplay(input)).state;
  }

  async createOrReplay(input: NewConversationConfigInput): Promise<CreateConversationConfigResult> {
    const existing = await this.store.getByConversationId(input.conversationId);
    if (existing) {
      if (existing.status === 'deleted') throw new ConversationTombstonedError(existing);
      if (isMatchingCreateReplay(existing, input)) {
        return { ...(await this.existing(existing)), replayed: true };
      }
      throw new ConfigRevisionConflictError(-1, existing.configRevision);
    }

    const resolution = await this.resolver.resolve(input.config);
    assertResolved(resolution);
    let record: ConversationRecord;
    try {
      record = await this.store.create({
        conversationId: input.conversationId,
        sessionBindings: input.sessionBindings,
        currentSession: input.currentSession,
        workingDirectory: input.workingDirectory,
        creation: input.creation,
        kind: input.kind,
        config: input.config,
        lastResolvedConfig: resolution.value,
        provenance: input.provenance ?? 'user',
      });
    } catch (error) {
      if (!(error instanceof ConfigRevisionConflictError)) throw error;
      const winner = await this.store.getByConversationId(input.conversationId);
      if (!winner || !isMatchingCreateReplay(winner, input)) throw error;
      return { ...(await this.existing(winner)), replayed: true };
    }
    return {
      state: { config: input.config, revision: 0, resolution },
      record,
      replayed: false,
    };
  }

  async hydrate(input: HydrateConversationConfigInput): Promise<HydratedConversationConfig> {
    const existing =
      (await this.store.getByConversationId(input.conversationId)) ??
      (await findFirstSessionRecord(this.store, input.sessionBindings));
    if (existing) {
      if (existing.status === 'deleted') throw new ConversationTombstonedError(existing);
      // Updates return the record they wrote: no re-read (a measurable share of boot, 2026-09-25).
      let refreshed = existing;
      for (const binding of input.sessionBindings) {
        refreshed =
          (await this.store.addSessionBinding(existing.conversationId, binding)) ?? refreshed;
      }
      const inferredCurrentSession =
        existing.currentSession ?? existing.sessionBindings.at(-1) ?? input.currentSession;
      if (inferredCurrentSession && !existing.currentSession) {
        refreshed =
          (await this.store.setCurrentSession(existing.conversationId, inferredCurrentSession)) ??
          refreshed;
      }
      return { ...(await this.existing(refreshed)), migrated: false, diagnostics: [] };
    }

    const migration = configFromSessionEvidence(input.sessionEvidence);
    const resolution = await this.resolver.resolve(migration.config);
    let record: ConversationRecord;
    try {
      record = await this.store.create({
        conversationId: input.conversationId,
        sessionBindings: input.sessionBindings,
        currentSession: input.currentSession,
        workingDirectory: input.workingDirectory,
        kind: input.discoveredKind,
        config: migration.config,
        lastResolvedConfig: resolution.status === 'resolved' ? resolution.value : undefined,
        provenance: migration.provenance,
      });
    } catch (error) {
      if (!(error instanceof ConfigRevisionConflictError)) throw error;
      // Two native artifacts raced for one conversation: durable state wins.
      const winner =
        (await this.store.getByConversationId(input.conversationId)) ??
        (await findFirstSessionRecord(this.store, input.sessionBindings));
      if (!winner) throw error;
      return { ...(await this.existing(winner)), migrated: false, diagnostics: [] };
    }
    return {
      state: { config: record.config, revision: 0, resolution },
      record,
      migrated: true,
      diagnostics: migration.diagnostics,
    };
  }

  async setCurrentSession(conversationId: string, binding: SessionBinding): Promise<void> {
    await this.store.setCurrentSession(conversationId, binding);
  }

  setDone(conversationId: string, done: boolean): Promise<ConversationRecord | undefined> {
    return this.store.setDone(conversationId, done);
  }

  getRecord(conversationId: string): Promise<ConversationRecord | undefined> {
    return this.store.getByConversationId(conversationId);
  }

  claimInitialMessageDispatch(
    conversationId: string,
    dispatchedAt?: Date
  ): Promise<ConversationRecord | undefined> {
    return this.store.claimInitialMessageDispatch(conversationId, dispatchedAt);
  }

  completeInitialMessageDispatch(
    conversationId: string,
    claimToken: string,
    dispatchedAt?: Date
  ): Promise<ConversationRecord | undefined> {
    return this.store.completeInitialMessageDispatch(conversationId, claimToken, dispatchedAt);
  }

  delete(conversationId: string): Promise<boolean> {
    return this.store.delete(conversationId);
  }

  purge(conversationId: string): Promise<boolean> {
    return this.store.purge(conversationId);
  }

  async update(
    current: ConversationConfigState,
    context: ConfigUpdateContext,
    command: ConfigUpdateCommand
  ): Promise<Result<ConfigUpdateSuccess, ConfigError>> {
    if (command.expectedRevision !== current.revision) {
      return failure(
        'revision_conflict',
        `Configuration revision conflict: expected ${command.expectedRevision}, actual ${current.revision}`
      );
    }
    const transition = applyConversationConfigPatch(current.config, context, command.patch);
    if (!transition.ok) return transition;

    const resolution = await this.resolver.resolve(transition.value);
    if (resolution.status !== 'resolved') {
      return { ok: false, error: resolution.error };
    }

    // Compare-and-set in the store's own write transaction: exact across
    // processes, where config-store.ts's promise locks covered one process.
    const outcome = await this.store.setConfig({
      conversationId: command.conversationId,
      expectedConfigRevision: current.revision,
      config: transition.value,
      lastResolvedConfig: resolution.value,
      provenance: command.provenance,
    });
    switch (outcome.t) {
      case 'committed':
        break;
      case 'revision_conflict':
        return failure(
          'revision_conflict',
          `Configuration revision conflict: expected ${current.revision}, actual ${outcome.current.configRevision}`
        );
      case 'tombstoned':
        return failure('revision_conflict', 'Conversation has been deleted');
      case 'missing':
        return failure(
          'revision_conflict',
          'Configuration record disappeared before the update was committed'
        );
    }
    const nextRevision = current.revision + 1;

    return {
      ok: true,
      value: {
        commandId: command.commandId,
        previous: current,
        next: {
          config: transition.value,
          revision: nextRevision,
          resolution,
        },
      },
    };
  }

  /** A live record's state (a tombstone throws); an unavailable resolution keeps its last one. */
  private async existing(
    record: ConversationRecord
  ): Promise<{ state: ConversationConfigState; record: ConversationRecord }> {
    if (record.status === 'deleted') throw new ConversationTombstonedError(record);
    const current = await this.resolver.resolve(record.config);
    const resolution =
      current.status === 'unavailable' && record.lastResolvedConfig
        ? { ...current, lastResolved: record.lastResolvedConfig }
        : current;
    return {
      state: { config: record.config, revision: record.configRevision, resolution },
      record,
    };
  }
}

async function findFirstSessionRecord(
  store: ConversationRecordStore,
  bindings: readonly SessionBinding[]
): Promise<ConversationRecord | undefined> {
  for (const binding of bindings) {
    const record = await store.findBySession(binding.provider, binding.sessionId);
    if (record) return record;
  }
  return undefined;
}

function assertResolved(resolution: ConfigResolution): asserts resolution is ConfigResolution & {
  status: 'resolved';
  value: ResolvedExecutionConfig;
} {
  if (resolution.status !== 'resolved') {
    throw new ConversationConfigResolutionError(resolution.error);
  }
}

export class ConversationConfigResolutionError extends Error {
  constructor(readonly configError: ConfigError) {
    super(configError.message);
    this.name = 'ConversationConfigResolutionError';
  }
}

export class ConversationTombstonedError extends Error {
  constructor(readonly record: ConversationRecord) {
    super(`Conversation has been deleted: ${record.conversationId}`);
    this.name = 'ConversationTombstonedError';
  }
}

// The stored fingerprint is of the CREATION config; a reopen after a settings change sends the
// current one, so match that too or the reply conflicts (493c1c7; guard config-service.test.ts
// "a config update stays replayable…"). Computed here: creation is write-once.
function fingerprintAtCurrentConfig(existing: ConversationRecord): string | null {
  const creation = existing.creation;
  if (!creation?.fingerprint || existing.workingDirectory === undefined) return null;
  return creationFingerprint({
    workingDirectory: existing.workingDirectory,
    config: existing.config,
    initialMessage: creation.initialMessage,
    swarmDebugPrefix: creation.swarmDebugPrefix,
    resumedFromConversationId: creation.resumedFromConversationId,
    kind: existing.kind,
    branch: creation.branch,
  });
}

function isMatchingCreateReplay(
  existing: ConversationRecord,
  input: NewConversationConfigInput
): boolean {
  const commandId = input.creation?.commandId;
  const fingerprint = input.creation?.fingerprint;
  if (!commandId && !fingerprint) return false;
  if (commandId && existing.creation?.commandId !== commandId) return false;
  if (
    fingerprint &&
    existing.creation?.fingerprint !== fingerprint &&
    fingerprintAtCurrentConfig(existing) !== fingerprint
  ) {
    return false;
  }
  if (
    input.creation?.initialMessage !== undefined &&
    existing.creation?.initialMessage !== input.creation.initialMessage
  ) {
    return false;
  }
  if (
    input.workingDirectory !== undefined &&
    existing.workingDirectory !== input.workingDirectory
  ) {
    return false;
  }
  return JSON.stringify(existing.config) === JSON.stringify(input.config);
}

function failure(
  code: ConfigError['code'],
  message: string,
  provider?: ConversationConfig['provider']
): Result<never, ConfigError> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(provider ? { provider } : {}),
    },
  };
}

export interface SessionConfigEvidence {
  provider: Provider;
  /** Provider-reported model, or `unknown` when the native session has none. */
  reportedModel?: string | null;
  /** Effort recorded by the native session. */
  reasoningEffort?: string | null;
  /** Native sessions discovered without an application record use external provenance. */
  source?: 'legacy_application' | 'external_session';
}

export interface SessionConfigDiagnostic {
  code: 'unknown_reported_model' | 'invalid_legacy_effort';
  message: string;
  reportedModel?: string;
  reasoningEffort?: string;
}

/** κ for a discovered native session with no record: session evidence → config. */
function configFromSessionEvidence(evidence: SessionConfigEvidence): {
  config: ConversationConfig;
  provenance: ConfigProvenance;
  diagnostics: SessionConfigDiagnostic[];
} {
  const diagnostics: SessionConfigDiagnostic[] = [];
  const reportedModel = trimmed(evidence.reportedModel);
  // Claude reports this versioned name for the catalog's Fable alias.
  // Recover it only from session evidence; explicit stored selections stay unchanged.
  const reported =
    evidence.provider === 'claude' && reportedModel === 'claude-fable-5-1'
      ? 'fable'
      : reportedModel;
  // Collapse provider aliases (e.g. composer-2 → composer-2.5) before validation
  // so historical session labels land on the current catalog id.
  const modelId = reported && (normalizeModelId(evidence.provider, reported) ?? reported);
  const modelValid = modelId !== undefined && isModelIdValidForProvider(evidence.provider, modelId);
  if (reportedModel && !modelValid) {
    diagnostics.push({
      code: 'unknown_reported_model',
      message: `Could not map reported ${evidence.provider} model "${reportedModel}" to a current catalog model`,
      reportedModel,
    });
  }

  const reasoningEffort = trimmed(evidence.reasoningEffort);
  const reasoningValid =
    reasoningEffort !== undefined && isEffortValidForProvider(evidence.provider, reasoningEffort);
  if (reasoningEffort && !reasoningValid) {
    diagnostics.push({
      code: 'invalid_legacy_effort',
      message: `Ignoring unavailable ${evidence.provider} reasoning effort "${reasoningEffort}"`,
      reasoningEffort,
    });
  }

  return {
    config: {
      provider: evidence.provider,
      model: modelValid && modelId ? { mode: 'explicit', modelId } : { mode: 'default' },
      // Unknown effort is disabled: today's default would change a historical resume command.
      reasoning:
        reasoningValid && reasoningEffort
          ? { mode: 'explicit', effort: reasoningEffort }
          : { mode: 'disabled' },
    },
    provenance: evidence.source === 'external_session' ? 'external_discovered' : 'legacy_inferred',
    diagnostics,
  };
}

function trimmed(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
