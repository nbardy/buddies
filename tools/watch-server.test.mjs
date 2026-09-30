import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  backendExitsFile,
  crateOfSource,
  createBackendRunner,
  esbuildCheck,
} from './watch-server.mjs';

// A stand-in backend: loads a local module and a node_modules package, records
// each boot, and honours the reload request the way the real server does
// (drain, then exit 0).
const BACKEND = `
const fs = require('node:fs');
const local = require('./local.cjs');
const pkg = require('pkg');
const addon = require('./crates/demo/addon.cjs');
fs.appendFileSync('boots.log', JSON.stringify({ pid: process.pid, local: local.value, pkg: pkg.value, addon: addon.value }) + '\\n');
process.on('message', (message) => {
  if (message?.type === 'unleashd:dev-reload') setTimeout(() => process.exit(0), Number(process.env.DRAIN_MS));
});
setInterval(() => {}, 1000);
`;

// The crate's "build" stands in for napi-rs: it compiles src/lib.rs (here, copies
// its number) into the addon the backend loads, and fails on a non-number.
function buildDemoCrate(root, builds) {
  return async (crate) => {
    builds.push(crate);
    const source = readFileSync(path.join(root, 'crates', crate, 'src', 'lib.rs'), 'utf8').trim();
    if (!/^\d+$/.test(source)) return { ok: false, message: `bad source: ${source}` };
    writeFileSync(
      path.join(root, 'crates', crate, 'addon.cjs'),
      `module.exports = { value: ${source} };\n`
    );
    return { ok: true };
  };
}

