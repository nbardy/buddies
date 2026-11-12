#!/usr/bin/env node
// Pattern: fix-guards (docs/patterns.md#fix-guards)
// `pnpm typecheck` (tsrs, falling back to tsc loudly), `pnpm typecheck:reference` (tsc 7) and
// `pnpm typecheck:cross-check` (both, compared; CI), single-flight across every process on the
// machine. `pnpm check` (tools/check.mjs) shares the lock. Flags: `--fresh` (never reuse a
// recorded result), `--timings` (one line of where the time went). Run it as
// `node tools/typecheck.mjs` to skip pnpm's own ~0.5 s startup.
//
// Why single-flight: concurrent agents each ran their own typecheck at once and the
// typecheckers contended for the machine (owner, 2026-11-10). One lock file in the temp
// directory admits one typecheck at a time, from any checkout.
//
// Why so much is skipped (owner, 2026-11-11: "5-10s for a typecheck still feels pretty slow"):
// the compilers took 84-147 ms per project while a run took 1.4 s direct, 2.0 s through pnpm.
//   - A finished result is recorded under a key (the tree's fingerprint, the generated inputs the
//     projects read, the compilers, this runner's source, the mode). Any run with the same key
//     prints it instead of checking. A run during which the tree changed records nothing.
//   - The shared build (~700 ms) is skipped when its stamp says `shared/dist` is current.
//   - The projects run at once, output buffered and printed in project order.
//   - The compilers run as their native binaries, not through a Node launcher each.
// Guards: tools/typecheck.test.mjs.
//
// This is a CLI tool, never a server event loop, so synchronous fs is fine here.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
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
import { sharedBuildState } from './lib/shared-build-stamp.mjs';
import { nativeOf, tscExecutable } from './lib/tsc.mjs';

const toolsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolsDirectory, '..');
// Machine-wide on purpose: the contention is between checkouts (agent worktrees), not within one.
const LOCK_FILE =
  process.env.UNLEASHD_TYPECHECK_LOCK ?? path.join(os.tmpdir(), 'unleashd-typecheck.lock.json');
const resultFile = (mode) =>
  path.join(repositoryRoot, 'node_modules', '.cache', `typecheck-result-${mode}.json`);
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
export const PROJECTS = [
  // shared also builds with tsc first; checking it here puts its source (the expedition
  // types every package imports) under the tsrs/tsc cross-check too.
  { config: at('shared', 'tsconfig.json'), extra: ['--noEmit'] },
  { config: at('server', 'tsconfig.test.json'), extra: [] },
  { config: at('client', 'tsconfig.app.json'), extra: [] },
  { config: at('client', 'tsconfig.node.json'), extra: [] },
  { config: at('client', 'tsconfig.test.json'), extra: [] },
  { config: at('vendor', 'agent-cli-tool', 'tsconfig.json'), extra: ['--noEmit'] },
];

/**
 * Ignored build outputs the projects read: `@unleashd/shared` and `@nbardy/agent-cli` resolve to
 * their `dist`. The tree fingerprint leaves ignored files out, so these are fingerprinted on
 * their own; a result must never outlive a rebuilt dist. Guard: "every file a project reads is
 * fingerprinted" in tools/typecheck.test.mjs keeps this list complete.
 */
export const GENERATED_INPUTS = [at('shared', 'dist'), at('vendor', 'agent-cli-tool', 'dist')];

// --- compilers ------------------------------------------------------------------------------

/** Resolution = Native({exe, identity}) ⊕ Missing(reason). */
async function resolved(find) {
  try {
    const { exe, version } = await find();
    const stats = statSync(exe);
    return { kind: 'native', exe, identity: `${version} ${exe} ${stats.size}:${stats.mtimeMs}` };
  } catch (error) {
    return { kind: 'missing', reason: error.message.split('\n')[0] };
  }
}

/**
 * Compiler = Tsrs ⊕ Tsc, each resolved once per run to its native binary. tsrs (npm `tsrs`, the
 * Rust port of TypeScript, EXPERIMENTAL) is the default: on 2026-11-10 its diagnostics matched
 * tsc 7.0.2 byte for byte on every project, clean and with four injected errors, at about a third
 * of tsc's memory. Never with tsrs's own `--fast` (modes that may differ from TypeScript). tsc 7
 * (each package's own) is the reference. `TSRS_BINARY` (honoured by tsrs's own resolver) points
 * the default at another tsrs build.
 */
