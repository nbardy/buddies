#!/usr/bin/env node
// Keeps exactly one dev backend running the code that is on disk.
//
// A reload must never break agent runs the harness launched: agents build
// Unleashd with Unleashd, so their own edits trigger these reloads. The runner
// only ASKS the backend to reload; the backend finishes every active turn first
// (server/src/lifecycle/shutdown.ts), and code that does not build never
// replaces a working backend.
//
// State = Running(child) ⊕ Draining(child) ⊕ Down(retry timer) ⊕ Stopping(child) ⊕ Stopped
//   source change → Running:  build-check, then ask the backend to drain → Draining
//                   Down:     build-check, then start now
//   backend exit  → Draining: start the replacement
//                   Running:  it crashed or was killed → Down, retry with backoff (never gives up)
//                   Stopping: done
//
// What to watch is never configured. The backend reports every file it loads
// (Node's own --watch protocol, WATCH_REPORT_DEPENDENCIES), so no dependency can
// be missing from the list. On 2026-09-23 Buddies v33 was vendored into
// node_modules, which the old hand-written watch list did not cover, and the
// backend kept serving the v32 post shape for hours.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, watch } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureAddonBuild } from './ensure-addons.mjs';

export const RELOAD_MESSAGE = 'unleashd:dev-reload';
const SETTLE_MS = 300;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const HEALTHY_UPTIME_MS = 30_000;

// Synchronous on purpose: the baseline must be read the moment the backend
// reports a file. An async read let an edit land first, become the baseline,
// and hide the change.
function digest(file) {
  try {
    return createHash('sha1').update(readFileSync(file)).digest('base64');
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    throw error;
  }
}

function describeExit(code, signal) {
  return signal ? `signal ${signal}` : `exit ${code}`;
}

/** Whole-graph esbuild bundle: catches syntax errors and missing exports in ~60ms. */
export function esbuildCheck(entry, cwd) {
  const esbuild = createRequire(createRequire(import.meta.url).resolve('tsx'))('esbuild');
  return async () => {
    try {
      await esbuild.build({
        entryPoints: [entry],
        absWorkingDir: cwd,
        bundle: true,
        write: false,
        platform: 'node',
        packages: 'external',
        format: 'cjs',
        logLevel: 'silent',
      });
      return { ok: true };
    } catch (error) {
      const formatted = await esbuild.formatMessages(error.errors ?? [], { kind: 'error' });
      return { ok: false, message: formatted.join('\n') || String(error) };
    }
  };
}

// Rust sources are never loaded by the backend; the addon they compile to is
// (`crates/<c>/*.node`, reported like any other file). So a saved `.rs` only has
// to rebuild its crate: the rewritten addon then reloads the backend through the
// digest path below, and a build that changes nothing restarts nothing. Until
// T14b (2026-09-26) every crate edit needed a hand-run `pnpm --dir crates/<c> build`.
// The rebuild goes through tools/ensure-addons.mjs (S12): a save that returns a
// crate to sources any worktree has built is a cache copy, not a cargo run. Only
// addon crates (a napi package.json) are built; the import CLIs are plain Cargo
// crates, and a save in one of them must never rebuild a shipped addon.
const CRATE_SOURCE = /^crates\/([^/]+)\/(?:src\/.+\.rs|build\.rs|Cargo\.toml)$/;

/** The crate a repository-relative path is a build input of, or null. */
export function crateOfSource(relativePath) {
  return CRATE_SOURCE.exec(relativePath.split(path.sep).join('/'))?.[1] ?? null;
}

