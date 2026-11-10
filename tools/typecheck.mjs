#!/usr/bin/env node
// Pattern: fix-guards (docs/patterns.md#fix-guards)
// `pnpm typecheck` (and the experimental `pnpm typecheck:fast`, `--tsrs`), single-flight across
// every process on the machine.
//
// Why: concurrent agents each ran their own typecheck at once and the typecheckers contended
// for the machine (owner, 2026-11-10); nothing serialized them. Now one lock file in the temp
// directory admits one typecheck at a time, from any checkout. A run that waited reuses the
// result of the run it waited for when that run finished after it started and covered the same
// tree (same checkout, every file's size and mtime unchanged); otherwise it runs next.
// Guard: tools/typecheck.test.mjs (two at once never overlap; the waiter reuses or queues).
//
// The compilers run directly (`node <tsc launcher>`), not as `pnpm --filter … exec tsc`: each
// nested pnpm cost ~1.4 s of startup on a loaded machine, more than a TypeScript 7 check.
// This is a CLI tool, never a server event loop, so synchronous fs and `git` are fine here.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tscLauncher } from './lib/tsc.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Machine-wide on purpose: the contention is between checkouts (agent worktrees), not within one.
const LOCK_FILE =
  process.env.UNLEASHD_TYPECHECK_LOCK ?? path.join(os.tmpdir(), 'unleashd-typecheck.lock.json');
const RESULT_FILE = path.join(repositoryRoot, 'node_modules', '.cache', 'typecheck-result.json');
// A typecheck takes seconds. A lock this old belongs to a recycled PID, not a slow check.
const STALE_LOCK_MS = 10 * 60_000;
// A lock file younger than this with no readable owner is still being written.
const UNREADABLE_GRACE_MS = 5_000;
const POLL_MS = 200;

const at = (...parts) => path.join(repositoryRoot, ...parts);
const relative = (file) => path.relative(repositoryRoot, file);

/** `node <launcher> ...args`, labelled for failure reports. */
const step = (name, launcher, args) => ({
  label: `${name} ${args.map((arg) => (path.isAbsolute(arg) ? relative(arg) : arg)).join(' ')}`,
  args: [launcher, ...args],
});

/** The tsrs launcher (root devDependency), through its manifest's `bin` like tsc's. */
function tsrsLauncher() {
  const manifest = createRequire(at('package.json')).resolve('tsrs/package.json');
  return path.join(path.dirname(manifest), JSON.parse(readFileSync(manifest, 'utf8')).bin.tsrs);
}

/**
 * Checker = Tsc ⊕ Tsrs: which compiler checks the projects.
 *   tsc  - `pnpm typecheck`: each package's own TypeScript 7.
 *   tsrs - `pnpm typecheck:fast`, EXPERIMENTAL: the Rust port (npm `tsrs`). On 2026-11-10 its
 *          diagnostics were byte-identical to tsc 7.0.2's on every project, clean and with four
 *          injected errors of different kinds, at about a third of the wall time and memory.
 *          Never with tsrs's own `--fast` (modes that may differ from TypeScript). The client
 *          projects are checked with `-p` each, the same set `tsc -b` checks.
 * Every check runs even after one fails, so one run reports every project's errors.
 */
