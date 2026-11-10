import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * The `tsc` launcher of the TypeScript package that `configPath`'s package resolves, through
 * the manifest's `bin` field. TypeScript 7's `exports` map has no `bin/tsc` (or `lib/tsc.js`)
 * subpath, so resolving one throws ERR_PACKAGE_PATH_NOT_EXPORTED; the launcher execs the
 * native compiler. Run it as `node <launcher> ...args`.
 */
export function tscLauncher(configPath) {
  const manifest = createRequire(configPath).resolve('typescript/package.json');
  return path.join(path.dirname(manifest), JSON.parse(readFileSync(manifest, 'utf8')).bin.tsc);
}
