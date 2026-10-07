#!/usr/bin/env node
// Managed checkout is editable; published runtimes are immutable. Nothing here opens app stores.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { smokeRuntime, stageRuntime } from './desktop-runtime.mjs';
import { reconcileSource } from './desktop-source-git.mjs';
import { writeSourceStatus } from './desktop-source-status.mjs';

export { selectedRuntime } from './desktop-selection.mjs';

// Pattern: one-write-path (docs/patterns.md#one-write-path)
export async function publishRuntime({
  home,
  bundle,
  source,
  run,
  stage = stageRuntime,
  smoke = smokeRuntime,
}) {
  const dirty = run('git', ['status', '--porcelain'], {
    cwd: source,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (dirty.trim())
    throw new Error('Commit local source changes before publishing a desktop runtime.');
  const revision = run('git', ['rev-parse', 'HEAD'], {
    cwd: source,
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
  const runtimes = path.join(home, 'runtimes');
  fs.mkdirSync(runtimes, { recursive: true });
  const runtime = path.join(runtimes, `${revision}-${randomUUID()}`);
  const pending = `${runtime}.pending`;
  try {
    await stage(source, pending, path.join(bundle, 'node', 'bin', 'node'), run);
    await smoke(pending);
    fs.renameSync(pending, runtime);
    const temporary = path.join(home, `active-runtime.${randomUUID()}.tmp`);
    fs.writeFileSync(
      temporary,
      JSON.stringify({
        runtime,
        source,
        revision,
        bundleRevision: fs.existsSync(path.join(bundle, 'source.json'))
          ? JSON.parse(fs.readFileSync(path.join(bundle, 'source.json'), 'utf8')).revision
          : null,
      }),
      { mode: 0o600 }
    );
    fs.renameSync(temporary, path.join(home, 'active-runtime.json'));
    console.log(
      `Verified ${revision}. Reopen Buddies to use this build. Previous runtime retained.`
    );
    return runtime;
  } finally {
    fs.rmSync(pending, { recursive: true, force: true });
  }
}

async function buildSource({ home, bundle, publishOnly = false, run: execute, stage, smoke }) {
  const progress = (phase) =>
    writeSourceStatus(home, { kind: 'preparing', pid: process.pid, phase });
  const source = path.join(home, 'source');
  const node = path.join(bundle, 'node', 'bin', 'node');
  const toolchain = path.join(home, 'toolchain');
  const env = {
    ...process.env,
    PATH: [
      path.join(toolchain, 'node_modules', '.bin'),
      path.dirname(node),
      path.join(process.env.HOME || '', '.cargo', 'bin'),
      process.env.PATH || '',
    ].join(path.delimiter),
    GIT_TERMINAL_PROMPT: '0',
    UNLEASHD_SOURCE_BUILDS: '1',
    UNLEASHD_INSTALL_RUST_DIRECT: '1',
  };
  // Packaged servers use production mode, but source builds need devDependencies.
  // Guard: desktop-source-install regression starts from a production-only install.
  env.NODE_ENV = undefined;
  const run =
    execute ||
    ((command, args, options = {}) =>
      execFileSync(command, args, {
        cwd: source,
        env,
        stdio: 'inherit',
        timeout: 30 * 60_000,
        ...options,
      }));
  // OS Git (including Apple's first-use command-line-tools requirement) must work before cloning.
  progress('Checking Git and build tools');
  run('git', ['--version'], { cwd: home, timeout: 15_000 });
  if (!publishOnly) {
    const metadata = JSON.parse(fs.readFileSync(path.join(bundle, 'source.json'), 'utf8'));
    if (!fs.existsSync(path.join(source, '.git'))) {
      const temporary = path.join(home, `source-${randomUUID()}.pending`);
      try {
        progress('Cloning Buddies');
        console.log('Cloning the managed Buddies checkout…');
        run('git', ['clone', '--recursive', metadata.repository, temporary], { cwd: home });
        // Start from exactly the bundled release, never silently downgrade to origin/main.
        run('git', ['checkout', '-B', 'desktop', metadata.revision], { cwd: temporary });
        run('git', ['submodule', 'update', '--init', '--recursive'], { cwd: temporary });
        fs.renameSync(temporary, source);
      } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
      }
    }
  }
  progress('Reconciling source submodules');
  reconcileSource(source, run);
  const pnpm = path.join(toolchain, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
  if (!fs.existsSync(pnpm)) {
    progress('Installing pnpm');
    console.log('Installing pnpm 9.15.0 in the app toolchain…');
    run(
      node,
      [
        path.join(bundle, 'node', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        'install',
        '--prefix',
        toolchain,
        '--no-audit',
        '--no-fund',
        'pnpm@9.15.0',
      ],
      { cwd: home }
    );
  }
  // Preflight owns Rust setup. Never launch an agent CLI to install it from the desktop helper.
  progress('Installing dependencies and Rust');
  console.log('Installing source dependencies and building (Rust may need first-time setup)…');
  // A non-TTY purge prompt can exit 0 without reinstalling a failed production install.
  run('pnpm', ['install', '--frozen-lockfile', '--config.confirmModulesPurge=false']);
  // A fresh clone has no CLI/shared dist yet; build establishes those before test typecheck.
  progress('Building the update');
  run('pnpm', ['build']);
  progress('Checking the build');
  run('pnpm', ['typecheck']);
  progress('Verifying the staged runtime');
  const runtime = await publishRuntime({ home, bundle, source, run, stage, smoke });
  const active = JSON.parse(fs.readFileSync(path.join(home, 'active-runtime.json'), 'utf8'));
  writeSourceStatus(home, {
    kind: 'ready',
    runtime,
    revision: active.revision,
    bundleRevision: active.bundleRevision,
  });
  return runtime;
}

// Serialize first-run setup and explicit publishing, including a reopened app while setup runs.
// Pattern: one-write-path (docs/patterns.md#one-write-path)
export async function prepareSource(options) {
  const lock = path.join(options.home, 'source-update.lock');
  const owner = path.join(lock, 'owner');
  try {
    fs.mkdirSync(lock);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = fs.existsSync(owner) ? Number(fs.readFileSync(owner, 'utf8')) : 0;
    let alive = false;
    if (pid > 0) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (error) {
        alive = error.code !== 'ESRCH';
      }
    }
    if (alive || (!pid && Date.now() - fs.statSync(lock).mtimeMs < 10_000)) {
      throw new Error('A source update is already running; see source-update.log.');
    }
    // A dead owner cannot still be compiling. A crash resumes from the checkout,
    // while active-runtime.json continues to name the last completed smoke.
    fs.rmSync(lock, { recursive: true, force: true });
    fs.mkdirSync(lock);
  }
  fs.writeFileSync(owner, String(process.pid));
  try {
    return await buildSource(options);
  } catch (error) {
    writeSourceStatus(options.home, {
      kind: 'failed',
      message: String(error.message || error).slice(0, 800),
    });
    throw error;
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const home = process.env.BUDDIES_MANAGED_HOME;
  const bundle = process.env.BUDDIES_MANAGED_BUNDLE;
  if (!home || !bundle)
    throw new Error('Run this command from the Buddies desktop app environment.');
  prepareSource({ home, bundle, publishOnly: process.argv.includes('--publish') }).catch(
    (error) => {
      console.error(
        `Source update failed; previous runtime remains selected: ${error.stack || error}`
      );
      process.exitCode = 1;
    }
  );
}