const CHECKERS = {
  tsc: () => {
    const tsc = (config, ...args) => step('tsc', tscLauncher(config), args);
    return [
      tsc(at('server', 'tsconfig.test.json'), '-p', at('server', 'tsconfig.test.json')),
      tsc(at('client', 'tsconfig.json'), '-b', at('client', 'tsconfig.json')),
      // Tests are typechecked here, not in `tsc -b` (which `vite build` also runs): a test-only
      // type error must fail typecheck, never the build.
      tsc(at('client', 'tsconfig.test.json'), '-p', at('client', 'tsconfig.test.json')),
      tsc(
        at('vendor', 'agent-cli-tool', 'tsconfig.json'),
        '-p',
        at('vendor', 'agent-cli-tool'),
        '--noEmit'
      ),
    ];
  },
  tsrs: () => {
    const tsrs = (...args) => step('tsrs', tsrsLauncher(), args);
    return [
      tsrs('-p', at('server', 'tsconfig.test.json')),
      tsrs('-p', at('client', 'tsconfig.app.json')),
      tsrs('-p', at('client', 'tsconfig.node.json')),
      tsrs('-p', at('client', 'tsconfig.test.json')),
      tsrs('-p', at('vendor', 'agent-cli-tool', 'tsconfig.json'), '--noEmit'),
    ];
  },
};

/** What a typecheck runs. `shared` builds first: the others check against its emitted types. */
function plan(checker) {
  return {
    prerequisite: { label: 'shared build', args: [at('shared', 'scripts', 'build.mjs')] },
    checks: CHECKERS[checker](),
  };
}

/** `--tsrs` picks the experimental checker; anything else is a usage error. */
export function parseArgs(argv) {
  if (argv.length === 0) return { checker: 'tsc' };
  if (argv.length === 1 && argv[0] === '--tsrs') return { checker: 'tsrs' };
  throw new Error(`usage: node tools/typecheck.mjs [--tsrs]; got ${argv.join(' ')}`);
}

// --- the tree -----------------------------------------------------------------------------

function listFiles(directory) {
  const listed = spawnSync('git', ['ls-files', '-z', '-co', '--exclude-standard'], {
    cwd: directory,
    encoding: 'utf8',
  });
  if (listed.status !== 0) throw new Error(`git ls-files failed in ${directory}: ${listed.stderr}`);
  return listed.stdout.split('\0').filter(Boolean);
}

/**
 * The checkout as the typecheck sees it: every tracked or unignored file (the submodule's
 * too) by size and mtime, plus the installed dependency state. Ignored outputs (dist/,
 * node_modules/) are left out because the typecheck itself rewrites them.
 */
export function fingerprint(root = repositoryRoot) {
  const submodule = path.join('vendor', 'agent-cli-tool');
  const files = [
    ...listFiles(root),
    ...listFiles(path.join(root, submodule)).map((file) => path.join(submodule, file)),
    path.join('node_modules', '.modules.yaml'),
  ].sort();
  const hash = createHash('sha256');
  for (const file of files) {
    const stats = statSync(path.join(root, file), { throwIfNoEntry: false });
    hash.update(`${file}\0${stats ? `${stats.size}:${stats.mtimeMs}` : 'missing'}\0`);
  }
  return hash.digest('hex');
}

// --- the lock -------------------------------------------------------------------------------

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** Holder = Running({pid, root, startedAt}) ⊕ Stale ⊕ Writing ⊕ Gone. */
function readHolder(file) {
  let raw;
  let mtimeMs;
  try {
    raw = readFileSync(file, 'utf8');
    mtimeMs = statSync(file).mtimeMs;
  } catch (error) {
    if (error.code === 'ENOENT') return { kind: 'gone' };
    throw error;
  }
  try {
    const holder = JSON.parse(raw);
    if (Number.isSafeInteger(holder.pid)) {
      const running = isAlive(holder.pid) && Date.now() - holder.startedAt < STALE_LOCK_MS;
      return running ? { kind: 'running', raw, ...holder } : { kind: 'stale', raw };
    }
  } catch {}
  return Date.now() - mtimeMs < UNREADABLE_GRACE_MS ? { kind: 'writing' } : { kind: 'stale', raw };
}

