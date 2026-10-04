#!/usr/bin/env node
// Pattern: build-cache (docs/patterns.md#build-cache)
//
// Makes each napi addon (`crates/<c>/<binaryName>.node` + its generated
// `index.d.ts`) match its sources WITHOUT running rustc when some worktree has
// already built those exact sources. Why: every lane worktree used to cold-build
// both crates (~30 s each, three cores) even when it never touched Rust, and a
// save in the one-time importers rebuilt the shipped addon (S12, 2026-09-26).
//
//   node tools/ensure-addons.mjs [crate ...]     (default: every addon crate)
//
// Key = sha256 of the crate's build inputs: src/**, build.rs, Cargo.toml,
// package.json's `napi` + `scripts.build`, the workspace Cargo.toml minus `members`, the
// Cargo.lock entries the crate can reach, `rustc -vV` (version + host triple),
// CARGO_BUILD_TARGET and RUSTFLAGS. Nothing outside the crate directory is an
// input, so a TS edit or an importer edit (its own crate) never changes a key.
//
// Hit: copy the cached files into the crate (only when they differ; each file
// is renamed into place, never rewritten under a loaded dylib). Miss: build with
// the package script under the build throttle, then publish the output into the
// cache by an atomic directory rename. A lock directory per crate+key keeps
// concurrent worktrees from building the same key twice; a lock whose owner
// process is gone is reclaimed. A plain `pnpm --dir crates/<c> run build` still
// forces a build and bypasses the cache.
import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// rustup installs here even when the calling shell predates its PATH update.
process.env.PATH = `${process.env.PATH ?? ''}${path.delimiter}${path.join(os.homedir(), '.cargo', 'bin')}`;

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Shared by every worktree of this checkout: one addon cache and one cargo target dir.
const BUILD_ROOT = process.env.UNLEASHD_BUILD_ROOT ?? path.join(os.homedir(), '.cache', 'unleashd');
export const DEFAULT_CACHE_ROOT =
  process.env.UNLEASHD_ADDON_CACHE ?? path.join(BUILD_ROOT, '.addon-cache');
const LOCK_POLL_MS = 500;

// --- addons -------------------------------------------------------------------

/** Addon = { crate, dir, outputs }: a crate with a napi package.json. The import CLIs have none. */
export function listAddons(root = repositoryRoot) {
  const crates = path.join(root, 'crates');
  return fs
    .readdirSync(crates)
    .filter((name) => fs.existsSync(path.join(crates, name, 'package.json')))
    .sort()
    .map((crate) => addon(root, crate));
}

function addon(root, crate) {
  const dir = path.join(root, 'crates', crate);
  const binaryName = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).napi
    .binaryName;
  return { crate, dir, outputs: [`${binaryName}.node`, 'index.d.ts'] };
}

// --- the key ------------------------------------------------------------------

export function readToolchain() {
  return execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function filesUnder(dir) {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
}

// Cargo.lock as { "name version" → block text, deps }. A dependency line names a
// package as "name" (unique in the lock) or "name version[ (source)]".
function parseLock(text) {
  return text
    .split('\n[[package]]\n')
    .slice(1)
    .map((block) => ({
      name: /^name = "(.+)"$/m.exec(block)[1],
      version: /^version = "(.+)"$/m.exec(block)[1],
      deps: [
        ...(/^dependencies = \[\n([\s\S]*?)\]/m.exec(block)?.[1] ?? '').matchAll(/"(.+)"/g),
      ].map((m) => m[1].split(' ')),
      block,
    }));
}

/** The lock blocks `crate` can reach (build, dev and normal deps alike: a superset is safe). */
function reachableLock(lockText, crate) {
  const packages = parseLock(lockText);
  const find = ([name, version]) =>
    packages.find((p) => p.name === name && (version === undefined || p.version === version));
  const seen = new Set();
  const stack = [find([crate])];
  while (stack.length > 0) {
    const next = stack.pop();
    if (seen.has(next)) continue;
    seen.add(next);
    for (const dep of next.deps) stack.push(find(dep));
  }
  return [...seen].map((p) => p.block).sort();
}

function napiBuildOf(dir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  return [manifest.napi, manifest.scripts.build];
}

/** The cache key of one addon's build inputs. */
export function addonKey(root, { crate, dir }, toolchain) {
  const workspace = path.join(root, 'crates');
  const parts = [
    ...filesUnder(path.join(dir, 'src')).map((file) => [
      path.relative(dir, file),
      sha256(fs.readFileSync(file)),
    ]),
    ...['build.rs', 'Cargo.toml'].map((name) => [
      name,
      sha256(fs.readFileSync(path.join(dir, name))),
    ]),
    // Only what shapes the output: the napi flags. Editing the `test` script must not miss.
    ['package.json', sha256(JSON.stringify(napiBuildOf(dir)))],
    // `members` lists the tool crates too; editing it changes no addon's output.
    [
      'workspace',
      sha256(
        fs
          .readFileSync(path.join(workspace, 'Cargo.toml'), 'utf8')
          .replace(/^members\s*=\s*\[[^\]]*\]/m, '')
      ),
    ],
    [
      'lock',
      sha256(
        reachableLock(fs.readFileSync(path.join(workspace, 'Cargo.lock'), 'utf8'), crate).join('\n')
      ),
    ],
    ['toolchain', sha256(toolchain)],
    ['target', `${process.env.CARGO_BUILD_TARGET ?? 'host'}|${process.env.RUSTFLAGS ?? ''}`],
  ];
  return sha256(JSON.stringify(parts)).slice(0, 32);
}

