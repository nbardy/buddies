import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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

/**
 * The native `tsc` binary that launcher would exec, found by the package's own
 * `lib/getExePath.js` (imported by path: it is not exported), with the package version.
 * Spawning it directly skips a Node startup per check (~40 ms, more on a loaded machine).
 * Throws when the platform package is missing; callers report that, never swallow it.
 */
export async function tscExecutable(configPath) {
  const manifest = createRequire(configPath).resolve('typescript/package.json');
  return nativeOf(manifest);
}

/** `{ exe, version }` for a TypeScript-shaped package (tsc, tsrs) from its manifest path. */
export async function nativeOf(manifest) {
  const getExePath = path.join(path.dirname(manifest), 'lib', 'getExePath.js');
  const { default: resolve } = await import(pathToFileURL(getExePath).href);
  return { exe: resolve(), version: JSON.parse(readFileSync(manifest, 'utf8')).version };
}