function fixture(t, { drainMs = 50 } = {}) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'watch-server-')));
  mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(path.join(root, 'crates', 'demo', 'src'), { recursive: true });
  writeFileSync(path.join(root, 'crates', 'demo', 'src', 'lib.rs'), '1\n');
  writeFileSync(path.join(root, 'crates', 'demo', 'addon.cjs'), 'module.exports = { value: 1 };\n');
  // An addon crate is one with a napi package.json; `tool` is a plain Cargo crate (an import CLI).
  writeFileSync(path.join(root, 'crates', 'demo', 'package.json'), '{}');
  mkdirSync(path.join(root, 'crates', 'tool', 'src'), { recursive: true });
  const builds = [];
  const logs = [];
  writeFileSync(path.join(root, 'package.json'), '{}');
  writeFileSync(path.join(root, 'backend.cjs'), BACKEND);
  writeFileSync(path.join(root, 'local.cjs'), 'module.exports = { value: 1 };\n');
  writeFileSync(
    path.join(root, 'node_modules', 'pkg', 'index.js'),
    'module.exports = { value: 1 };\n'
  );
  const runner = createBackendRunner({
    command: process.execPath,
    args: ['backend.cjs'],
    cwd: root,
    // Never the live ~/.agent-viewer: the runner records every exit there.
    env: { UNLEASHD_DATA_DIR: path.join(root, 'data'), DRAIN_MS: String(drainMs) },
    watchRoot: root,
    check: esbuildCheck('backend.cjs', root),
    buildCrate: buildDemoCrate(root, builds),
    settleMs: 100,
    initialBackoffMs: 100,
    log: (line) => logs.push(line),
    logError: (line) => logs.push(line),
  });
  t.after(async () => {
    runner.stop('SIGTERM');
    await runner.stopped;
    rmSync(root, { recursive: true, force: true });
  });
  const boots = () =>
    readFileSync(path.join(root, 'boots.log'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  const exits = () =>
    readFileSync(backendExitsFile({ UNLEASHD_DATA_DIR: path.join(root, 'data') }), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  return { root, runner, boots, builds, logs, exits };
}

async function until(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = predicate();
      if (value) return value;
    } catch {}
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

// macOS starts a recursive fs.watch stream asynchronously and drops writes made
// in its first few milliseconds (measured: 1 in 10 at 0ms, none after 50ms).
// A real backend takes seconds to boot; this fixture boots in milliseconds.
async function firstBoot(boots) {
  await until(() => boots().length === 1);
  await new Promise((resolve) => setTimeout(resolve, 300));
}

test('editing a loaded node_modules package reloads the backend', async (t) => {
  // Regression, 2026-09-23: a vendored package upgrade was invisible to the
  // hand-written watch list and the backend served the old code for hours.
  const { root, runner, boots } = fixture(t);
  runner.start();
  await firstBoot(boots);
  writeFileSync(
    path.join(root, 'node_modules', 'pkg', 'index.js'),
    'module.exports = { value: 2 };\n'
  );
  const [, second] = await until(() => boots().length === 2 && boots());
  assert.equal(second.pkg, 2);
});

test('rewriting loaded files with identical content does not restart the backend', async (t) => {
  // `pnpm typecheck` and `pnpm build` clean-rebuild shared/dist byte-for-byte
  // while dev runs; each rebuild must not cost a backend restart.
  const { root, runner, boots } = fixture(t);
  runner.start();
  await firstBoot(boots);
  const file = path.join(root, 'node_modules', 'pkg', 'index.js');
  rmSync(file);
  writeFileSync(file, 'module.exports = { value: 1 };\n');
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(boots().length, 1);
});

test('truncating then rewriting a loaded file with identical content does not restart', async (t) => {
  // Regression, 2026-09-25: `tsc --watch` truncates each output before writing
  // it. The runner digested the empty intermediate as a change, so the cli
  // watcher's initial (byte-identical) emit restarted the backend mid-startup
  // and every `pnpm dev` loaded the conversation history twice.
  const { root, runner, boots } = fixture(t);
  runner.start();
  await firstBoot(boots);
  const file = path.join(root, 'node_modules', 'pkg', 'index.js');
  writeFileSync(file, '');
  await new Promise((resolve) => setTimeout(resolve, 60));
  writeFileSync(file, 'module.exports = { value: 1 };\n');
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(boots().length, 1);
});

test('code that does not build keeps the current backend until it is fixed', async (t) => {
  const { root, runner, boots } = fixture(t);
  runner.start();
  await firstBoot(boots);
  writeFileSync(path.join(root, 'local.cjs'), 'module.exports = { value: ;\n');
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(boots().length, 1);
  process.kill(boots()[0].pid, 0);
  writeFileSync(path.join(root, 'local.cjs'), 'module.exports = { value: 3 };\n');
  const [, second] = await until(() => boots().length === 2 && boots());
  assert.equal(second.local, 3);
});

test('a backend killed from outside is restarted', async (t) => {
  // Regression, 2026-08-20: `kill <backend-pid>` escalated to fatal and took
  // the whole dev runtime down.
  const { runner, boots } = fixture(t);
  runner.start();
  const [first] = await until(() => boots().length === 1 && boots());
  process.kill(first.pid, 'SIGKILL');
  const [, second] = await until(() => boots().length === 2 && boots());
  assert.notEqual(second.pid, first.pid);
});

test('a backend killed while draining is recorded as a crash with its signal', async (t) => {
  // Regression, 2026-09-30: a native SIGBUS during a drain was logged as
  // "Backend finished its active work" and its code and signal were dropped.
  const { root, runner, boots, logs, exits } = fixture(t, { drainMs: 60_000 });
  runner.start();
  await firstBoot(boots);
  writeFileSync(path.join(root, 'local.cjs'), 'module.exports = { value: 2 };\n');
  await until(() => logs.some((line) => line.startsWith('Source changed')));
  process.kill(boots()[0].pid, 'SIGKILL');
  await until(() => boots().length === 2);
  const [exit] = exits();
  assert.equal(exit.kind, 'crash');
  assert.equal(exit.state, 'draining');
  assert.equal(exit.signal, 'SIGKILL');
  assert.equal(exit.pid, boots()[0].pid);
  assert.ok(
    logs.some((line) => line.startsWith('Backend crashed while draining (signal SIGKILL)'))
  );
});

test('saving a crate source rebuilds its addon, and the new addon reloads the backend', async (t) => {
  // T14b, 2026-09-26: the backend loads crates/<c>/*.node, never the .rs files,
  // so before this a Rust edit reached dev only after a hand-run crate build.
  const { root, runner, boots, builds } = fixture(t);
  runner.start();
  await firstBoot(boots);
  writeFileSync(path.join(root, 'crates', 'demo', 'src', 'lib.rs'), '2\n');
  const [, second] = await until(() => boots().length === 2 && boots());
  assert.equal(second.addon, 2);
  assert.deepEqual(builds, ['demo']);
});

test('saving a source of a non-addon crate builds nothing', async (t) => {
  // S12, 2026-09-26: the import CLIs became their own crates so an importer edit
  // never rebuilds a shipped addon; the watcher must not rebuild them either.
  const { root, runner, boots, builds } = fixture(t);
  runner.start();
  await firstBoot(boots);
  writeFileSync(path.join(root, 'crates', 'tool', 'src', 'main.rs'), '1\n');
  writeFileSync(path.join(root, 'crates', 'demo', 'src', 'lib.rs'), '2\n');
  await until(() => builds.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(builds, ['demo']);
});

test('a crate that does not build keeps the backend and its current addon', async (t) => {
  const { root, runner, boots, builds } = fixture(t);
  runner.start();
  await firstBoot(boots);
  writeFileSync(path.join(root, 'crates', 'demo', 'src', 'lib.rs'), 'syntax error\n');
  await until(() => builds.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(boots().length, 1);
});

test('crateOfSource maps build inputs, not build outputs, to their crate', () => {
  assert.equal(crateOfSource('crates/unleashd-buddies/src/store/post.rs'), 'unleashd-buddies');
  assert.equal(crateOfSource('crates/unleashd-ingest/Cargo.toml'), 'unleashd-ingest');
  // cargo writes .rs under target/ (build scripts); matching it would loop builds forever.
  assert.equal(crateOfSource('crates/target/release/build/x/out/bindings.rs'), null);
  assert.equal(crateOfSource('crates/unleashd-buddies/buddies-core.node'), null);
});
