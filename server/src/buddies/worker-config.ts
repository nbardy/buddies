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
    provider: z.string().min(1).describe('A harness id, e.g. codex or claude'),
    model: z.string().min(1).describe("A model id the provider's catalog offers"),
    reasoningEffort: z.string().min(1).optional().describe("Absent: the model's default"),
  })
  .strict();

/** A worker run's conversation config: exactly its RunConfig, never its Buddy's profile. */
export function workerConversationConfig(config: RunConfig): ConversationConfig {
  return configFromProviderPreferences({
    provider: ProviderSchema.parse(config.provider),
    model: config.model,
    reasoningEffort: config.reasoningEffort,
  });
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