export function createBackendRunner({
  command,
  args,
  cwd,
  env = {},
  watchRoot,
  check,
  // (crate) => Promise<{ ok } | { ok: false, message }>; see crateOfSource.
  buildCrate,
  // (chunk) => void. Given, the backend's stdout and stderr are piped through
  // it (the one-process dev runtime prefixes them); absent, they are inherited.
  output,
  settleMs = SETTLE_MS,
  initialBackoffMs = INITIAL_BACKOFF_MS,
  log = (line) => console.log(`[server-watch] ${line}`),
  logError = (line) => console.error(`[server-watch] ${line}`),
}) {
  const root = realpathSync(watchRoot);
  let state = { kind: 'down', timer: undefined };
  // Loaded file → digest of the content the backend loaded. This is the running
  // backend's baseline and is never overwritten by file events; only a new
  // backend (spawnBackend) resets it.
  let loaded = new Map();
  // Loaded files touched since the last settle; compared to `loaded` once quiet.
  const touched = new Set();
  let backoffMs = initialBackoffMs;
  let settleTimer;
  // Crates with a saved source not built yet; one cargo build at a time (they
  // share crates/target and its lock).
  const staleCrates = new Set();
  let crateTimer;
  let buildingCrates = false;
  let watcher;
  let resolveStopped;
  const stopped = new Promise((resolve) => {
    resolveStopped = resolve;
  });

  // Node's report lists paths, file: URLs, and null (for modules without a file).
  function recordLoaded(message) {
    for (const key of ['watch:require', 'watch:import']) {
      for (const entry of message?.[key] ?? []) {
        if (typeof entry !== 'string') continue;
        const file = entry.startsWith('file:') ? fileURLToPath(entry) : entry;
        loaded.set(file, digest(file));
      }
    }
  }

  // A build (pnpm typecheck / build) and every compiler watch start rewrite
  // shared/dist and the agent-cli-tool dist byte-for-byte; only a real content
  // change may restart the backend. Files are compared once the writes settle,
  // never per event: the cli compiler can truncate a file while writing it,
  // and digesting the empty intermediate read as a change. On 2026-09-25 that made the cli
  // watcher's initial emit restart a backend mid-startup, so every `pnpm dev`
  // parsed the conversation history twice (~135s each on a loaded machine).
  function onFileEvent(file) {
    touched.add(file);
    clearTimeout(settleTimer);
    settleTimer = setTimeout(onSettled, settleMs);
  }

  // 'missing' is a file mid-rewrite: the write that completes it fires its own event.
  function onSettled() {
    const changed = [...touched].filter((file) => {
      const current = digest(file);
      return current !== 'missing' && current !== loaded.get(file);
    });
    touched.clear();
    if (changed.length > 0) void onSourceChanged();
  }

  function onCrateSource(crate) {
    staleCrates.add(crate);
    clearTimeout(crateTimer);
    crateTimer = setTimeout(buildStaleCrates, settleMs);
  }

  async function buildStaleCrates() {
    if (buildingCrates) return;
    buildingCrates = true;
    for (const crate of staleCrates) {
      staleCrates.delete(crate);
      log(`crates/${crate} changed; building its addon`);
      const result = await buildCrate(crate);
      if (!result.ok) {
        logError(`crates/${crate} does not build; keeping the current addon.\n${result.message}`);
      }
    }
    buildingCrates = false;
  }

  function spawnBackend() {
    loaded = new Map();
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env, WATCH_REPORT_DEPENDENCIES: '1' },
      stdio: output ? ['inherit', 'pipe', 'pipe', 'ipc'] : ['inherit', 'inherit', 'inherit', 'ipc'],
    });
    if (output) {
      child.stdout.setEncoding('utf8').on('data', output);
      child.stderr.setEncoding('utf8').on('data', output);
    }
    const startedAt = Date.now();
    child.on('message', recordLoaded);
    child.once('exit', (code, signal) => onExit(code, signal, Date.now() - startedAt));
    state = { kind: 'running', child };
  }

  function onExit(code, signal, uptimeMs) {
    switch (state.kind) {
      case 'draining':
        log('Backend finished its active work; starting the updated backend');
        backoffMs = initialBackoffMs;
        spawnBackend();
        return;
      case 'running': {
        const delayMs = uptimeMs >= HEALTHY_UPTIME_MS ? initialBackoffMs : backoffMs;
        backoffMs = Math.min(delayMs * 2, MAX_BACKOFF_MS);
        logError(
          `Backend exited (${describeExit(code, signal)}) after ${uptimeMs}ms; restarting in ${delayMs}ms (or on the next source change)`
        );
        state = { kind: 'down', timer: setTimeout(spawnBackend, delayMs) };
        return;
      }
      case 'stopping':
        // A second Ctrl+C escalates to SIGKILL; this line is the only record of which stop won.
        log(`Backend stopped (${describeExit(code, signal)})`);
        finish();
        return;
    }
  }

  async function onSourceChanged() {
    const result = await check();
    if (!result.ok) {
      logError(`New code does not build; keeping the current backend.\n${result.message}`);
      return;
    }
    switch (state.kind) {
      case 'running':
        // A send failure means the channel just closed: the backend is exiting,
        // and onExit owns what happens next.
        state.child.send({ type: RELOAD_MESSAGE }, () => {});
        state = { kind: 'draining', child: state.child };
        log('Source changed; the backend restarts once its active work finishes');
        return;
      case 'down':
        clearTimeout(state.timer);
        log('Source changed; starting the backend');
        spawnBackend();
        return;
      case 'draining':
      case 'stopping':
      case 'stopped':
        return;
    }
  }

  function finish() {
    clearTimeout(settleTimer);
    clearTimeout(crateTimer);
    watcher.close();
    state = { kind: 'stopped' };
    resolveStopped();
  }

  function start() {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const file = path.join(root, filename);
      if (loaded.has(file)) onFileEvent(file);
      const crate = crateOfSource(filename);
      if (crate && existsSync(path.join(root, 'crates', crate, 'package.json'))) {
        onCrateSource(crate);
      }
    });
    spawnBackend();
  }

  function stop(signal) {
    switch (state.kind) {
      case 'running':
      case 'draining':
        state.child.kill(signal);
        state = { kind: 'stopping', child: state.child };
        return;
      case 'down':
        clearTimeout(state.timer);
        finish();
        return;
      case 'stopping':
        state.child.kill('SIGKILL');
        return;
      case 'stopped':
        return;
    }
  }

  return { start, stop, stopped };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const serverRoot = path.join(repositoryRoot, 'server');
  const runner = createBackendRunner({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/server.ts'],
    cwd: serverRoot,
    env: { NODE_ENV: 'development' },
    watchRoot: repositoryRoot,
    check: esbuildCheck('src/server.ts', serverRoot),
    buildCrate: ensureAddonBuild(repositoryRoot),
  });
  process.on('SIGINT', () => runner.stop('SIGINT'));
  process.on('SIGTERM', () => runner.stop('SIGTERM'));
  runner.start();
}
