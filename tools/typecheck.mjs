#!/usr/bin/env node
// Pattern: fix-guards (docs/patterns.md#fix-guards)
// `pnpm typecheck` (tsrs, falling back to tsc loudly), `pnpm typecheck:reference` (tsc 7) and
// `pnpm typecheck:cross-check` (both, compared; CI), single-flight across every process on the
// machine. `pnpm check` (tools/check.mjs) shares the lock.
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
import { compareDiagnostics, outcomeOf } from './lib/diagnostics.mjs';
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

/**
 * The projects every typecheck covers. The client's app and node configs are checked with `-p`
 * each: the same two projects `tsc -b client` checks, and a form both compilers accept, so their
 * outputs compare line for line. Tests are typechecked here, not in `tsc -b` (which `vite build`
 * also runs): a test-only type error must fail typecheck, never the build.
 */
const PROJECTS = [
  // shared also builds with tsc first; checking it here puts its source (the keyed expedition
  // types every package imports) under the tsrs/tsc cross-check too.
  { config: at('shared', 'tsconfig.json'), extra: ['--noEmit'] },
  { config: at('server', 'tsconfig.test.json'), extra: [] },
  { config: at('client', 'tsconfig.app.json'), extra: [] },
  { config: at('client', 'tsconfig.node.json'), extra: [] },
  { config: at('client', 'tsconfig.test.json'), extra: [] },
  { config: at('vendor', 'agent-cli-tool', 'tsconfig.json'), extra: ['--noEmit'] },
];

/** The tsrs launcher (root devDependency), through its manifest's `bin` like tsc's. */
function tsrsLauncher() {
  const manifest = createRequire(at('package.json')).resolve('tsrs/package.json');
  return path.join(path.dirname(manifest), JSON.parse(readFileSync(manifest, 'utf8')).bin.tsrs);
}

/**
 * Compiler = Tsrs ⊕ Tsc. tsrs (npm `tsrs`, the Rust port of TypeScript, EXPERIMENTAL) is the
 * default: on 2026-11-10 its diagnostics matched tsc 7.0.2 byte for byte on every project, clean
 * and with four injected errors, at about a third of tsc's memory. Never with tsrs's own `--fast`
 * (modes that may differ from TypeScript). tsc 7 (each package's own) is the reference.
 */
const COMPILERS = {
  tsrs: { name: 'tsrs', launcher: () => tsrsLauncher() },
  tsc: { name: 'tsc', launcher: (project) => tscLauncher(project.config) },
};

/** A runnable check, or the reason its compiler cannot even be found. */
function commandFor(compiler, project) {
  const args = ['-p', project.config, ...project.extra];
  const label = `${compiler.name} -p ${relative(project.config)}${project.extra.map((a) => ` ${a}`).join('')}`;
  try {
    return { kind: 'runnable', label, args: [compiler.launcher(project), ...args] };
  } catch (error) {
    return { kind: 'missing', label, reason: error.message.split('\n')[0] };
  }
}

/** Run one node script with its output teed (when `echo`) and captured. */
function runNode(args, current, echo) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: repositoryRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    current.child = child;
    let text = '';
    for (const [stream, sink] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ]) {
      stream.on('data', (chunk) => {
        if (echo) {
          sink.write(chunk);
          current.transcript.push(String(chunk));
        }
        text += chunk;
      });
    }
    child.once('error', (error) => resolve({ code: 1, signal: null, text: error.message }));
    child.once('close', (code, signal) => {
      current.child = null;
      resolve({ code, signal, text });
    });
  });
}

/** One compiler on one project: its Outcome (tools/lib/diagnostics.mjs) and what it printed. */
async function check(compiler, project, current, echo) {
  const command = commandFor(compiler, project);
  if (command.kind === 'missing') {
    return { label: command.label, outcome: { kind: 'broken', reason: command.reason }, text: '' };
  }
  const run = await runNode(command.args, current, echo);
  return { label: command.label, outcome: outcomeOf(run), text: run.text };
}

/**
 * Mode = Default ⊕ Reference ⊕ CrossCheck, each over every project; every project is checked
 * even after one fails, so one run reports every error. Resolves `{ code, output }`.
 *   default     tsrs; a project tsrs cannot run (Broken) is checked by tsc instead, and the run
 *               says so in a FALLBACK line with the reason. Never silent.
 *   reference   tsc only.
 *   cross-check both on every project (CI): fails if either fails or their diagnostics differ.
 */
const MODES = {
  default: async (current, say) => {
    let failed = false;
    for (const project of PROJECTS) {
      if (current.interrupted) return 130;
      const result = await checkWithFallback(project, current, say);
      failed = report(result, say) || failed;
    }
    return failed ? 1 : 0;
  },
  reference: async (current, say) => {
    let failed = false;
    for (const project of PROJECTS) {
      if (current.interrupted) return 130;
      failed = report(await check(COMPILERS.tsc, project, current, true), say) || failed;
    }
    return failed ? 1 : 0;
  },
  'cross-check': async (current, say) => {
    let failed = false;
    for (const project of PROJECTS) {
      if (current.interrupted) return 130;
      const tsrs = await check(COMPILERS.tsrs, project, current, false);
      const tsc = await check(COMPILERS.tsc, project, current, false);
      const verdict = crossCheck(tsrs, tsc);
      say(`${verdict.kind === 'agree' ? 'agree' : 'DIVERGE'}: ${relative(project.config)}`);
      for (const line of verdict.lines) say(`  ${line}`);
      failed = verdict.kind !== 'agree' || tsc.outcome.kind !== 'clean' || failed;
    }
    return failed ? 1 : 0;
  },
};

