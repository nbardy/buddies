// The dev runtime's long-lived tools, hosted in ONE process.
//
// Until 2026-09-25 `pnpm dev` ran them through concurrently plus a `pnpm
// --filter …` wrapper per tool: 18 processes, ~7 of which only launched
// another. Here the supervisor process itself runs
//   - the three TypeScript watch compilers (shared ESM, shared CJS, agent-cli-tool),
//   - the Vite dev server,
//   - the backend runner (tools/watch-server.mjs),
// through their JavaScript APIs. The backend stays a child process: it is the
// unit that restarts, and it owns the provider pipes of running agent turns.
//
// Order matters: the backend and Vite start only after every compiler's first
// pass. A watcher that starts beside the backend rewrites dist/ while the
// backend loads it, which is what restarted a backend mid-startup on
// 2026-09-25 (see tools/watch-server.mjs).
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureAddonBuild } from './ensure-addons.mjs';
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

/**
 * One `tsc --watch` equivalent through the TypeScript API of the package that
 * owns `configPath`. Resolves `ready` after the first full pass, whatever its
 * error count: type errors are reported, not fatal, exactly as `tsc --watch`.
 *
 * Incremental: build state persists in `stateDirectory`, so a start with
 * unchanged sources re-checks instead of re-emitting everything. The first pass
 * gates the backend and Vite, and a full rebuild of all three projects took
 * 1m46s on a loaded machine (2026-09-25). Build state trusts its outputs
 * exist. A missing `sentinel` output discards the state: one full rebuild.
 * One-shot builds stage before publishing, and watch writes replace each file
 * atomically, so active consumers do not observe truncated modules.
 */
export function startCompiler({ name, configPath, sentinel, stateDirectory, log }) {
  const ts = createRequire(configPath)('typescript');
  const host = ts.sys;
  const format = {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: host.getCurrentDirectory,
    getNewLine: () => '\n',
  };
  let markReady;
  const ready = new Promise((resolve) => {
    markReady = resolve;
  });
  const report = (diagnostic) =>
    log(`[${name}] ${ts.formatDiagnostic(diagnostic, format).trimEnd()}`);
  mkdirSync(stateDirectory, { recursive: true });
  const tsBuildInfoFile = path.join(stateDirectory, `${name}.tsbuildinfo`);
  if (!existsSync(sentinel)) rmSync(tsBuildInfoFile, { force: true });
  const watchHost = ts.createWatchCompilerHost(
    configPath,
    { incremental: true, tsBuildInfoFile },
    host,
    ts.createEmitAndSemanticDiagnosticsBuilderProgram,
    report,
    (diagnostic, _newLine, _options, errorCount) => {
      log(`[${name}] ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`);
      // errorCount is passed only with the "Found N errors" status that ends a pass.
      if (errorCount !== undefined) markReady();
    }
  );
  let writeNumber = 0;
  watchHost.writeFile = (fileName, data, writeByteOrderMark, onError) => {
    // tsc's direct write truncates a live module before its replacement is
    // complete. Readers then see syntax errors or missing exports mid-rebuild.
    // A same-directory rename makes each emitted file visible in one step.
    mkdirSync(path.dirname(fileName), { recursive: true });
    const temporary = `${fileName}.${process.pid}.${writeNumber++}.tmp`;
    try {
      writeFileSync(temporary, `${writeByteOrderMark ? '\uFEFF' : ''}${data}`, 'utf8');
      renameSync(temporary, fileName);
    } catch (error) {
      rmSync(temporary, { force: true });
      if (onError) onError(String(error));
      else throw error;
    }
  };
  const program = ts.createWatchProgram(watchHost);
  return { ready, close: () => program.close() };
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
