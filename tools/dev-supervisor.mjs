#!/usr/bin/env node
// Runs one named task: dev | dev-server | dev-client | build | typecheck.
//
// Dev tasks host their long-lived tools in THIS process (tools/dev-runtime.mjs):
// compilers, Vite and the backend runner; only the backend server itself is a
// child. `pnpm dev` went from 18 processes to ~7 (2026-09-25).
//
// Dev tasks claim one dev runtime per data directory (a lock file holding the
// owner's PID) and refuse dev ports held by anything else. `--replace` stops the
// recorded owner first. Build and typecheck take no dev-runtime lock. The shared
// package stages each one-shot build and atomically replaces its emitted files;
// a restart that races a separate source change backs off and retries
// (tools/watch-server.mjs).
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startBackend, startCompiler, startVite } from './dev-runtime.mjs';
import { LOCAL_DOMAIN_ENV, detectLocalDomain } from './local-domain.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// `dev-server` honours PORT like the backend it runs (server.ts), so a test can drive the real
// dev entry on a spare port beside the owner's live runtime. `dev` stays fixed: Vite proxies to 7499.
const DEV_PORTS = {
  dev: [7489, 7499],
  'dev-server': [Number(process.env.PORT ?? 7499)],
  'dev-client': [7489],
};
// Covers the backend's shutdown drain grace plus its state-flush watchdog.
const REPLACE_TIMEOUT_MS = 10_000;

export function parseArgs(argv) {
  let task = 'dev';
  let replace = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--replace') replace = true;
    else if (argv[index] === '--task') task = argv[++index];
    else throw new Error(`Unknown option: ${argv[index]}`);
  }
  if (replace && !(task in DEV_PORTS)) throw new Error('--replace applies only to dev tasks');
  return { task, replace };
}

// Through the invoking pnpm when there is one: under nvm, pnpm may not be on PATH.
function pnpm(...args) {
  const pnpmScript = process.env.npm_execpath;
  return pnpmScript?.includes('pnpm')
    ? { command: process.execPath, args: [pnpmScript, ...args] }
    : { command: 'pnpm', args };
}

// A task = one-shot `steps` (spawned in order, each must exit 0), then the
// long-lived `services` this process hosts itself (tools/dev-runtime.mjs).
// UNLEASHD_DEV_PREBUILT=1 (tests only) skips the dev-server's TS builds: the agent-cli build
// begins by deleting its dist, so the eight launches of ctrl-c-adoption.test.ts deleted the dist
// every other test file was importing in parallel, and under full-suite load each rebuild took
// ~100 s, past the launch wait (the P1 Ctrl+C flake, 2026-10-03).
export function taskPlan(task, env = process.env) {
  const buildShared = pnpm('--filter', '@unleashd/shared', 'build');
  const buildCli = pnpm('--dir', 'vendor/agent-cli-tool', 'build');
  // Both napi addons, from the shared build cache when any worktree has built
  // these exact sources (tools/ensure-addons.mjs; cargo runs only on a miss).
  // After that the backend runner re-ensures a crate when one of its sources is saved.
  const ensureAddons = { command: process.execPath, args: ['tools/ensure-addons.mjs'] };
  switch (task) {
    case 'build':
      return {
        steps: [
          buildShared,
          buildCli,
          ensureAddons,
          pnpm('--filter', '@unleashd/server', 'build'),
          pnpm('--filter', '@unleashd/client', 'build'),
        ],
        services: [],
      };
    case 'typecheck':
      return {
        steps: [
          // Buddies line-count ratchet: fails before the slow checks when the code grew.
          { command: 'bash', args: ['tools/check-buddies-line-ceiling.sh'] },
          buildShared,
          pnpm('--filter', '@unleashd/server', 'typecheck'),
          pnpm('--filter', '@unleashd/client', 'exec', 'tsc', '-b'),
          // Tests are typechecked here, not in `tsc -b` (which `vite build` also
          // runs): a test-only type error must fail typecheck, never the build.
          pnpm('--filter', '@unleashd/client', 'exec', 'tsc', '-p', 'tsconfig.test.json'),
          pnpm('--dir', 'vendor/agent-cli-tool', 'typecheck'),
        ],
        services: [],
      };
    case 'dev-server':
      return {
        steps:
          env.UNLEASHD_DEV_PREBUILT === '1'
            ? [ensureAddons]
            : [buildShared, buildCli, ensureAddons],
        services: ['backend'],
      };
    case 'dev-client':
      return { steps: [buildShared], services: ['vite'] };
    // Only the addons: the compilers' first pass is the TS build, and nothing
    // else starts until it has finished.
    case 'dev':
      return { steps: [ensureAddons], services: ['compilers', 'backend', 'vite'] };
    default:
      throw new Error(
        `Unknown task "${task}"; expected dev, dev-server, dev-client, build or typecheck`
      );
  }
}