export async function resolveCompilers() {
  const [tsrs, ...tsc] = await Promise.all([
    resolved(() => nativeOf(createRequire(at('package.json')).resolve('tsrs/package.json'))),
    ...PROJECTS.map((project) => resolved(() => tscExecutable(project.config))),
  ]);
  const describe = (resolution) =>
    resolution.kind === 'native' ? resolution.identity : `missing: ${resolution.reason}`;
  return {
    tsrs: { name: 'tsrs', for: () => tsrs },
    tsc: { name: 'tsc', for: (project) => tsc[PROJECTS.indexOf(project)] },
    identity: [`tsrs ${describe(tsrs)}`, ...tsc.map((each) => `tsc ${describe(each)}`)],
  };
}

/** This runner's own source: a result recorded by another version of it is never reused. */
function runnerVersion() {
  const hash = createHash('sha256');
  for (const file of [
    'typecheck.mjs',
    'lib/diagnostics.mjs',
    'lib/tsc.mjs',
    'lib/shared-build-stamp.mjs',
  ]) {
    hash.update(readFileSync(path.join(toolsDirectory, file)));
  }
  return hash.digest('hex');
}

// --- processes ------------------------------------------------------------------------------

/**
 * Run one process with its output captured as ordered `[stream, text]` events (and passed to
 * `onEvent` as it arrives). Every child is in `current.children` while it runs, so an interrupt
 * reaches all of them; none starts after one.
 */
