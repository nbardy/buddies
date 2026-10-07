import type { ConversationKind } from '@unleashd/ingest';
import { z } from 'zod';
import { BuddyKnowledgeScopeSchema } from './buddy-knowledge-scope.js';
import {
  type Provider,
  type ProviderCatalog,
  ProviderSchema,
  findModelDefinition,
  findProviderCatalogEntry,
} from './provider-catalog.js';

export const ModelIdSchema = z.string().min(1);
export type ModelId = z.infer<typeof ModelIdSchema>;

export const ReasoningEffortSchema = z.string().min(1);

export const ModelSelectionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('default') }),
  z.object({ mode: z.literal('explicit'), modelId: ModelIdSchema }),
]);
export type ModelSelection = z.infer<typeof ModelSelectionSchema>;

export const ReasoningSelectionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('default') }),
  z.object({ mode: z.literal('disabled') }),
  z.object({ mode: z.literal('explicit'), effort: ReasoningEffortSchema }),
]);
export type ReasoningSelection = z.infer<typeof ReasoningSelectionSchema>;

export const ConversationConfigSchema = z.object({
  provider: ProviderSchema,
  model: ModelSelectionSchema,
  reasoning: ReasoningSelectionSchema,
});
export type ConversationConfig = z.infer<typeof ConversationConfigSchema>;

export const ConversationConfigPatchSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('replace'), config: ConversationConfigSchema }),
  z.object({ kind: z.literal('set_provider'), provider: ProviderSchema }),
  z.object({ kind: z.literal('set_model'), model: ModelSelectionSchema }),
  z.object({
    kind: z.literal('set_reasoning'),
    reasoning: ReasoningSelectionSchema,
  }),
]);
export type ConversationConfigPatch = z.infer<typeof ConversationConfigPatchSchema>;

export const ResolvedExecutionConfigSchema = z.object({
  provider: ProviderSchema,
  modelId: ModelIdSchema,
  reasoningEffort: ReasoningEffortSchema.optional(),
});
export type ResolvedExecutionConfig = z.infer<typeof ResolvedExecutionConfigSchema>;

export const ConfigErrorCodeSchema = z.enum([
  'provider_unavailable',
  'model_unavailable',
  'reasoning_unsupported',
  'reasoning_unavailable',
  'provider_locked',
  'conversation_busy',
  'revision_conflict',
]);

export const ConfigErrorSchema = z.object({
  code: ConfigErrorCodeSchema,
  message: z.string().min(1),
  provider: ProviderSchema.optional(),
  modelId: ModelIdSchema.optional(),
  validValues: z.array(z.string()).optional(),
});
export type ConfigError = z.infer<typeof ConfigErrorSchema>;

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export const ConfigResolutionSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('resolved'),
    catalogRevision: z.string().min(1),
    value: ResolvedExecutionConfigSchema,
  }),
  z.object({
    status: z.literal('unavailable'),
    catalogRevision: z.string().min(1),
    error: ConfigErrorSchema,
    lastResolved: ResolvedExecutionConfigSchema.optional(),
  }),
]);
export type ConfigResolution = z.infer<typeof ConfigResolutionSchema>;

export const ConversationConfigStateSchema = z.object({
  config: ConversationConfigSchema,
  revision: z.number().int().nonnegative(),
  resolution: ConfigResolutionSchema,
});
export type ConversationConfigState = z.infer<typeof ConversationConfigStateSchema>;

/**
 * Provider-counted tokens for the most recent request on a session. This is
 * measured truth from the harness, NOT our chars/4 estimate: `contextTokens`
 * is the total input the provider actually counted, so a provider-side
 * compaction makes it DROP rather than climb.
 *
 * Each harness reports under a different convention; agent-cli canonicalises
 * them in its parsers (claude sums input + cache_read + cache_creation, codex
 * reports input_tokens alone with cache already inside it). Consumers here see
 * one shape and must not re-derive it.
 *
 * `contextWindow` is present only when the harness reports one (codex does;
 * claude does not). Absent means "ask the model id", not "unknown".
 */
export const ProviderTurnUsageSchema = z.object({
  contextTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  contextWindow: z.number().int().positive().optional(),
  observedAt: z.string().datetime(),
});
export type ProviderTurnUsage = z.infer<typeof ProviderTurnUsageSchema>;