// The compilers `pnpm dev` runs: the same configs as the packages' watch scripts.
// `sentinel` is an output whose absence means dist/ was cleaned (dev-runtime.mjs).
const COMPILERS = [
  {
    name: 'shared-esm',
    configPath: path.join(repositoryRoot, 'shared', 'tsconfig.json'),
    sentinel: path.join(repositoryRoot, 'shared', 'dist', 'index.js'),
  },
  {
    name: 'shared-cjs',
    configPath: path.join(repositoryRoot, 'shared', 'tsconfig.cjs.json'),
    sentinel: path.join(repositoryRoot, 'shared', 'dist', 'cjs', 'index.js'),
  },
  {
    name: 'cli',
    configPath: path.join(repositoryRoot, 'vendor', 'agent-cli-tool', 'tsconfig.build.json'),
    sentinel: path.join(repositoryRoot, 'vendor', 'agent-cli-tool', 'dist', 'index.js'),
  },
];
const COMPILER_STATE = path.join(repositoryRoot, 'node_modules', '.cache', 'unleashd-dev');

// --- the dev runtime lock -----------------------------------------------------

export function lockPath(dataDirectory = process.env.UNLEASHD_DATA_DIR) {
  return path.join(
    path.resolve(dataDirectory ?? path.join(os.homedir(), '.agent-viewer')),
    'dev-supervisor.lock.json'
  );
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// Owner = Recorded({pid, childPgid}) ⊕ Unreadable ⊕ Gone. An unreadable lock
// records no process to protect, so it is reclaimed like a dead owner.
function readOwner(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { kind: 'gone' };
    throw error;
  }
  try {
    const { pid, childPgid } = JSON.parse(raw);
    if (Number.isSafeInteger(pid)) return { kind: 'recorded', raw, pid, childPgid };
  } catch {}
  return { kind: 'unreadable', raw };
}

// Reclaim only the lock we inspected: a concurrent start may have replaced it.
function reclaim(file, owner) {
  if (owner.kind === 'gone') return;
  try {
    if (readFileSync(file, 'utf8') === owner.raw) rmSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function signal(target, name) {
  try {
    process.kill(target, name);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

async function stopOwner({ pid, childPgid }) {
  signal(pid, 'SIGTERM');
  const deadline = Date.now() + REPLACE_TIMEOUT_MS;
  while (isAlive(pid) && Date.now() < deadline) await sleep(100);
  // The owner forwards SIGTERM to its child group; the SIGKILLs only land when
  // it could not, so nothing it started outlives it.
  if (childPgid) signal(-childPgid, 'SIGKILL');
  signal(pid, 'SIGKILL');
}

export async function claimDevRuntime({ file = lockPath(), replace = false } = {}) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, childPgid: null }), { flag: 'wx' });
      return {
        recordChild: (childPgid) =>
          writeFileSync(file, JSON.stringify({ pid: process.pid, childPgid })),
        release: () => rmSync(file, { force: true }),
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const owner = readOwner(file);
    if (owner.kind === 'recorded' && isAlive(owner.pid)) {
      if (!replace) {
        throw new Error(
          `A dev runtime is already running (PID ${owner.pid}). Use "pnpm dev:replace" to replace it; if PID ${owner.pid} is not Unleashd, delete ${file}.`
        );
      }
      console.log(`[dev-supervisor] Stopping the dev runtime owned by PID ${owner.pid}`);
      await stopOwner(owner);
    }
    reclaim(file, owner);
  }
}

// Something listening on a dev port without holding the lock (an orphaned
// backend, a stray vite) would make this runtime fail or serve stale code.
// lsof sees every address family; the bind probe covers hosts without lsof.
// A probe alone is not enough: binding 127.0.0.1 succeeds beside vite's IPv6
// `*:7489` listener.
export async function assertPortsFree(ports) {
  const held = [];
  for (const port of ports) {
    const pids = (
      spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
        .stdout ?? ''
    )
      .split('\n')
      .filter(Boolean);
    const bindable = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (pids.length > 0 || !bindable) {
      held.push(`port ${port} (PID ${pids.join(', ') || 'unknown'})`);
    }
  }
  if (held.length > 0) {
    throw new Error(
      `${held.join(', ')} already in use by a process outside the dev runtime. Stop it, then retry; nothing was signalled.`
    );
  }
}

