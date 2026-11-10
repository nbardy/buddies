// The dev runtime's long-lived tools, hosted in ONE process.
//
// Until 2026-09-25 `pnpm dev` ran them through concurrently plus a `pnpm
// --filter …` wrapper per tool: 18 processes, ~7 of which only launched
// another. Here the supervisor process itself runs
//   - the Vite dev server,
//   - the backend runner (tools/watch-server.mjs),
// through their JavaScript APIs, plus one native `tsc --watch` child per
// TypeScript project (shared ESM, shared CJS, agent-cli-tool): TypeScript 7 has
// no in-process compiler API. The backend stays a child process: it is the
// unit that restarts, and it owns the provider pipes of running agent turns.
//
// Order matters: the backend and Vite start only after every compiler's first
// pass. A watcher that starts beside the backend rewrites dist/ while the
// backend loads it, which is what restarted a backend mid-startup on
// 2026-09-25 (see tools/watch-server.mjs).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureAddonBuild } from './ensure-addons.mjs';
import { tscLauncher } from './lib/tsc.mjs';
import { createBackendRunner, esbuildCheck } from './watch-server.mjs';

/** Prefix every line of a chunk, for tools that print through one stdout. */
export function linePrefixer(prefix, write) {
  let partial = '';
  return (chunk) => {
    const text = partial + chunk;
    const lines = text.split('\n');
    partial = lines.pop();
    for (const line of lines) write(`${prefix} ${line}\n`);
  };
}

// The line native `tsc --watch` prints at the end of every pass, whatever its error count.
const PASS_END = /Found \d+ errors?\. Watching for file changes\./;

/**
 * One `tsc --watch` for `configPath`: a child process of the TypeScript package that owns the
 * config. Resolves `ready` after the first full pass, whatever its error count: type errors are
 * reported, not fatal, exactly as `tsc --watch`.
 *
 * The compiler never writes `outDir` itself. It emits into a private stage
 * (`stateDirectory/<name>/out`); after each pass every staged file whose bytes differ from the
 * published one is written beside it and renamed into place. tsc's direct write truncates a
 * live module before its replacement is complete, and readers then see syntax errors or
 * missing exports mid-rebuild. Until TypeScript 7 a custom `writeFile` on the in-process watch
 * host did the rename; the native compiler has no such hook, so the stage replaces it.
 * Guard: tools/dev-runtime.test.mjs.
 *
 * Incremental: build state persists in `stateDirectory`, so a start with unchanged sources
 * re-checks instead of re-emitting everything. The first pass gates the backend and Vite, and
 * a full rebuild of all three projects took 1m46s on a loaded machine (2026-09-25, TS 5.9).
 * Build state trusts its outputs exist, so a missing stage discards it (one full rebuild). A
 * cleaned `outDir` costs no rebuild: the first pass publishes the whole stage into it.
 */
export function startCompiler({ name, configPath, outDir, stateDirectory, log }) {
  const state = path.join(stateDirectory, name);
  const stage = path.join(state, 'out');
  const tsBuildInfoFile = path.join(state, 'tsbuildinfo');
  if (!existsSync(stage)) rmSync(tsBuildInfoFile, { force: true });
  mkdirSync(stage, { recursive: true });
  let markReady;
  const ready = new Promise((resolve) => {
    markReady = resolve;
  });
  // stage-relative path -> mtime of the staged file when it was last published
  const published = new Map();
  let publishing = Promise.resolve();
  let closing = false;
  const child = spawn(
    process.execPath,
    [
      tscLauncher(configPath),
      '-p',
      configPath,
      '--watch',
      '--preserveWatchOutput',
      '--pretty',
      'false',
      '--incremental',
      '--tsBuildInfoFile',
      tsBuildInfoFile,
      '--outDir',
      stage,
    ],
    { cwd: path.dirname(configPath), stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const onLine = (line) => {
    if (line.trim()) log(`[${name}] ${line.trim()}`);
    if (!PASS_END.test(line)) return;
    publishing = publishing
      .then(() => publishStage(stage, outDir, published))
      .catch((error) => log(`[${name}] publishing ${outDir} failed: ${error.message}`))
      .then(markReady);
  };
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', linePrefixer('', onLine));
  }
  child.once('error', (error) => {
    log(`[${name}] could not start tsc: ${error.message}`);
    markReady();
  });
  child.once('exit', (code, signal) => {
    if (!closing) log(`[${name}] tsc --watch exited (${signal ?? code})`);
    markReady();
  });
  return {
    ready,
    /** Resolves once the compiler process has exited. */
    close: () => {
      closing = true;
      const exited = new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve();
        else child.once('exit', () => resolve());
      });
      child.kill();
      return exited;
    },
  };
}

