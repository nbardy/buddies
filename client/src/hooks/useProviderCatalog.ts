import type { ProviderCatalog } from '@unleashd/shared';
import { ProviderCatalogSchema } from '@unleashd/shared';
import { resource, usePolledFetch } from './usePolledFetch';

export interface ProviderCatalogState {
  catalog: ProviderCatalog | null;
  isLoading: boolean;
  /** The catalog never loaded. A failed re-read keeps `catalog` and is not an error here. */
  error: Error | null;
  retry: () => void;
}

/**
 * One module-level resource: every picker shares the key, so the catalog is
 * requested once per session and re-read from cache by each surface.
 *
 * This used to be a hand-rolled useSyncExternalStore cache with its own
 * in-flight dedupe and abort — exactly what atoms/resources.ts now provides
 * for everything, so it collapsed onto that.
 */
const PROVIDER_CATALOG = resource<ProviderCatalog>('/api/provider-catalog', async (signal) => {
  const response = await fetch('/api/provider-catalog', { signal });
  if (!response.ok) throw new Error(`Failed to load provider catalog (HTTP ${response.status})`);
  return ProviderCatalogSchema.parse(await response.json());
});

/** Shared catalog resource for every configuration surface. */
export function useProviderCatalog(): ProviderCatalogState {
  // Open tabs used to keep the pre-reload catalog indefinitely. Revalidate
  // behind the shared cache so model releases appear without a page reload.
  const catalog = usePolledFetch<ProviderCatalog>(PROVIDER_CATALOG, 30_000);
  return {
    catalog: catalog.data,
    isLoading: catalog.kind === 'loading',
    error: catalog.kind === 'failed' ? catalog.error : null,
    retry: catalog.refetch,
  };
}