// --- running ------------------------------------------------------------------

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// pnpm relays the terminal's SIGINT to its script, so ONE Ctrl+C under `pnpm dev` reaches this
// process twice, 0.1-0.2 ms apart (measured 2026-10-01). Counting the relay as a second press
// escalated every single Ctrl+C to SIGKILL of the backend, skipping its graceful shutdown.
// A repeat inside this window is the relay; a human second press is far slower.
// Guard: server/test/ctrl-c-adoption.test.ts ("one Ctrl+C ... exits gracefully").
const RELAYED_SIGNAL_MS = 250;

/** Press = First ⊕ Relay (the same press, relayed) ⊕ Again (a real second press). */
function pressCounter() {
  let firstAt = null;
  return () => {
    const now = performance.now();
    if (firstAt === null) {
      firstAt = now;
      return 'first';
    }
    return now - firstAt < RELAYED_SIGNAL_MS ? 'relay' : 'again';
  };
}

async function runSteps(steps, onChild) {
  let received = null;
  let child = null;
  const press = pressCounter();
  const forward = (name) => {
    const kind = press();
    if (kind === 'relay') return;
    if (child) signal(-child.pid, kind === 'again' ? 'SIGKILL' : name);
    received = name;
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const name of signals) process.on(name, forward);
  try {
    for (const step of steps) {
      if (received) return 130;
      child = spawn(step.command, step.args, {
        cwd: repositoryRoot,
        stdio: 'inherit',
        detached: true,
      });
      onChild(child.pid);
      const { code, killedBy } = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (exitCode, exitSignal) =>
          resolve({ code: exitCode, killedBy: exitSignal })
        );
      });
      child = null;
      if (received || killedBy) return 130;
      if (code !== 0) return code;
    }
    return 0;
  } finally {
    for (const name of signals) process.off(name, forward);
  }
}

const log = (line) => process.stdout.write(`${line}\n`);

/**
 * Host `services` until a signal. Compilers finish their first pass before the
 * backend or Vite starts. Returns the exit code.
 */
async function runServices(services) {
  const running = { compilers: [], backend: null, vite: null };
  let stopping = null;
  const press = pressCounter();
  const stop = (name) => {
    const kind = press();
    if (kind === 'relay') return;
    if (kind === 'again') {
      running.backend?.stop('SIGKILL');
      return;
    }
    stopping = name;
    for (const compiler of running.compilers) compiler.close();
    void running.vite?.close();
    if (running.backend) running.backend.stop(name);
    else process.exit(130);
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const name of signals) process.on(name, stop);
  try {
    if (services.includes('compilers')) {
      // The build scripts write these CommonJS markers after tsc; watch mode never does.
      await import(
        pathToFileURL(path.join(repositoryRoot, 'shared/scripts/write-cjs-package.mjs')).href
      );
      await import(
        pathToFileURL(
          path.join(repositoryRoot, 'vendor/agent-cli-tool/scripts/write-dist-package.mjs')
        ).href
      );
      running.compilers = COMPILERS.map((compiler) =>
        startCompiler({ ...compiler, stateDirectory: COMPILER_STATE, log })
      );
      await Promise.all(running.compilers.map((compiler) => compiler.ready));
    }
    if (stopping) return 130;
    if (services.includes('backend')) {
      running.backend = startBackend({ repositoryRoot, env: { NODE_ENV: 'development' }, log });
    }
    if (services.includes('vite')) {
      running.vite = await startVite({ clientRoot: path.join(repositoryRoot, 'client') });
    }
    if (running.backend) await running.backend.stopped;
    else await new Promise(() => {});
    return 130;
  } finally {
    for (const name of signals) process.off(name, stop);
  }
}

export async function runTask({ task, replace }) {
  const plan = taskPlan(task);
  if (!(task in DEV_PORTS)) return runSteps(plan.steps, () => {});
  // Vite's config and the backend read this at load; both now run in or under
  // this process, so it is set here rather than per spawned tool.
  process.env[LOCAL_DOMAIN_ENV] = detectLocalDomain({ task }) ? '1' : '0';
  const runtime = await claimDevRuntime({ replace });
  try {
    await assertPortsFree(DEV_PORTS[task]);
    const code = await runSteps(plan.steps, runtime.recordChild);
    if (code !== 0) return code;
    return await runServices(plan.services);
  } finally {
    runtime.release();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runTask(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`[dev-supervisor] ${error.message}`);
    process.exitCode = 1;
  }
  // Hosted services (Vite's watchers, compiler timers) may still hold handles.
  process.exit();
}