// Conversation IDs are opaque: Buddy runs use deterministic prefixed IDs and
// older provider imports can be non-UUIDs. Use the same contract on disk and
// across the wire.
export const ConversationIdSchema = z.string().min(1);

export const BuddyContextSchema = z.object({
  // `knowledgeScope` (per-chat memory audience) was dropped 2026-09-26; old rows carrying it parse
  // because this object strips unknown keys.
  coordinationRunId: z.string().min(1).nullish(),
  buddyId: z.string().min(1),
  workspaceId: z.string().min(1),
  buddyProjectId: z.string().min(1).nullish(),
  legacyWorkItemId: z.string().min(1).nullish(),
  automationRunId: z.string().min(1).nullish(),
  // Set only for Buddy-to-Buddy work. This is employee delegation metadata,
  // not a provider-native subagent/swarm relationship.
  delegatedByBuddyId: z.string().min(1).nullish(),
  parentBuddyConversationId: ConversationIdSchema.nullish(),
  // Delegated conversations can expose only the Buddy state operations
  // required by the assignment. Provider-native tools are unaffected.
  allowedBuddyOperations: z.array(z.string().min(1)).min(1).optional(),
});
export type BuddyContext = z.infer<typeof BuddyContextSchema>;

// Pattern: sum-types (docs/patterns.md#sum-types)
// The ONE encoding of "what is this thread", fixed at creation and stored in
// the record. Until T09 (2026-09-25) kind was encoded four ways (`kind`,
// `creation.buddyContext`, `purpose`, a transcript text marker) next to
// `placement` and five nullable worker fields, and hydration picked "the first
// specific candidate" among them. Records were migrated once
// (the one-time record migration, deleted after the 2026-09-27 swap (last at 03fc931)); nothing else derives kind.
export const BuddyVisibilitySchema = z.enum(['foreground', 'background']);
export type BuddyVisibility = z.infer<typeof BuddyVisibilitySchema>;

export const WorkerRoleSchema = z.enum(['work', 'review', 'fix']);

// The type is the records store's own (crates/unleashd-ingest `ConversationKind`, generated into
// its index.d.ts): Rust stores and validates it, so TS no longer re-declares it (core review §3).
// The quarantined swarm `worker` variant is classified once from the oompa tag; null ids mean an
// untagged `[oompa]`, a null role that the first message did not say.
export type { ConversationKind };
export type BuddyKind = Extract<ConversationKind, { t: 'buddy' }>;
export type WorkerKind = Extract<ConversationKind, { t: 'worker' }>;

export const CHAT_KIND: ConversationKind = Object.freeze({ t: 'chat' });

/** Thin exhaustive dispatcher over the kind: the one structural switch on it. */
export function matchConversationKind<T>(
  kind: ConversationKind,
  handlers: {
    chat: () => T;
    buddy: (kind: BuddyKind) => T;
    builder: () => T;
    worker: (kind: WorkerKind) => T;
  }
): T {
  switch (kind.t) {
    case 'chat':
      return handlers.chat();
    case 'buddy':
      return handlers.buddy(kind);
    case 'builder':
      return handlers.builder();
    case 'worker':
      return handlers.worker(kind);
  }
}

/** A Buddy thread's run data, or null for every other kind. */
export function kindBuddyContext(kind: ConversationKind): BuddyContext | null {
  return kind.t === 'buddy' ? kind.context : null;
}

/**
 * Visibility of a new Buddy thread: runs a Buddy starts on its own
 * (automation, delegation, coordination) are background work, owner chats are
 * foreground. Decided once at creation and stored in the kind.
 */
export function defaultBuddyVisibility(context: BuddyContext): BuddyVisibility {
  return context.automationRunId || context.coordinationRunId || context.delegatedByBuddyId
    ? 'background'
    : 'foreground';
}

/** A new Buddy thread's kind, with its visibility decided from the context. */
export function buddyKind(context: BuddyContext, visibility?: BuddyVisibility): BuddyKind {
  return { t: 'buddy', context, visibility: visibility ?? defaultBuddyVisibility(context) };
}

