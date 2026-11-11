import crypto from 'node:crypto';
import { harnessMcpCapability } from '@nbardy/agent-cli';
import type {
  ConfigResolution,
  ConversationConfig,
  Provider,
  ProviderCatalog,
  ProviderCatalogEntry,
} from '@unleashd/shared';
import {
  ProviderCatalogSchema,
  ProviderSchema,
  catalogEntryForProvider,
  isModelIdValidForProvider,
  normalizeModelId,
  resolveConversationConfig,
} from '@unleashd/shared';

function catalogRevision(entries: readonly ProviderCatalogEntry[]): string {
  return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 16);
}

// The catalog data is served as written: app choices such as the Codex default
// model and medium effort live in catalog.jsonc, never as overrides here.
function buildProviderEntry(provider: Provider): ProviderCatalogEntry {
  const { aliases: _aliases, ...entry } = catalogEntryForProvider(provider);
  return { ...entry, supportsRequiredMcp: harnessMcpCapability(provider) === 'required' };
}

function buildProviderCatalog(): ProviderCatalog {
  const entries = ProviderSchema.options.map(buildProviderEntry);
  return ProviderCatalogSchema.parse({
    revision: catalogRevision(entries),
    providers: entries,
  });
}

let cachedCatalog: ProviderCatalog | undefined;

/**
 * Returns the current provider capabilities snapshot. Provider discovery is
 * centralized here so config resolution and API consumers always observe the
 * same revision.
 */
export function createProviderCatalog(): ProviderCatalog {
  cachedCatalog ??= buildProviderCatalog();
  return cachedCatalog;
}

/**
 * Dynamic providers keep opaque IDs off the closed dropdown catalog. For
 * validation/resolution, add a request-local model definition after the
 * provider adapter accepts the ID. The shared resolver stays pure.
 */
function catalogForConfig(catalog: ProviderCatalog, config: ConversationConfig): ProviderCatalog {
  if (config.model.mode !== 'explicit') return catalog;
  const modelId = config.model.modelId;
  const entry = catalog.providers.find((provider) => provider.id === config.provider);
  if (!entry?.supportsDynamicModels) return catalog;
  if (entry.models.some((model) => model.id === modelId)) return catalog;
  if (!isModelIdValidForProvider(config.provider, modelId)) return catalog;

  return {
    ...catalog,
    providers: catalog.providers.map((provider) =>
      provider.id === config.provider
        ? {
            ...provider,
            models: [
              ...provider.models,
              {
                id: modelId,
                displayName: modelId,
              },
            ],
          }
        : provider
    ),
  };
}

export function resolveConfigAgainstProviderCatalog(
  config: ConversationConfig,
  lastResolved?: Extract<ConfigResolution, { status: 'resolved' }>['value']
): ConfigResolution {
  // Saved family selections must stay executable after their catalog id becomes an alias.
  // Normalize only the execution snapshot; preserve the owner's stored selection intent.
  const canonical =
    config.model.mode === 'explicit'
      ? {
          ...config,
          model: {
            mode: 'explicit' as const,
            modelId:
              normalizeModelId(config.provider, config.model.modelId) ?? config.model.modelId,
          },
        }
      : config;
  const catalog = createProviderCatalog();
  return resolveConversationConfig(canonical, catalogForConfig(catalog, canonical), lastResolved);
}