export function runProcess(file, args, current, onEvent = () => {}) {
  return new Promise((resolve) => {
    if (current.interrupted) {
      resolve({ code: null, signal: 'SIGINT', text: '', events: [] });
      return;
    }
    const child = spawn(file, args, { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    current.children.add(child);
    const events = [];
    let text = '';
    for (const stream of ['stdout', 'stderr']) {
      child[stream].on('data', (chunk) => {
        const event = [stream, String(chunk)];
        events.push(event);
        onEvent(event);
        text += event[1];
      });
    }
    child.once('error', (error) => {
      current.children.delete(child);
      resolve({ code: 1, signal: null, text: error.message, events });
    });
    child.once('close', (code, signal) => {
      current.children.delete(child);
      resolve({ code, signal, text, events });
    });
  });
}

/**
 * One compiler on one project: its Outcome (tools/lib/diagnostics.mjs), what it printed, and
 * whether the outcome describes the tree (`transient` when the checker crashed or was killed:
 * such a run is never recorded for reuse).
 */
async function check(compiler, project, current) {
  const label = `${compiler.name} -p ${relative(project.config)}${project.extra.map((a) => ` ${a}`).join('')}`;
  const resolution = compiler.for(project);
  if (resolution.kind === 'missing') {
    return {
      label,
      outcome: { kind: 'broken', reason: resolution.reason },
      events: [],
      transient: false,
    };
  }
  const run = await runProcess(resolution.exe, ['-p', project.config, ...project.extra], current);
  const outcome = outcomeOf(run);
  return { label, outcome, events: run.events, transient: outcome.kind === 'broken' };
}

const sayInto = (events) => (line) => events.push(['stderr', `[typecheck] ${line}\n`]);

/**
 * Mode = Default ⊕ Reference ⊕ CrossCheck: what one project's check is. Each resolves a Report
 * `{ events, failed, transient }`; every project is checked even after one fails, so one run
 * reports every error.
 *   default     tsrs; a project tsrs cannot run (Broken) is checked by tsc instead, and the run
 *               says so in a FALLBACK line with the reason. Never silent.
 *   reference   tsc only.
 *   cross-check both on every project, at once (CI): fails if either fails or their
 *               diagnostics differ.
 */
const MODES = {
  default: async (project, compilers, current) => {
    const events = [];
    const say = sayInto(events);
    const first = await check(compilers.tsrs, project, current);
    events.push(...first.events);
    if (first.outcome.kind !== 'broken' || current.interrupted) {
      return { events, failed: report(first, say), transient: first.transient };
    }
    say(
      `FALLBACK: tsrs could not run (${first.outcome.reason}); checking ${relative(project.config)} with the reference tsc instead.`
    );
    const second = await check(compilers.tsc, project, current);
    events.push(...second.events);
    return {
      events,
      failed: report(second, say),
      transient: first.transient || second.transient,
    };
  },
  reference: async (project, compilers, current) => {
    const result = await check(compilers.tsc, project, current);
    const events = [...result.events];
    return { events, failed: report(result, sayInto(events)), transient: result.transient };
  },
  'cross-check': async (project, compilers, current) => {
    const [tsrs, tsc] = await Promise.all([
      check(compilers.tsrs, project, current),
      check(compilers.tsc, project, current),
    ]);
    const events = [];
    const say = sayInto(events);
    const verdict = crossCheck(tsrs, tsc);
    say(`${verdict.kind === 'agree' ? 'agree' : 'DIVERGE'}: ${relative(project.config)}`);
    for (const line of verdict.lines) say(`  ${line}`);
    return {
      events,
      failed: verdict.kind !== 'agree' || tsc.outcome.kind !== 'clean',
      transient: tsrs.transient || tsc.transient,
    };
  },
};

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

/**
 * Every project at once, each report printed as soon as it and every project before it are
 * done: the transcript is the one a sequential run printed, in project order, whatever order
 * the checks finish in. Resolves `{ code, transient }`.
 */
async function checkProjects(mode, compilers, current, timings) {
  const reports = new Array(PROJECTS.length);
  let printed = 0;
  const flush = () => {
    for (; printed < PROJECTS.length && reports[printed]; printed++) {
      for (const [stream, text] of reports[printed].events) current.write(stream, text);
    }
  };
  // All at once in every mode, unbounded on purpose (2026-11-11, 10 cores / 24 GB, load 12-17):
  // peak RSS default 380 -> 580 MB; reference and cross-check 670 -> ~1.65 GB. Bounding those to 3
  // at once saved ~0.45 GB but took 1.5-3x the wall time, and the machine-wide lock means only one
  // typecheck holds this memory at a time.
  await Promise.all(
    PROJECTS.map(async (project, index) => {
      const started = performance.now();
      reports[index] = await MODES[mode](project, compilers, current);
      timings.push([relative(project.config), performance.now() - started]);
      flush();
    })
  );
  if (current.interrupted) return { code: 130, transient: true };
  return {
    code: reports.some((each) => each.failed) ? 1 : 0,
    transient: reports.some((each) => each.transient),
  };
}

/** `shared` builds first when its stamp is stale: the projects check against its emitted types. */
async function ensureSharedBuild(current, say, timings) {
  const started = performance.now();
  const state = sharedBuildState(at('shared'));
  if (state.kind === 'current') {
    timings.push(['shared build skipped', performance.now() - started]);
    return { kind: 'skipped' };
  }
  const build = await runProcess(
    process.execPath,
    [at('shared', 'scripts', 'build.mjs')],
    current,
    ([stream, text]) => current.write(stream, text)
  );
  timings.push([`shared build (${state.reason})`, performance.now() - started]);
  if (build.signal || current.interrupted) return { kind: 'failed', code: 130 };
  if (build.code !== 0) {
    say('FAILED: shared build');
    return { kind: 'failed', code: build.code };
  }
  return { kind: 'built' };
}

/** Mode flag (at most one) plus `--fresh` and `--timings`; anything else is an error. */
export function parseArgs(argv) {
  const modes = { '--reference': 'reference', '--cross-check': 'cross-check' };
  const options = { mode: 'default', fresh: false, timings: false };
  const usage = () =>
    new Error(
      `usage: node tools/typecheck.mjs [--reference | --cross-check] [--fresh] [--timings]; got ${argv.join(' ')}`
    );
  for (const flag of argv) {
    if (flag === '--fresh') options.fresh = true;
    else if (flag === '--timings') options.timings = true;
    else if (flag in modes && options.mode === 'default') options.mode = modes[flag];
    else throw usage();
  }
  return options;
}

// --- the tree -----------------------------------------------------------------------------

function listFiles(directory) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['ls-files', '-z', '-co', '--exclude-standard'], {
      cwd: directory,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(stdout.split('\0').filter(Boolean));
      else reject(new Error(`git ls-files failed in ${directory}: ${stderr}`));
    });
  });
}

