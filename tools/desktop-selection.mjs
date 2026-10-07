import fs from 'node:fs';
import path from 'node:path';

// Pattern: one-write-path (docs/patterns.md#one-write-path)
// Fix-guard: builds used to exist only inside a read-only .app with no checkout.
// Publish only after an isolated-store smoke; desktop-source.test.mjs guards failed builds.
export function selectedRuntime(home, bundle) {
  const manifest = path.join(home, 'active-runtime.json');
  if (!fs.existsSync(manifest)) return { runtime: bundle, source: null };
  const active = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const runtimes = path.join(home, 'runtimes') + path.sep;
  if (
    typeof active.runtime !== 'string' ||
    !path.resolve(active.runtime).startsWith(runtimes) ||
    active.source !== path.join(home, 'source') ||
    typeof active.revision !== 'string' ||
    !fs.existsSync(path.join(active.runtime, 'server', 'dist', 'server.js'))
  ) {
    throw new Error('Invalid managed runtime manifest; see source-update.log');
  }
  // Installing a new native release must not be hidden by an older managed runtime.
  // Keep its editable checkout for the usual owner-requested upstream merge.
  const bundledMetadata = path.join(bundle, 'source.json');
  if (
    fs.existsSync(bundledMetadata) &&
    active.bundleRevision !== JSON.parse(fs.readFileSync(bundledMetadata, 'utf8')).revision
  ) {
    return { runtime: bundle, source: active.source };
  }
  return active;
}
