import {
  type ConversationConfig,
  type ModelId,
  createDefaultConversationConfig,
} from './conversation-config.js';
import { catalogEntryForProvider, normalizeModelId } from './model-catalog.js';
import { type Provider, ProviderSchema } from './provider-catalog.js';

// Pattern: one-definition (docs/patterns.md#one-definition)
// Composer profile fallback and server execution must infer the same provider/model.
// Guard: model-only Buddy profile opens its DM on the model's harness.
export function configFromProviderPreferences(input: {
  provider: Provider;
  model?: ModelId;
  reasoningEffort?: string | null;
}): ConversationConfig {
  const normalizedModel = normalizeModelId(input.provider, input.model);
  return {
    ...createDefaultConversationConfig(input.provider),
    model:
      normalizedModel === undefined
        ? { mode: 'default' }
        : { mode: 'explicit', modelId: normalizedModel },
    reasoning:
      input.reasoningEffort === null
        ? { mode: 'disabled' }
        : input.reasoningEffort !== undefined
          ? { mode: 'explicit', effort: input.reasoningEffort }
          : { mode: 'default' },
  };
}

/**
 * A Buddy profile row's execution preferences. A blank provider follows an
 * unambiguous catalog model, otherwise the Buddies default (Codex). Turn creation
 * and the channel member list both read it here, so the @mention chip matches execution.
 */
export function buddyExecutionPreferences(buddy: {
  provider: string | null;
  model: string | null;
  reasoning_effort: string | null;
}): { provider: Provider; model: ModelId | undefined; reasoningEffort: string | undefined } {
  // Model-only Builder hires used to pair Claude Opus with the Codex default and fail DM open.
  // Resolve absent harnesses from the canonical catalog; explicit selections stay authoritative.
  // Guard: buddies-v2 "a model-only Buddy profile opens its DM on the model's harness".
  const matches =
    buddy.provider || !buddy.model
      ? []
      : ProviderSchema.options.filter((provider) => {
          const entry = catalogEntryForProvider(provider);
          const model = normalizeModelId(provider, buddy.model!);
          return entry.models.some((candidate) => candidate.id === model);
        });
  return {
    provider: (buddy.provider || (matches.length === 1 ? matches[0] : 'codex')) as Provider,
    model: buddy.model || undefined,
    reasoningEffort: buddy.reasoning_effort || undefined,
  };
}
