import { harnessMcpCapability } from '@nbardy/agent-cli';
import type { RunConfig } from '@unleashd/buddies-core';
import { type ConversationConfig, ProviderSchema } from '@unleashd/shared';
import { configFromProviderPreferences } from '@unleashd/shared';
import { z } from 'zod';
import { resolveConfigAgainstProviderCatalog } from '../providers/catalog-service';

// A worker is a Buddy run on a model the spawner chose (a `post` request carrying `worker`), not
// the Buddy's saved profile. Until 2026-09-28 no tool could choose one, so a Buddy launched four
// untracked `codex exec` processes from a thread (agent_notes/2026-09-28_buddy-worker-spawn-gap.md).

export const WorkerSchema = z
  .object({
    provider: z.string().min(1).describe('Harness id, e.g. codex'),
    model: z.string().min(1).optional().describe("Catalog model id; absent: the harness's default"),
    reasoningEffort: z.string().min(1).optional().describe('Absent: default'),
  })
  .strict();

/** A worker run's conversation config: exactly its RunConfig, never its Buddy's profile. */
export function workerConversationConfig(config: RunConfig): ConversationConfig {
  return configFromProviderPreferences({
    provider: ProviderSchema.parse(config.provider),
    model: config.model ?? undefined,
    reasoningEffort: config.reasoningEffort,
  });
}

/**
 * The owner's mention-chip pick as a run's config, so it rides the `deliver` run the mention
 * writes. An unnamed model or effort stays absent: the provider's default, resolved at claim
 * (decision J). A pick that disables reasoning becomes the default effort.
 */
export function runConfigOfPick(pick: ConversationConfig): RunConfig {
  return {
    provider: pick.provider,
    model: pick.model.mode === 'explicit' ? pick.model.modelId : undefined,
    reasoningEffort: pick.reasoning.mode === 'explicit' ? pick.reasoning.effort : undefined,
  };
}

/**
 * Decision J (2026-10-06): the model a run that names only its provider runs on, the catalog's
 * default for it right now. The runner records it on the run at claim (crate `record_run_model`),
 * so a later catalog change never rewrites which model a run used. Before J, `RunConfig.model`
 * was required: a "default" chip pick could not ride a run (durable-pending Rev 10, Finding 1),
 * and worker model ids drifted with nothing on the run saying which ran (Wave Sim, 2026-09-29).
 */
export function providerDefaultModel(provider: string): string {
  const resolution = resolveConfigAgainstProviderCatalog(
    workerConversationConfig({ provider, model: undefined })
  );
  if (resolution.status !== 'resolved')
    throw new Error(`worker provider "${provider}": ${resolution.error.message}`);
  return resolution.value.modelId;
}

/**
 * κ at the tool boundary: a provider whose harness guarantees the Buddy tools, and a model and
 * effort its catalog offers. An unknown value is an error naming the valid ones; nothing falls
 * back to the profile, so a worker never silently runs on a model nobody chose.
 */
export function checkedRunConfig(input: z.infer<typeof WorkerSchema>): RunConfig {
  const provider = ProviderSchema.safeParse(input.provider);
  if (!provider.success)
    throw new Error(
      `worker provider "${input.provider}" is unknown; one of ${ProviderSchema.options.join(', ')}`
    );
  if (harnessMcpCapability(provider.data) !== 'required')
    throw new Error(`worker provider "${input.provider}" cannot guarantee the Buddy tools`);
  const resolution = resolveConfigAgainstProviderCatalog(workerConversationConfig(input));
  if (resolution.status !== 'resolved') {
    const valid = resolution.error.validValues?.join(', ');
    throw new Error(
      `worker config: ${resolution.error.message}${valid ? ` (valid: ${valid})` : ''}`
    );
  }
  return input;
}
