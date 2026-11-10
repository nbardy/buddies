/**
 * Generate TypeScript types from oompa_loompas JSON Schema files.
 *
 * Reads all *.schema.json from the sibling oompa_loompas/schemas/ directory,
 * compiles them with json-schema-to-typescript, and writes a single output file
 * at shared/src/generated/oompa-types.ts.
 *
 * Usage:
 *   npx tsx tools/gen-oompa-types.ts
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'json-schema-to-typescript';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SCHEMAS_DIR = resolve(REPO_ROOT, '..', 'oompa_loompas', 'schemas');
const OUT_FILE = join(REPO_ROOT, 'shared', 'src', 'generated', 'oompa-types.ts');

const BANNER = `/**
 * AUTO-GENERATED — do not edit by hand.
 *
 * Source: oompa_loompas/schemas/*.schema.json
 * Generator: npx tsx tools/gen-oompa-types.ts
 *
 * These are the RAW JSON file shapes written by oompa_loompas runs.clj.
 * For the DERIVED view types the server constructs, see OompaRuntime* in index.ts.
 */

`;

async function main() {
  const entries = await readdir(SCHEMAS_DIR);
  const schemaFiles = entries.filter((f) => f.endsWith('.schema.json')).sort();

  if (schemaFiles.length === 0) {
    console.error(`No *.schema.json files found in ${SCHEMAS_DIR}`);
    process.exit(1);
  }

  const chunks: string[] = [BANNER];

  for (const file of schemaFiles) {
    const raw = await readFile(join(SCHEMAS_DIR, file), 'utf-8');
    const schema = JSON.parse(raw);
    const ts = await compile(schema, schema.title ?? basename(file, '.schema.json'), {
      bannerComment: '',
      additionalProperties: false,
      style: { semi: true, singleQuote: true },
    });
    chunks.push(ts.trim(), '\n\n');
  }

  await mkdir(join(REPO_ROOT, 'shared', 'src', 'generated'), { recursive: true });
  await writeFile(OUT_FILE, chunks.join(''));
  console.log(`Wrote ${schemaFiles.length} type(s) to ${OUT_FILE}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