const statLine = (file) => {
  const stats = statSync(file, { throwIfNoEntry: false });
  return stats ? `${stats.size}:${stats.mtimeMs}` : 'missing';
};

function filesUnder(directory) {
  try {
    return readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(entry.parentPath, entry.name))
      .sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

/** The generated inputs (GENERATED_INPUTS), every file by size and mtime. */
function generatedDigest(root) {
  const hash = createHash('sha256');
  for (const directory of GENERATED_INPUTS.map((each) => path.join(root, relative(each)))) {
    for (const file of filesUnder(directory)) hash.update(`${file}\0${statLine(file)}\0`);
  }
  return hash.digest('hex');
}

/**
 * The checkout as the typecheck sees it. `tree`: every tracked or unignored file (the
 * submodule's too) by size and mtime, plus the installed dependency state. `generated`: the
 * ignored build outputs the projects read, kept apart because the typecheck itself may rebuild
 * `shared/dist`. The two `git ls-files` run at once (~13 ms and ~8 ms).
 */
export async function fingerprint(root = repositoryRoot) {
  const submodule = path.join('vendor', 'agent-cli-tool');
  const [own, nested] = await Promise.all([listFiles(root), listFiles(path.join(root, submodule))]);
  const files = [
    ...own,
    ...nested.map((file) => path.join(submodule, file)),
    path.join('node_modules', '.modules.yaml'),
  ].sort();
  const hash = createHash('sha256');
  for (const file of files) hash.update(`${file}\0${statLine(path.join(root, file))}\0`);
  return { tree: hash.digest('hex'), generated: generatedDigest(root) };
}

/** The reuse key: the same tree, generated inputs, compilers, runner and mode, or no reuse. */
function keyOf(mode, print, compilers) {
  return createHash('sha256')
    .update(
      JSON.stringify([mode, print.tree, print.generated, compilers.identity, runnerVersion()])
    )
    .digest('hex');
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

/** Wait until this process holds the lock. Resolves `{ release, waited }`. */
export async function acquireLock(file, log) {
  mkdirSync(path.dirname(file), { recursive: true });
  const record = JSON.stringify({
    pid: process.pid,
    root: repositoryRoot,
    startedAt: Date.now(),
    token: randomUUID(),
  });
  let announced = null;
  // Whether another run held the lock meanwhile (reclaiming a dead one's lock is not waiting).
  let waited = false;
  for (;;) {
    try {
      writeFileSync(file, record, { flag: 'wx' });
      return { release: () => reclaim(file, record), waited };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const holder = readHolder(file);
    const waits = {
      running: () => {
        waited = true;
        if (announced !== holder.pid) {
          log(`waiting for the typecheck of PID ${holder.pid} (${holder.root})`);
          announced = holder.pid;
        }
        return sleep(POLL_MS);
      },
      writing: () => {
        waited = true;
        return sleep(POLL_MS);
      },
      stale: () => reclaim(file, holder.raw),
      gone: () => {},
    };
    await waits[holder.kind]();
  }
}

// --- running under the lock ------------------------------------------------------------------

function readResult(mode) {
  try {
    return JSON.parse(readFileSync(resultFile(mode), 'utf8'));
  } catch {
    return { kind: 'none' };
  }
}

function writeResult(mode, result) {
  const file = resultFile(mode);
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(result));
  renameSync(temporary, file);
}

/** Output straight to this process's streams (tools/check.mjs holds it back while Biome prints). */
export const liveOutput = (stream, text) => process[stream].write(text);

/**
 * Run `body(current, waited)` holding the machine-wide lock. `current` carries the running
 * children (so a signal reaches every one), whether a signal arrived, the output sink and the
 * transcript of everything printed. `pnpm check` holds the same lock.
 */
export async function withLock(name, body) {
  const log = (line) => process.stderr.write(`[${name}] ${line}\n`);
  const current = {
    children: new Set(),
    interrupted: false,
    transcript: [],
    output: liveOutput,
    write(stream, text) {
      current.transcript.push(text);
      current.output(stream, text);
    },
  };
  const interrupt = (signal) => {
    current.interrupted = true;
    for (const child of current.children) child.kill(signal);
  };
  const { release, waited } = await acquireLock(LOCK_FILE, log);
  // Only once the lock is held: a signal while waiting keeps its default (exit; nothing held).
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, interrupt);
  try {
    return await body(current, waited);
  } finally {
    release();
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, interrupt);
  }
}

