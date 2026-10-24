// The production client bundle (client/dist) that the backend serves to phones, kept OFF the
// dev boot critical path.
//
// Until 2026-10-23 `pnpm dev` ran an in-process vite `build()` before starting the backend:
// 38.6 s serial on every boot, and `build()` sets process.env.NODE_ENV='production' in the
// supervisor, so the dev server started afterwards ran with isProduction=true (React fast
// refresh off, "Re-optimizing dependencies because vite config has changed" on every boot).
// Now: (1) skip when a content hash of every build input matches the stamp, (2) otherwise build
// in a CHILD process (NODE_ENV cannot leak), concurrently with the backend and Vite, into a
// staging directory that atomically replaces dist, so the old bundle keeps serving until the new
// one is complete. Guard: tools/client-build.test.mjs.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// Bump when the way the bundle is produced changes without any input file changing.
const RECIPE = 'client-build/1';
// Everything the bundle depends on. The shared package is aliased to its SOURCE in
// client/vite.config.ts, so shared/src (not shared/dist) is the input. Server files imported by
// vite.config.ts serve the dev server only and are not in the bundle.
const INPUTS = [
  'client/src',
  'client/public',
  'client/index.html',
  'client/vite.config.ts',
  'client/package.json',
  'shared/src',
  'shared/package.json',
  'pnpm-lock.yaml',
];
const INPUT_PATTERNS = [/^client\/tsconfig[^/]*\.json$/];
const SKIPPED = new Set(['node_modules', 'dist', '.DS_Store']);

/** Is `relative` (repo-relative, '/'-separated) a file the bundle is built from? Same definition as the hash. */
export function isClientInput(relative) {
  if (relative.split('/').some((segment) => SKIPPED.has(segment))) return false;
  return (
    INPUTS.some((input) => relative === input || relative.startsWith(`${input}/`)) ||
    INPUT_PATTERNS.some((pattern) => pattern.test(relative))
  );
}

function* walk(root, relative) {
  const absolute = path.join(root, relative);
  let entries;
  try {
    entries = readdirSync(absolute, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOTDIR') {
      yield relative;
      return;
    }
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (SKIPPED.has(entry.name)) continue;
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) yield* walk(root, child);
    else yield child;
  }
}

/** Content hash of every file the client bundle is built from. */
export function clientInputHash(repositoryRoot) {
  const hash = createHash('sha256').update(RECIPE);
  const files = [];
  for (const input of INPUTS) files.push(...walk(repositoryRoot, input));
  for (const entry of readdirSync(path.join(repositoryRoot, 'client'), { withFileTypes: true })) {
    const relative = `client/${entry.name}`;
    if (INPUT_PATTERNS.some((pattern) => pattern.test(relative))) files.push(relative);
  }
  for (const relative of files) {
    hash.update(`\0${relative}\0`).update(readFileSync(path.join(repositoryRoot, relative)));
  }
  return hash.digest('hex');
}

/** Freshness = Fresh ⊕ Stale(reason). Fresh needs a stamp matching the inputs AND a dist that exists. */
export function clientFreshness({ repositoryRoot, distDirectory, stampFile }) {
  const hash = clientInputHash(repositoryRoot);
  if (!existsSync(path.join(distDirectory, 'index.html')))
    return { kind: 'stale', hash, reason: 'no dist' };
  let stamped;
  try {
    stamped = JSON.parse(readFileSync(stampFile, 'utf8')).hash;
  } catch {
    return { kind: 'stale', hash, reason: 'no stamp' };
  }
  return stamped === hash
    ? { kind: 'fresh', hash }
    : { kind: 'stale', hash, reason: 'inputs changed' };
}

/** The real build: vite's own CLI, in its own process, in production mode, into `outDirectory`. */
export function viteBuildCommand(clientRoot, outDirectory) {
  const manifest = createRequire(path.join(clientRoot, 'package.json')).resolve(
    'vite/package.json'
  );
  return {
    command: process.execPath,
    args: [
      path.join(path.dirname(manifest), 'bin', 'vite.js'),
      'build',
      '--outDir',
      outDirectory,
      '--emptyOutDir',
    ],
    cwd: clientRoot,
    env: { NODE_ENV: 'production' },
  };
}

function runChild({ command, args, cwd, env }, onLine, signal) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      signal,
    });
    for (const stream of [child.stdout, child.stderr]) {
      let partial = '';
      stream.setEncoding('utf8').on('data', (chunk) => {
        const lines = (partial + chunk).split('\n');
        partial = lines.pop();
        for (const line of lines) onLine(line);
      });
    }
    child.once('error', (error) => resolve({ ok: false, message: error.message, child }));
    child.once('exit', (code, signal) =>
      resolve(
        code === 0 ? { ok: true, child } : { ok: false, message: `exit ${code ?? signal}`, child }
      )
    );
  });
}

