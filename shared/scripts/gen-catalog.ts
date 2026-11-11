/**
 * Generate shared/src/generated/catalog.ts from vendor/agent-cli-tool/catalog.jsonc,
 * the only model registry data. Parses it with the shared schemas, so a malformed
 * catalog fails here instead of in a running server.
 *
 * Run: pnpm --filter @unleashd/shared gen:catalog
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  CatalogProviderSchema,
  ProviderCatalogSchema,
  ProviderSchema,
} from '../src/provider-catalog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const CATALOG_PATH = join(REPO_ROOT, 'vendor/agent-cli-tool/catalog.jsonc');
const OUT_FILE = join(REPO_ROOT, 'shared/src/generated/catalog.ts');

const CatalogFileSchema = z.object({
  revision: z.string().min(1),
  providers: z.array(CatalogProviderSchema),
});

// Minimal JSONC stripper: the catalog has no // inside strings.
function stripJsonc(text: string): string {
  return text.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

async function main() {
  const catalog = CatalogFileSchema.parse(
    JSON.parse(stripJsonc(await readFile(CATALOG_PATH, 'utf-8')))
  );

  // Relational invariants (duplicates, default model, default effort) are the wire schema's.
  ProviderCatalogSchema.parse(catalog);

  // Every Provider exactly once, so catalogEntryForProvider is a total lookup.
  const ids = catalog.providers.map((provider) => provider.id).sort();
  const expected = [...ProviderSchema.options].sort();
  if (JSON.stringify(ids) !== JSON.stringify(expected)) {
    throw new Error(`Catalog providers [${ids}] must be exactly [${expected}]`);
  }

  for (const provider of catalog.providers) {
    for (const [alias, target] of Object.entries(provider.aliases)) {
      if (!provider.models.some((model) => model.id === target)) {
        throw new Error(`${provider.id} alias ${alias} → ${target}: target is not a model`);
      }
    }
  }

  const out = [
    '// DO NOT EDIT - generated from catalog.jsonc',
    `// Source: vendor/agent-cli-tool/catalog.jsonc (revision ${catalog.revision})`,
    '// Generator: shared/scripts/gen-catalog.ts',
    '// Run: pnpm --filter @unleashd/shared gen:catalog',
    '',
    "import type { CatalogProvider } from '../provider-catalog.js';",
    '',
    `export const PROVIDER_MODEL_CATALOG: readonly CatalogProvider[] = ${JSON.stringify(catalog.providers, null, 2)};`,
    '',
  ].join('\n');
  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, out, 'utf-8');
  await promisify(execFile)(process.execPath, [
    join(REPO_ROOT, 'vendor/agent-cli-tool/scripts/gen-model-catalog.mjs'),
  ]);
  console.log(`Wrote ${OUT_FILE} and agent-cli's parser catalog`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