/** Remove a stale lock only if it is still the one inspected: a new holder may have replaced it. */
function reclaim(file, raw) {
  try {
    if (readFileSync(file, 'utf8') === raw) rmSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Wait until this process holds the lock. Returns its release function. */
export async function acquireLock(file, log) {
  mkdirSync(path.dirname(file), { recursive: true });
  const record = JSON.stringify({
    pid: process.pid,
    root: repositoryRoot,
    startedAt: Date.now(),
    token: randomUUID(),
  });
  let announced = null;
  for (;;) {
    try {
      writeFileSync(file, record, { flag: 'wx' });
      return () => reclaim(file, record);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const holder = readHolder(file);
    const waits = {
      running: () => {
        if (announced !== holder.pid) {
          log(`waiting for the typecheck of PID ${holder.pid} (${holder.root})`);
          announced = holder.pid;
        }
        return sleep(POLL_MS);
      },
      writing: () => sleep(POLL_MS),
      stale: () => reclaim(file, holder.raw),
      gone: () => {},
    };
    await waits[holder.kind]();
  }
}

// --- running --------------------------------------------------------------------------------

/** Run one step with its output teed into `output`. Resolves its exit code (130 if signalled). */
function runStep(step, output, current) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, step.args, {
      cwd: repositoryRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    current.child = child;
    const tee = (stream, sink) => {
      stream.on('data', (chunk) => {
        sink.write(chunk);
        output.push(chunk.toString('utf8'));
      });
    };
    tee(child.stdout, process.stdout);
    tee(child.stderr, process.stderr);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      current.child = null;
      resolve(signal ? 130 : code);
    });
  });
}

/** The whole plan. Resolves `{ code, output }`; `code` is the first failure's, or 0. */
async function runPlan(steps, current) {
  const output = [];
  const prerequisite = await runStep(steps.prerequisite, output, current);
  if (prerequisite !== 0 || current.interrupted) return { code: prerequisite || 130, output };
  let code = 0;
  for (const check of steps.checks) {
    if (current.interrupted) return { code: 130, output };
    const exit = await runStep(check, output, current);
    if (exit !== 0) {
      output.push(`[typecheck] FAILED: ${check.label}\n`);
      process.stderr.write(`[typecheck] FAILED: ${check.label}\n`);
      code ||= exit;
    }
  }
  return { code, output };
}

function readResult() {
  try {
    return JSON.parse(readFileSync(RESULT_FILE, 'utf8'));
  } catch {
    return { kind: 'none' };
  }
}

function writeResult(result) {
  mkdirSync(path.dirname(RESULT_FILE), { recursive: true });
  const temporary = `${RESULT_FILE}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(result));
  renameSync(temporary, RESULT_FILE);
}

export async function main({ checker }) {
  const log = (line) => process.stderr.write(`[typecheck] ${line}\n`);
  const startedAt = Date.now();
  const current = { child: null, interrupted: false };
  const interrupt = (signal) => {
    current.interrupted = true;
    current.child?.kill(signal);
  };
  const release = await acquireLock(LOCK_FILE, log);
  // Only once the lock is held: a signal while waiting keeps its default (exit; nothing held).
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, interrupt);
  try {
    const before = fingerprint();
    const previous = readResult();
    // Reuse only a result that finished while this run waited for it, on this exact tree, from
    // the same checker.
    if (
      previous.kind === 'finished' &&
      previous.checker === checker &&
      previous.finishedAt >= startedAt &&
      previous.fingerprint === before
    ) {
      process.stdout.write(previous.output);
      log(`reused the result of PID ${previous.pid}, which finished while this one waited`);
      return previous.code;
    }
    const { code, output } = await runPlan(plan(checker), current);
    // A tree that changed mid-run makes the result describe no single tree: record nothing.
    if (code !== 130 && fingerprint() === before) {
      writeResult({
        kind: 'finished',
        checker,
        pid: process.pid,
        finishedAt: Date.now(),
        fingerprint: before,
        code,
        output: output.join(''),
      });
    }
    return code;
  } finally {
    release();
  }
}

// realpath: import.meta.url is resolved through symlinks (macOS /var -> /private/var), argv is not.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(parseArgs(process.argv.slice(2)));
}