// --- lock ---------------------------------------------------------------------

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// Lock = Acquired ⊕ Held (a live owner) ⊕ reclaimed-and-retried (a dead one).
function tryLock(lockDir) {
  try {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner'), String(process.pid));
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  let owner;
  try {
    owner = Number(fs.readFileSync(path.join(lockDir, 'owner'), 'utf8'));
  } catch {
    // Created but not yet stamped: a live owner between two syscalls, unless it is old.
    const age = Date.now() - fs.statSync(lockDir, { throwIfNoEntry: false })?.mtimeMs;
    if (!(age > 10_000)) return false;
    owner = 0;
  }
  if (owner && isAlive(owner)) return false;
  fs.rmSync(lockDir, { recursive: true, force: true });
  return tryLock(lockDir);
}

// --- install / build ----------------------------------------------------------

function sameBytes(a, b) {
  return fs.existsSync(b) && fs.readFileSync(a).equals(fs.readFileSync(b));
}

// Rename, never rewrite in place: overwriting a loaded .node on macOS invalidates
// its code signature and kills the process that has it mapped.
function install(entry, { dir, outputs }) {
  for (const name of outputs) {
    const target = path.join(dir, name);
    if (sameBytes(path.join(entry, name), target)) continue;
    const temporary = `${target}.${process.pid}.tmp`;
    fs.copyFileSync(path.join(entry, name), temporary);
    fs.renameSync(temporary, target);
  }
}

function publish(entry, { dir, outputs }) {
  const temporary = `${entry}.${process.pid}.tmp`;
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.mkdirSync(temporary, { recursive: true });
  for (const name of outputs) fs.copyFileSync(path.join(dir, name), path.join(temporary, name));
  try {
    fs.renameSync(temporary, entry);
  } catch (error) {
    // Another process published the same key first; its bytes are the same build.
    fs.rmSync(temporary, { recursive: true, force: true });
    if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error;
  }
}

function throttledBuild(spawn, { dir }, output) {
  const pnpmScript = process.env.npm_execpath;
  const pnpm = pnpmScript?.includes('pnpm') ? [process.execPath, pnpmScript] : ['pnpm'];
  const env = {
    ...process.env,
    CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? path.join(BUILD_ROOT, '.cargo-target'),
    CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '3',
  };
  return new Promise((resolve) => {
    const child = spawn('nice', ['-n', '15', ...pnpm, '--dir', dir, 'run', 'build'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    const collect = (chunk) => {
      output(chunk);
      tail = (tail + chunk).slice(-8000);
    };
    child.stdout.setEncoding('utf8').on('data', collect);
    child.stderr.setEncoding('utf8').on('data', collect);
    child.once('error', (error) => resolve({ ok: false, message: String(error) }));
    child.once('exit', (code, signal) =>
      resolve(code === 0 ? { ok: true } : { ok: false, message: `exit ${code ?? signal}\n${tail}` })
    );
  });
}

/**
 * Outcome = { kind: 'hit', key, ms } ⊕ { kind: 'built', key, ms } ⊕ { kind: 'failed', key, ms, message }.
 * `spawn` is the only way this reaches cargo; a hit never calls it.
 */
export async function ensureAddon(
  addon,
  {
    root = repositoryRoot,
    cacheRoot = DEFAULT_CACHE_ROOT,
    toolchain = readToolchain(),
    spawn = nodeSpawn,
    output = () => {},
  } = {}
) {
  const started = Date.now();
  const done = (kind, key, extra = {}) => ({ kind, key, ms: Date.now() - started, ...extra });
  const key = addonKey(root, addon, toolchain);
  const entry = path.join(cacheRoot, addon.crate, key);
  const lockDir = `${entry}.lock`;
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  while (!fs.existsSync(entry)) {
    if (!tryLock(lockDir)) {
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
      continue;
    }
    try {
      if (fs.existsSync(entry)) break;
      const result = await throttledBuild(spawn, addon, output);
      if (!result.ok) return done('failed', key, { message: result.message });
      // A save during the build: the output belongs to neither key, so cache nothing.
      if (addonKey(root, addon, toolchain) !== key) return done('built', key);
      publish(entry, addon);
      return done('built', key);
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  }
  install(entry, addon);
  return done('hit', key);
}

export function describe(addon, outcome) {
  const seconds = `${(outcome.ms / 1000).toFixed(2)}s`;
  return `[addons] ${addon.crate} ${outcome.kind === 'hit' ? 'hit ' : 'miss'} ${outcome.key.slice(0, 12)} ${
    outcome.kind === 'failed' ? `build FAILED after ${seconds}` : seconds
  }`;
}

/** The dev watcher's `buildCrate`: (crate) => Promise<{ ok } | { ok: false, message }>. */
export function ensureAddonBuild(root = repositoryRoot, log = (line) => console.log(line)) {
  return async (crate) => {
    const target = addon(root, crate);
    const outcome = await ensureAddon(target, { root });
    log(describe(target, outcome));
    return outcome.kind === 'failed' ? { ok: false, message: outcome.message } : { ok: true };
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const all = listAddons();
  const wanted = process.argv.slice(2);
  const unknown = wanted.filter((crate) => !all.some((a) => a.crate === crate));
  if (unknown.length > 0) throw new Error(`not an addon crate: ${unknown.join(', ')}`);
  const addons = wanted.length === 0 ? all : all.filter((a) => wanted.includes(a.crate));
  const toolchain = readToolchain();
  let failed = false;
  for (const target of addons) {
    const outcome = await ensureAddon(target, {
      toolchain,
      output: (chunk) => process.stderr.write(chunk),
    });
    console.log(describe(target, outcome));
    if (outcome.kind === 'failed') {
      console.error(outcome.message);
      failed = true;
    }
  }
  process.exitCode = failed ? 1 : 0;
}