/** Publish every staged file that changed since its last publish into `outDir`, one rename each. */
async function publishStage(stage, outDir, published) {
  const entries = await readdir(stage, { recursive: true, withFileTypes: true });
  for (const entry of entries.filter((candidate) => candidate.isFile())) {
    const from = path.join(entry.parentPath, entry.name);
    const relative = path.relative(stage, from);
    const { mtimeMs } = await stat(from);
    if (published.get(relative) === mtimeMs) continue;
    const to = path.join(outDir, relative);
    const staged = await readFile(from, 'utf8');
    const text = from.endsWith('.map') ? relocateSourceMap(staged, from, to) : staged;
    if ((await readPublished(to)) !== text) await replaceFile(to, text);
    published.set(relative, mtimeMs);
  }
}

/**
 * A map's `sources` are relative to the map's own directory, and the stage is not `outDir`, so
 * each source is re-relativized onto the published location. JSON.stringify writes tsc's own
 * compact form, so a published map is byte-identical to a direct emit (tested).
 */
function relocateSourceMap(text, from, to) {
  const map = JSON.parse(text);
  map.sources = map.sources.map((source) =>
    path
      .relative(path.dirname(to), path.resolve(path.dirname(from), source))
      .split(path.sep)
      .join('/')
  );
  return JSON.stringify(map);
}

/** The published bytes of an output; one never published reads as `null`. */
async function readPublished(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

let replacements = 0;
/** A same-directory rename makes the new file visible in one step. */
async function replaceFile(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${replacements++}.tmp`;
  try {
    await writeFile(temporary, text, 'utf8');
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Vite's dev server, with the client's own vite.config.ts (`overrides` merge over it). */
export async function startVite({ clientRoot, overrides = {} }) {
  const entry = createRequire(path.join(clientRoot, 'package.json')).resolve('vite');
  const { createServer } = await import(pathToFileURL(entry).href);
  // Explicit, never inherited: a production NODE_ENV in this process turned fast refresh off and
  // re-optimized deps every boot (2026-10-23; the client bundle now builds in a child process,
  // tools/client-build.mjs). Guard: tools/dev-supervisor.test.mjs.
  process.env.NODE_ENV = 'development';
  const server = await createServer({
    root: clientRoot,
    configFile: path.join(clientRoot, 'vite.config.ts'),
    mode: 'development',
    ...overrides,
  });
  await server.listen();
  server.printUrls();
  return server;
}

/** The backend runner; its output is prefixed like the other tools. */
export function startBackend({
  repositoryRoot,
  env,
  log,
  nodeArgs = [],
  onReady = () => {},
  onSpawn = () => {},
}) {
  const serverRoot = path.join(repositoryRoot, 'server');
  const runner = createBackendRunner({
    command: process.execPath,
    args: [...nodeArgs, '--import', 'tsx', 'src/server.ts'],
    cwd: serverRoot,
    env,
    watchRoot: repositoryRoot,
    check: esbuildCheck('src/server.ts', serverRoot),
    buildCrate: ensureAddonBuild(repositoryRoot, (line) => log(`[server-watch] ${line}`)),
    onSpawn,
    output: linePrefixer('[server]', (line) => {
      process.stdout.write(line);
      // startup.ts prints this once the port is bound: the "backend-ready" boot phase.
      if (line.includes('Server running on')) onReady();
    }),
    log: (line) => log(`[server-watch] ${line}`),
    logError: (line) => log(`[server-watch] ${line}`),
  });
  runner.start();
  return runner;
}
