import {
  type ConversationConfig,
  type ModelId,
  createDefaultConversationConfig,
} from './conversation-config.js';
import type { InstalledAgent } from './dependencies.js';
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

/** What a Buddy's turn runs on when nothing else chose: a harness, or nothing installed. */
export type BuddyExecution =
  | {
      kind: 'run';
      provider: Provider;
      model: ModelId | undefined;
      reasoningEffort: string | undefined;
    }
  | { kind: 'no-agent' };

/**
 * A Buddy profile row's execution preferences. An explicit provider, or a model that names
 * exactly one harness, is the owner's choice and wins unconditionally. Otherwise the Buddy runs
 * on the install's agent (`installed`), or on nothing. Turn creation, the reply gate and the
 * channel member list all read it here, so the @mention chip matches execution.
 */
export function buddyExecutionPreferences(
  buddy: {
    provider: string | null;
    model: string | null;
    reasoning_effort: string | null;
  },
  installed: InstalledAgent
): BuddyExecution {
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
  const chosen = buddy.provider || (matches.length === 1 ? matches[0] : null);
  // The unset provider used to fall back to a literal 'codex': a fresh install with only Claude
  // ran `spawn codex ENOENT` on its first DM while the picker said Claude (fresh-install trial,
  // 2026-10-05). It now follows what is installed, read at resolution time, never stored on the
  // Buddy, because the first-boot install is async and a stored pick would be indistinguishable
  // from an owner's. Design: agent_notes/2026-10-05_installed-provider-default-design.md.
  // Guard: buddies-v2 "an unpinned Buddy runs the installed agent; a pinned one never moves".
  const provider = chosen ?? (installed.kind === 'agent' ? installed.provider : null);
  if (provider === null) return { kind: 'no-agent' };
  return {
    kind: 'run',
    provider: provider as Provider,
    model: buddy.model || undefined,
    reasoningEffort: buddy.reasoning_effort || undefined,
  };
}

/** The error a Buddy conversation open reports when its profile resolved to `no-agent`. */
export const NO_AGENT_INSTALLED =
  'No agent is installed. Install Claude Code or Codex from Setup, then try again.';
