import { z } from 'zod';

// Pattern: one-type-source (docs/patterns.md#one-type-source)
export const DependencyCheckSchema = z.object({
  id: z.enum(['rust', 'claude', 'codex']),
  status: z.enum(['checking', 'ready', 'missing', 'failed']),
  message: z.string(),
});
export const DependenciesSchema = z.object({
  checks: z.array(DependencyCheckSchema),
});
export type DependencyCheck = z.infer<typeof DependencyCheckSchema>;
export type Dependencies = z.infer<typeof DependenciesSchema>;