const ago = (milliseconds) =>
  milliseconds < 120_000
    ? `${Math.round(milliseconds / 1000)}s`
    : `${Math.round(milliseconds / 60_000)}min`;

/** The recorded result for this key, if any; never with `--fresh`. */
function reusable(options, key) {
  const previous = readResult(options.mode);
  return !options.fresh && previous.kind === 'finished' && previous.key === key ? previous : null;
}

function replay(previous, write) {
  write('stdout', previous.output);
  write(
    'stderr',
    `[typecheck] reused the result of PID ${previous.pid} from ${ago(Date.now() - previous.finishedAt)} ago (same tree, mode, compilers and runner; --fresh runs it again)\n`
  );
  return previous.code;
}

function printTimings(options, timings, write) {
  if (!options.timings) return;
  const parts = timings.map(([name, ms]) => `${name} ${Math.round(ms)}ms`);
  write(
    'stderr',
    `[typecheck] timings: ${[...parts, `total since process start ${Math.round(performance.now())}ms`].join(' | ')}\n`
  );
}

/**
 * One typecheck inside a held lock: reuse the recorded result for this key, or run and record.
 * `prior` is what the caller already computed before taking the lock without waiting (a run
 * that waited recomputes: the tree may have changed meanwhile). Resolves the exit code.
 */
export async function typecheckUnderLock(options, current, prior = {}) {
  const { mode } = options;
  const say = (line) => current.write('stderr', `[typecheck] ${line}\n`);
  const timings = prior.timings ?? [];
  let started = performance.now();
  const compilers = prior.compilers ?? (await resolveCompilers());
  const before = prior.print ?? (await fingerprint());
  if (!prior.print) timings.push(['fingerprint under the lock', performance.now() - started]);
  const previous = reusable(options, keyOf(mode, before, compilers));
  if (previous) {
    const code = replay(previous, (stream, text) => current.write(stream, text));
    printTimings(options, timings, current.write);
    return code;
  }
  const from = current.transcript.length;
  const build = await ensureSharedBuild(current, say, timings);
  if (build.kind === 'failed') {
    printTimings(options, timings, current.write);
    return build.code;
  }
  // The generated inputs the projects check against: rebuilt just now, or as fingerprinted.
  const checked = build.kind === 'built' ? generatedDigest(repositoryRoot) : before.generated;
  const result = await checkProjects(mode, compilers, current, timings);
  started = performance.now();
  const after = await fingerprint();
  timings.push(['fingerprint after', performance.now() - started]);
  // A tree that changed mid-run makes the result describe no single tree: record nothing. Nor
  // when a checker crashed or was killed: that says nothing about the tree.
  if (!result.transient && after.tree === before.tree && after.generated === checked) {
    writeResult(mode, {
      kind: 'finished',
      key: keyOf(mode, after, compilers),
      pid: process.pid,
      finishedAt: Date.now(),
      code: result.code,
      output: current.transcript.slice(from).join(''),
    });
  }
  printTimings(options, timings, current.write);
  return result.code;
}

/**
 * `node tools/typecheck.mjs`: answer from the recorded result without the lock when the key
 * matches (it runs no compiler, so it cannot contend), else take the lock and run.
 */
export async function main(argv) {
  const options = parseArgs(argv);
  const timings = [['startup', performance.now()]];
  const started = performance.now();
  const [compilers, print] = await Promise.all([resolveCompilers(), fingerprint()]);
  timings.push(['fingerprint', performance.now() - started]);
  const previous = reusable(options, keyOf(options.mode, print, compilers));
  if (previous) {
    const code = replay(previous, liveOutput);
    printTimings(options, timings, liveOutput);
    return code;
  }
  return withLock('typecheck', (current, waited) =>
    typecheckUnderLock(options, current, waited ? { timings } : { compilers, print, timings })
  );
}

// realpath: import.meta.url is resolved through symlinks (macOS /var -> /private/var), argv is not.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