/** tsrs on one project; tsc instead, announced, when tsrs cannot run at all. */
async function checkWithFallback(project, current, say) {
  const first = await check(COMPILERS.tsrs, project, current, true);
  if (first.outcome.kind !== 'broken') return first;
  say(
    `FALLBACK: tsrs could not run (${first.outcome.reason}); checking ${relative(project.config)} with the reference tsc instead.`
  );
  return check(COMPILERS.tsc, project, current, true);
}

/** Print a failed check's label. Returns whether it failed. */
function report(result, say) {
  const failed = result.outcome.kind !== 'clean';
  if (result.outcome.kind === 'broken') say(`BROKEN: ${result.label}: ${result.outcome.reason}`);
  if (failed) say(`FAILED: ${result.label}`);
  return failed;
}

/**
 * Verdict = Agree ⊕ Diverge(lines) for one project's tsrs and tsc results. Both clean, or both
 * with the same diagnostics (order ignored), agree; a broken run never agrees.
 */
export function crossCheck(tsrs, tsc) {
  const entries = (result) => (result.outcome.kind === 'diagnostics' ? result.outcome.entries : []);
  const broken = [tsrs, tsc]
    .filter((result) => result.outcome.kind === 'broken')
    .map((result) => `${result.label} could not run: ${result.outcome.reason}`);
  if (broken.length > 0) return { kind: 'diverge', lines: broken };
  const compared = compareDiagnostics(entries(tsrs), entries(tsc));
  return compared.kind === 'same'
    ? { kind: 'agree', lines: entries(tsc) }
    : {
        kind: 'diverge',
        lines: [
          ...compared.onlyLeft.map((entry) => `only tsrs: ${entry}`),
          ...compared.onlyRight.map((entry) => `only tsc:  ${entry}`),
        ],
      };
}

/** `shared` builds first: the projects check against its emitted types. */
async function runTypecheck(mode, current, say) {
  const build = await runNode([at('shared', 'scripts', 'build.mjs')], current, true);
  if (build.signal || current.interrupted) return 130;
  if (build.code !== 0) {
    say('FAILED: shared build');
    return build.code;
  }
  return MODES[mode](current, say);
}

/** `--reference` / `--cross-check` pick a mode; no flag is the default; anything else is an error. */
export function parseArgs(argv) {
  const modes = { '': 'default', '--reference': 'reference', '--cross-check': 'cross-check' };
  const flag = argv.join(' ');
  if (argv.length <= 1 && flag in modes) return { mode: modes[flag] };
  throw new Error(`usage: node tools/typecheck.mjs [--reference | --cross-check]; got ${flag}`);
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

// --- running under the lock ------------------------------------------------------------------

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

/**
 * Run `body(current)` holding the machine-wide lock. `current` carries the running child (so a
 * signal reaches it), whether a signal arrived, and the transcript of everything printed.
 * `pnpm check` (tools/check.mjs) holds the same lock for its Biome and typecheck parts.
 */
export async function withLock(name, body) {
  const log = (line) => process.stderr.write(`[${name}] ${line}\n`);
  const startedAt = Date.now();
  const current = { child: null, interrupted: false, transcript: [], startedAt };
  const interrupt = (signal) => {
    current.interrupted = true;
    current.child?.kill(signal);
  };
  const release = await acquireLock(LOCK_FILE, log);
  // Only once the lock is held: a signal while waiting keeps its default (exit; nothing held).
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, interrupt);
  try {
    return await body(current);
  } finally {
    release();
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, interrupt);
  }
}

/**
 * One typecheck in `mode`, inside a held lock: reuse the result of a run that finished while this
 * one waited (same checkout, same mode, unchanged tree), or run and record. Resolves the exit code.
 */
export async function typecheckUnderLock(mode, current) {
  const say = (line) => {
    process.stderr.write(`[typecheck] ${line}\n`);
    current.transcript.push(`[typecheck] ${line}\n`);
  };
  const before = fingerprint();
  const previous = readResult();
  if (
    previous.kind === 'finished' &&
    previous.mode === mode &&
    previous.finishedAt >= current.startedAt &&
    previous.fingerprint === before
  ) {
    process.stdout.write(previous.output);
    say(`reused the result of PID ${previous.pid}, which finished while this one waited`);
    return previous.code;
  }
  const from = current.transcript.length;
  const code = await runTypecheck(mode, current, say);
  // A tree that changed mid-run makes the result describe no single tree: record nothing.
  if (code !== 130 && fingerprint() === before) {
    writeResult({
      kind: 'finished',
      mode,
      pid: process.pid,
      finishedAt: Date.now(),
      fingerprint: before,
      code,
      output: current.transcript.slice(from).join(''),
    });
  }
  return code;
}

// realpath: import.meta.url is resolved through symlinks (macOS /var -> /private/var), argv is not.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { mode } = parseArgs(process.argv.slice(2));
  process.exitCode = await withLock('typecheck', (current) => typecheckUnderLock(mode, current));
}