export const ConversationBranchSchema = z.object({
  sourceConversationId: ConversationIdSchema,
  throughMessageId: z.string().min(1),
  audience: BuddyKnowledgeScopeSchema,
  handoff: z.string().max(64000),
  launches: z.record(z.string(), z.string().max(64000)).optional(),
});
export type ConversationBranch = z.infer<typeof ConversationBranchSchema>;

export const ConversationCreationMetadataSchema = z.object({
  branch: ConversationBranchSchema.optional(),
  commandId: z.string().min(1).optional(),
  fingerprint: z.string().min(1).optional(),
  initialMessage: z.string().min(1).optional(),
  initialMessageDispatchClaimedAt: z.string().datetime().optional(),
  initialMessageDispatchClaimToken: z.string().min(1).optional(),
  initialMessageDispatchedAt: z.string().datetime().optional(),
  swarmDebugPrefix: z.string().optional(),
  resumedFromConversationId: ConversationIdSchema.optional(),
});
export type ConversationCreationMetadata = z.infer<typeof ConversationCreationMetadataSchema>;

export function createDefaultConversationConfig(provider: Provider = 'claude'): ConversationConfig {
  return {
    provider,
    model: { mode: 'default' },
    reasoning: { mode: 'default' },
  };
}

/**
 * Applies selection intent only. Relational validation and resolution are a
 * separate step so hydration can retain explicit values retired by a catalog.
 */
export function applyConversationConfigPatch(
  current: ConversationConfig,
  patch: ConversationConfigPatch
): ConversationConfig {
  switch (patch.kind) {
    case 'replace':
      return patch.config;
    case 'set_provider':
      return {
        provider: patch.provider,
        model: { mode: 'default' },
        reasoning: { mode: 'default' },
      };
    case 'set_model':
      return { ...current, model: patch.model };
    case 'set_reasoning':
      return { ...current, reasoning: patch.reasoning };
  }
}

function unavailable(
  catalogRevision: string,
  error: ConfigError,
  lastResolved?: ResolvedExecutionConfig
): ConfigResolution {
  return {
    status: 'unavailable',
    catalogRevision,
    error,
    ...(lastResolved ? { lastResolved } : {}),
  };
}

/**
 * Resolves durable selection intent into provider-native execution strings.
 * No value is translated or silently substituted.
 */
export function resolveConversationConfig(
  config: ConversationConfig,
  catalog: ProviderCatalog,
  lastResolved?: ResolvedExecutionConfig
): ConfigResolution {
  const provider = findProviderCatalogEntry(catalog, config.provider);
  if (!provider) {
    return unavailable(
      catalog.revision,
      {
        code: 'provider_unavailable',
        message: `Provider is unavailable: ${config.provider}`,
        provider: config.provider,
      },
      lastResolved
    );
  }

  const modelId = config.model.mode === 'default' ? provider.defaultModelId : config.model.modelId;
  const model = findModelDefinition(provider, modelId);
  if (!model) {
    return unavailable(
      catalog.revision,
      {
        code: 'model_unavailable',
        message: `Model is unavailable for ${config.provider}: ${modelId}`,
        provider: config.provider,
        modelId,
        validValues: provider.models.map((candidate) => candidate.id),
      },
      lastResolved
    );
  }

  let reasoningEffort: string | undefined;
  if (config.reasoning.mode === 'explicit') {
    if (!model.reasoning) {
      return unavailable(
        catalog.revision,
        {
          code: 'reasoning_unsupported',
          message: `Reasoning is not supported by ${config.provider}/${modelId}`,
          provider: config.provider,
          modelId,
        },
        lastResolved
      );
    }
    if (!model.reasoning.levels.includes(config.reasoning.effort)) {
      return unavailable(
        catalog.revision,
        {
          code: 'reasoning_unavailable',
          message: `Reasoning effort is unavailable for ${config.provider}/${modelId}: ${config.reasoning.effort}`,
          provider: config.provider,
          modelId,
          validValues: model.reasoning.levels,
        },
        lastResolved
      );
    }
    reasoningEffort = config.reasoning.effort;
  } else if (config.reasoning.mode === 'default') {
    reasoningEffort = model.reasoning?.defaultEffort;
  }

  return {
    status: 'resolved',
    catalogRevision: catalog.revision,
    value: {
      provider: config.provider,
      modelId,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    },
  };
}
