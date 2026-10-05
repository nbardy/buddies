import { z } from 'zod';
import { ProviderSchema } from './provider-catalog.js';

// Pattern: one-type-source (docs/patterns.md#one-type-source)
export const DependencyCheckSchema = z.object({
  id: z.enum(['rust', 'claude', 'codex']),
  status: z.enum(['checking', 'installing', 'ready', 'missing', 'failed']),
  message: z.string(),
  failure: z.enum(['login', 'quota', 'network', 'other']).optional(),
});
// The agent an unpinned Buddy runs on this install (server/src/providers/installed-agent.ts).
// Resolved from PATH on every read, never stored: the first-boot install is async, so any
// stored pick could predate it. The wire default is what a backend without this field does
// (Codex), so a client ahead of its backend still shows the model that will run.
export const InstalledAgentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent'), provider: ProviderSchema }),
  z.object({ kind: z.literal('none') }),
]);
export const DependenciesSchema = z.object({
  checks: z.array(DependencyCheckSchema),
  agent: InstalledAgentSchema.default({ kind: 'agent', provider: 'codex' }),
});
export type DependencyCheck = z.infer<typeof DependencyCheckSchema>;
export type Dependencies = z.infer<typeof DependenciesSchema>;
export type InstalledAgent = z.infer<typeof InstalledAgentSchema>;
