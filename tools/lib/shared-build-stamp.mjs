// Pattern: fix-guards (docs/patterns.md#fix-guards)
// The stamp `shared/scripts/build.mjs` leaves in `shared/dist`: which inputs produced the dist,
// and the size and mtime of every file it published. `pnpm typecheck` skips the shared build
// when the stamp still describes the dist and the inputs; the build took ~700 ms of every
// typecheck's ~1.4 s (2026-11-11) although shared rarely changes. The projects check against
// `shared/dist`, so a stale dist makes a typecheck pass or fail wrongly: anything that can
// change the emitted JS or .d.ts is an input. Guard: tools/typecheck.test.mjs ("a changed shared
// source is rebuilt before the projects check").
import { createHash } from 'node:crypto';
import {
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const STAMP = '.build-stamp.json';

function filesUnder(directory, prefix = '') {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path.join(directory, entry.name), relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files.sort();
}

/**
 * What a dependency contributes to the build: its installed location and manifest (the version),
 * and for a workspace package (outside any node_modules) its declared types file, which shared
 * imports types from (`@unleashd/buddies-core`, `@unleashd/ingest`: generated `index.d.ts`).
 */
function dependencyIdentity(sharedRoot, name) {
  let directory;
  try {
    directory = realpathSync(path.join(sharedRoot, 'node_modules', name));
  } catch (error) {
    if (error.code === 'ENOENT') return 'not installed';
    throw error;
  }
  const manifest = readFileSync(path.join(directory, 'package.json'), 'utf8');
  if (directory.split(path.sep).includes('node_modules')) return `${directory}\0${manifest}`;
  const types = JSON.parse(manifest).types;
  const declared = types ? readFileSync(path.join(directory, types), 'utf8') : 'no types';
  return `${directory}\0${manifest}\0${declared}`;
}

/** A digest of everything that determines `shared/dist`: sources, configs, script, compiler, deps. */
export function sharedBuildInputs(sharedRoot) {
  const hash = createHash('sha256');
  const add = (label, bytes) => hash.update(`${label}\0${bytes.length}\0`).update(bytes);
  for (const file of ['package.json', 'tsconfig.json', 'tsconfig.cjs.json', 'scripts/build.mjs']) {
    add(file, readFileSync(path.join(sharedRoot, file)));
  }
  for (const file of filesUnder(path.join(sharedRoot, 'src'))) {
    add(path.join('src', file), readFileSync(path.join(sharedRoot, 'src', file)));
  }
  const manifest = JSON.parse(readFileSync(path.join(sharedRoot, 'package.json'), 'utf8'));
  const names = new Set([
    'typescript',
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
  for (const name of [...names].sort()) {
    add(`dependency ${name}`, Buffer.from(dependencyIdentity(sharedRoot, name)));
  }
  return hash.digest('hex');
}

const statOf = (file) => {
  const stats = statSync(file, { throwIfNoEntry: false });
  return stats ? `${stats.size}:${stats.mtimeMs}` : 'missing';
};

/** Record that `inputs` (digested before compiling) produced the dist as it is now. */
export function writeBuildStamp(sharedRoot, inputs) {
  const dist = path.join(sharedRoot, 'dist');
  const outputs = {};
  for (const file of filesUnder(dist)) {
    if (file !== STAMP) outputs[file] = statOf(path.join(dist, file));
  }
  const temporary = path.join(dist, `${STAMP}.${process.pid}.tmp`);
  writeFileSync(temporary, JSON.stringify({ inputs, outputs }));
  renameSync(temporary, path.join(dist, STAMP));
}

/**
 * BuildState = Current ⊕ Stale(reason). Current only when the stamp's inputs equal today's and
 * every file it recorded is still there, unchanged (a dev `tsc --watch` publish or a deleted
 * file makes it stale).
 */
export function sharedBuildState(sharedRoot) {
  const dist = path.join(sharedRoot, 'dist');
  let stamp;
  try {
    stamp = JSON.parse(readFileSync(path.join(dist, STAMP), 'utf8'));
  } catch {
    return { kind: 'stale', reason: 'no build stamp' };
  }
  if (stamp.inputs !== sharedBuildInputs(sharedRoot)) {
    return { kind: 'stale', reason: 'inputs changed' };
  }
  for (const [file, recorded] of Object.entries(stamp.outputs)) {
    if (statOf(path.join(dist, file)) !== recorded) {
      return { kind: 'stale', reason: `dist/${file} changed` };
    }
  }
  return { kind: 'current' };
}
