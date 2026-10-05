import { DependenciesSchema } from '@unleashd/shared';
import { resource } from './usePolledFetch';

// One keyed resource for GET /api/dependencies: the Setup dialog polls it while open, and the
// channel picker reads its `agent` (what an unpinned Buddy runs) from the same cache entry.
export const DEPENDENCIES_STATUS = resource('/api/dependencies', async (signal) => {
  const response = await fetch('/api/dependencies', { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return DependenciesSchema.parse(await response.json());
});