/**
 * Outcome = Skipped ⊕ Built(ms) ⊕ Failed(message). Failure keeps the previous dist and leaves
 * the stamp alone, so the next boot retries.
 *
 * The stamp records the hash taken BEFORE the build: an edit made while it ran leaves the
 * stamp stale, and the next boot rebuilds.
 */
export async function ensureClientBuild({
  repositoryRoot,
  cacheDirectory,
  log = () => {},
  signal,
  buildCommand = viteBuildCommand,
  now = Date.now,
}) {
  const clientRoot = path.join(repositoryRoot, 'client');
  const distDirectory = path.join(clientRoot, 'dist');
  const stampFile = path.join(cacheDirectory, 'client-dist.stamp.json');
  const staging = path.join(cacheDirectory, 'client-dist-building');
  const freshness = clientFreshness({ repositoryRoot, distDirectory, stampFile });
  if (freshness.kind === 'fresh') return { kind: 'skipped' };
  log(`building client/dist (${freshness.reason}); the backend does not wait for it`);
  const startedAt = now();
  mkdirSync(cacheDirectory, { recursive: true });
  rmSync(staging, { recursive: true, force: true });
  const result = await runChild(buildCommand(clientRoot, staging), (line) => log(line), signal);
  if (!result.ok) {
    rmSync(staging, { recursive: true, force: true });
    return { kind: 'failed', message: result.message };
  }
  const previous = `${distDirectory}.previous`;
  rmSync(previous, { recursive: true, force: true });
  if (existsSync(distDirectory)) renameSync(distDirectory, previous);
  renameSync(staging, distDirectory);
  rmSync(previous, { recursive: true, force: true });
  writeFileSync(stampFile, JSON.stringify({ hash: freshness.hash }));
  return { kind: 'built', ms: now() - startedAt };
}

/**
 * Keep client/dist current while the dev runtime is up (phones are served the production
 * bundle, which used to refresh only at boot). Pattern: one build at a time, trailing edge.
 *
 * - fs.watch on the hash's own inputs (isClientInput), so a build's writes to dist/ and the
 *   cache never retrigger it. Events only mark "dirty"; ensureClientBuild's content hash decides
 *   whether anything really changed, so a touch with identical bytes is a silent no-op.
 * - Debounce: a build starts `debounceMs` after the LAST event.
 * - Coalescing: events during a build set `dirty`; when it ends, exactly one more debounced
 *   build runs, however many edits arrived.
 * - The build is the existing child + staging + atomic swap path, run under `nice` because the
 *   machine is often oversubscribed. Nothing here touches the parent's NODE_ENV.
 * `onOutcome(outcome, ms)` fires for builds that ran (Built or Failed), not for Skipped.
 */
export function watchClientBuild({
  repositoryRoot,
  cacheDirectory,
  log = () => {},
  signal,
  buildCommand = viteBuildCommand,
  debounceMs = 3000,
  niceness = 10,
  onOutcome = () => {},
  now = Date.now,
}) {
  let timer = null;
  let building = false;
  let dirty = false;
  let closed = false;
  const niced = (clientRoot, out) => {
    const spec = buildCommand(clientRoot, out);
    return {
      ...spec,
      command: 'nice',
      args: ['-n', String(niceness), spec.command, ...spec.args],
    };
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(run, debounceMs);
  };
  async function run() {
    if (closed) return;
    building = true;
    dirty = false;
    const startedAt = now();
    const outcome = await ensureClientBuild({
      repositoryRoot,
      cacheDirectory,
      log,
      signal,
      buildCommand: niced,
      now,
    }).catch((error) => ({ kind: 'failed', message: error.message }));
    building = false;
    if (outcome.kind !== 'skipped') onOutcome(outcome, now() - startedAt);
    if (dirty && !closed) schedule();
  }
  const onEvent = (base) => (_type, filename) => {
    if (closed || !filename) return;
    if (!isClientInput(path.posix.join(base, filename.split(path.sep).join('/')))) return;
    dirty = true;
    if (!building) schedule();
  };
  const watchers = [];
  const add = (relative, recursive) => {
    try {
      watchers.push(watch(path.join(repositoryRoot, relative), { recursive }, onEvent(relative)));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  };
  const flatDirectories = new Set(['client']); // client/tsconfig*.json (INPUT_PATTERNS)
  for (const input of INPUTS) {
    let kind = 'missing';
    try {
      kind = statSync(path.join(repositoryRoot, input)).isDirectory() ? 'directory' : 'file';
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (kind === 'directory') add(input, true);
    else if (kind === 'file') flatDirectories.add(path.posix.dirname(input));
  }
  for (const directory of flatDirectories) add(directory, false);
  return {
    close() {
      closed = true;
      clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
    },
  };
}
