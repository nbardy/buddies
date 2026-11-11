import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { GENERATED_INPUTS, PROJECTS, resolveCompilers } from './typecheck.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const typescript = realpathSync(path.join(repositoryRoot, 'shared', 'node_modules', 'typescript'));
const tsrs = realpathSync(path.join(repositoryRoot, 'node_modules', 'tsrs'));
const biome = realpathSync(path.join(repositoryRoot, 'node_modules', '@biomejs', 'biome'));
// The real native tsrs, for a stand-in tsrs package whose version a test controls.
const tsrsBinary = (await resolveCompilers()).tsrs.for();
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * A checkout shaped like this one: the real tools/typecheck.mjs, real TypeScript projects, and a
 * stand-in shared build that records when it ran and takes long enough for two runs to collide.
 * The stand-in writes no build stamp, so every run that is not a reuse runs it: `runs.log` then
 * counts the real runs. `realShared` uses the real shared build (and its stamp) instead, with the
 * server importing shared's emitted types. `fakeTsrsVersion` installs a tsrs package of that
 * version whose resolver returns the real tsrs binary.
 */
function checkout(t, { withTsrs = true, realShared = false, fakeTsrsVersion = null } = {}) {
  // realpath: the runner sees its own root through symlinks (macOS /var -> /private/var).
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'typecheck-single-flight-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  mkdirSync(path.join(root, 'tools', 'lib'), { recursive: true });
  for (const file of [
    'tools/typecheck.mjs',
    'tools/check.mjs',
    'tools/lib/tsc.mjs',
    'tools/lib/diagnostics.mjs',
    'tools/lib/shared-build-stamp.mjs',
    'biome.json',
  ]) {
    copyFileSync(path.join(repositoryRoot, file), path.join(root, file));
  }
  // Ignored like the real checkout's outputs: `tsc -b` writes build info beside its configs.
  write('.gitignore', 'node_modules\n*.tsbuildinfo\nruns.log\ndist\nfake-*\n');
  const project = { compilerOptions: { strict: true, noEmit: true, types: [] }, include: ['src'] };
  for (const directory of ['shared', 'server', 'client', 'vendor/agent-cli-tool']) {
    write(`${directory}/src/index.ts`, 'export const value: number = 1;\n');
    mkdirSync(path.join(root, directory, 'node_modules'), { recursive: true });
    symlinkSync(typescript, path.join(root, directory, 'node_modules', 'typescript'), 'dir');
  }
  if (realShared) {
    for (const file of ['scripts/build.mjs', 'tsconfig.json', 'tsconfig.cjs.json']) {
      mkdirSync(path.dirname(path.join(root, 'shared', file)), { recursive: true });
      copyFileSync(path.join(repositoryRoot, 'shared', file), path.join(root, 'shared', file));
    }
    write('shared/package.json', JSON.stringify({ name: 'fixture-shared', type: 'module' }));
    write(
      'server/tsconfig.test.json',
      JSON.stringify({
        compilerOptions: {
          ...project.compilerOptions,
          module: 'esnext',
          moduleResolution: 'bundler',
        },
        include: ['src'],
      })
    );
    write(
      'server/src/index.ts',
      "import { value } from '../../shared/dist/index.js';\nexport const n: number = value;\n"
    );
  } else {
    write(
      'shared/scripts/build.mjs',
      `import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const log = new URL('../../runs.log', import.meta.url);
appendFileSync(log, \`start \${process.ppid} \${Date.now()}\\n\`);
await new Promise((resolve) => setTimeout(resolve, 1500));
// The tree changes under this run when asked to: its result then describes no single tree.
if (existsSync(new URL('../../touch-during-build', import.meta.url))) {
  writeFileSync(new URL('../../server/src/added.ts', import.meta.url), 'export {};\\n');
}
appendFileSync(log, \`end \${process.ppid} \${Date.now()}\\n\`);
`
    );
    write('shared/tsconfig.json', JSON.stringify(project));
    write('server/tsconfig.test.json', JSON.stringify(project));
  }
  write('vendor/agent-cli-tool/tsconfig.json', JSON.stringify(project));
  write('client/tsconfig.app.json', JSON.stringify(project));
  write('client/tsconfig.test.json', JSON.stringify(project));
  write('client/tsconfig.node.json', JSON.stringify(project));
  write(
    'client/tsconfig.json',
    JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }] })
  );
  write('node_modules/.modules.yaml', 'installed\n');
  if (fakeTsrsVersion) {
    write(
      'node_modules/tsrs/lib/getExePath.js',
      `export default () => ${JSON.stringify(tsrsBinary.exe)};\n`
    );
    setFakeTsrsVersion(root, fakeTsrsVersion);
  } else if (withTsrs) {
    symlinkSync(tsrs, path.join(root, 'node_modules', 'tsrs'), 'dir');
  }
  mkdirSync(path.join(root, 'node_modules', '@biomejs'));
  symlinkSync(biome, path.join(root, 'node_modules', '@biomejs', 'biome'), 'dir');
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(git('init', '-q').status, 0);
  // Outside the tree, as the real lock is (the temp directory): a lock inside it changes it.
  return { root, lock: path.join(root, 'node_modules', 'typecheck.lock.json') };
}

function setFakeTsrsVersion(root, version) {
  writeFileSync(
    path.join(root, 'node_modules', 'tsrs', 'package.json'),
    JSON.stringify({ name: 'tsrs', version, type: 'module' })
  );
}

/**
 * A stand-in tsrs binary (through `TSRS_BINARY`, which tsrs's own resolver honours): it logs
 * `start`/`end <config> <ms> <pid>`, sleeps (the shared project longest, so it finishes last),
 * and prints `checked <config>`.
 */
function fakeTsrs(root, { ms, sharedMs = ms }) {
  const file = path.join(root, 'fake-tsrs.cjs');
  writeFileSync(
    file,
    `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const config = process.argv[process.argv.indexOf('-p') + 1];
const log = ${JSON.stringify(path.join(root, 'fake-tsrs.log'))};
appendFileSync(log, \`start \${config} \${Date.now()} \${process.pid}\\n\`);
setTimeout(() => {
  appendFileSync(log, \`end \${config} \${Date.now()} \${process.pid}\\n\`);
  process.stdout.write(\`checked \${config}\\n\`);
}, config.includes('shared') ? ${sharedMs} : ${ms});
`
  );
  chmodSync(file, 0o755);
  return { TSRS_BINARY: file };
}

function fakeTsrsLog(root) {
  const file = path.join(root, 'fake-tsrs.log');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const [event, config, at, pid] = line.split(' ');
      return { event, config, at: Number(at), pid: Number(pid) };
    });
}

function start({ root, lock }, script = ['tools/typecheck.mjs'], env = {}) {
  const [entry, ...args] = script;
  const child = spawn(process.execPath, [path.join(root, entry), ...args], {
    cwd: root,
    env: { ...process.env, UNLEASHD_TYPECHECK_LOCK: lock, ...env },
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const done = new Promise((resolve) => {
    child.once('close', (code) => resolve({ pid: child.pid, code, output }));
  });
  return { child, done };
}

const typecheck = (fixture, script, env) => start(fixture, script, env).done;

/** The shared-build intervals each typecheck process ran, by pid. */
function runs(root) {
  const file = path.join(root, 'runs.log');
  if (!existsSync(file)) return [];
  const intervals = new Map();
  for (const line of readFileSync(file, 'utf8').trim().split('\n')) {
    const [event, pid, at] = line.split(' ');
    const interval = intervals.get(pid) ?? {};
    interval[event] = Number(at);
    intervals.set(pid, interval);
  }
  return [...intervals.entries()].map(([pid, interval]) => ({ pid, ...interval }));
}

const edit = (fixture, file, text) => writeFileSync(path.join(fixture.root, file), text);

// 2026-11-10: concurrent agents' typechecks ran side by side and contended for the machine.
test('two typechecks started at once never overlap, and the waiter reuses the result', async (t) => {
  const fixture = checkout(t);
  const [first, second] = await Promise.all([typecheck(fixture), typecheck(fixture)]);
  assert.equal(first.code, 0, first.output);
  assert.equal(second.code, 0, second.output);
  const ran = runs(fixture.root);
  assert.equal(ran.length, 1, JSON.stringify(ran));
  const waiter = [first, second].find(({ pid }) => String(pid) !== ran[0].pid);
  assert.match(waiter.output, /waiting for the typecheck of PID \d+/);
  assert.match(waiter.output, /reused the result of PID \d+/);
  assert.equal(existsSync(fixture.lock), false);
});

test('a typecheck whose tree changed while it waited runs after the first, never beside it', async (t) => {
  const fixture = checkout(t);
  writeFileSync(path.join(fixture.root, 'touch-during-build'), '');
  const results = await Promise.all([typecheck(fixture), typecheck(fixture)]);
  for (const result of results) assert.equal(result.code, 0, result.output);
  const [earlier, later] = runs(fixture.root).sort((a, b) => a.start - b.start);
  assert.ok(later, 'both typechecks ran');
  assert.ok(later.start >= earlier.end, JSON.stringify({ earlier, later }));
});

test('a lock left by a dead process is reclaimed', async (t) => {
  const fixture = checkout(t);
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
    encoding: 'utf8',
  });
  writeFileSync(
    fixture.lock,
    JSON.stringify({ pid: Number(dead.stdout), root: '/elsewhere', startedAt: Date.now() })
  );
  const result = await typecheck(fixture);
  assert.equal(result.code, 0, result.output);
  assert.equal(runs(fixture.root).length, 1);
});

// 2026-11-11: tsrs (experimental) became the default checker. When it cannot run at all (here: not
// installed), every project is checked by the reference tsc instead, and the output says so with
// the reason. A silent fallback would hide that the fast path is gone; no fallback would block
// every typecheck on a tool problem.
test('without tsrs the typecheck falls back to tsc, loudly, and still checks', async (t) => {
  const fixture = checkout(t, { withTsrs: false });
  const passing = await typecheck(fixture);
  assert.equal(passing.code, 0, passing.output);
  assert.match(
    passing.output,
    /FALLBACK: tsrs could not run \(Cannot find module 'tsrs\/package\.json'/
  );
  edit(fixture, 'server/src/index.ts', "export const value: number = 'x';\n");
  const failing = await typecheck(fixture);
  assert.notEqual(failing.code, 0);
  assert.match(failing.output, /error TS2322/);
  assert.match(failing.output, /FAILED: tsc -p server\/tsconfig\.test\.json/);
});

test('with tsrs installed the default typecheck runs tsrs, with no fallback', async (t) => {
  const fixture = checkout(t);
  edit(fixture, 'client/src/index.ts', "export const value: number = 'x';\n");
  const result = await typecheck(fixture);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /FAILED: tsrs -p client\/tsconfig\.app\.json/);
  assert.doesNotMatch(result.output, /FALLBACK/);
});

// 2026-11-11: the six projects ran one after another (~1.4 s for ~0.6 s of compiler time). They
// now run at once; their output must still read as a sequential run's, in project order.
test('the projects run at once, yet print in project order', async (t) => {
  const fixture = checkout(t);
  const env = fakeTsrs(fixture.root, { ms: 300, sharedMs: 900 });
  const result = await typecheck(fixture, undefined, env);
  assert.equal(result.code, 0, result.output);
  const log = fakeTsrsLog(fixture.root);
  const starts = log.filter((entry) => entry.event === 'start');
  const ends = log.filter((entry) => entry.event === 'end');
  assert.equal(starts.length, 6, JSON.stringify(log));
  // Every check started before the first one ended: they overlapped.
  assert.ok(
    Math.max(...starts.map((entry) => entry.at)) < Math.min(...ends.map((entry) => entry.at)),
    JSON.stringify(log)
  );
  // shared finished last, but is printed first.
  assert.equal(ends.at(-1).config, path.join(fixture.root, 'shared', 'tsconfig.json'));
  const printed = [...result.output.matchAll(/^checked (.+)$/gm)].map((match) =>
    path.relative(fixture.root, match[1])
  );
  assert.deepEqual(printed, [
    'shared/tsconfig.json',
    'server/tsconfig.test.json',
    'client/tsconfig.app.json',
    'client/tsconfig.node.json',
    'client/tsconfig.test.json',
    'vendor/agent-cli-tool/tsconfig.json',
  ]);
});

test('an interrupt while the projects run stops every checker', async (t) => {
  const fixture = checkout(t);
  const env = fakeTsrs(fixture.root, { ms: 60_000 });
  const run = start(fixture, undefined, env);
  while (fakeTsrsLog(fixture.root).length < 6) await sleep(50);
  const interrupted = Date.now();
  run.child.kill('SIGINT');
  const result = await run.done;
  assert.equal(result.code, 130, result.output);
  // Promptly: a runner that only waited for its checkers would take their full 60 s.
  assert.ok(Date.now() - interrupted < 10_000, `${Date.now() - interrupted} ms`);
  for (const { pid } of fakeTsrsLog(fixture.root)) {
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `checker ${pid} still running`);
  }
});

// The point of the reuse: an unchanged tree is answered in ~0.1 s instead of re-checked. It must
// print the same answer, including a failure, never "clean" for a broken tree.
test('an unchanged tree is answered from the recorded result, word for word', async (t) => {
  const fixture = checkout(t);
  edit(fixture, 'server/src/index.ts', "export const value: number = 'x';\n");
  const first = await typecheck(fixture);
  assert.notEqual(first.code, 0);
  const second = await typecheck(fixture);
  assert.equal(runs(fixture.root).length, 1, 'the second run checked nothing');
  assert.equal(second.code, first.code);
  assert.match(second.output, /reused the result of PID \d+ from \d+s ago/);
  const diagnostics = (output) => output.split('\n').filter((line) => /error TS|FAILED/.test(line));
  assert.deepEqual(diagnostics(second.output), diagnostics(first.output));
  assert.ok(diagnostics(first.output).length > 0);
});

test('a changed file, or --fresh, runs the compilers again', async (t) => {
  const fixture = checkout(t);
  assert.equal((await typecheck(fixture)).code, 0);
  edit(fixture, 'server/src/index.ts', "export const value: number = 'x';\n");
  const changed = await typecheck(fixture);
  assert.notEqual(changed.code, 0, 'the edit was checked, not answered from the clean result');
  assert.equal(runs(fixture.root).length, 2);
  const fresh = await typecheck(fixture, ['tools/typecheck.mjs', '--fresh']);
  assert.notEqual(fresh.code, 0);
  assert.equal(runs(fixture.root).length, 3);
  assert.doesNotMatch(fresh.output, /reused/);
});

test('a result recorded by another tsrs version or another runner version is not reused', async (t) => {
  const fixture = checkout(t, { fakeTsrsVersion: '0.0.1-a' });
  // A whole-second mtime, so the edit below can restore it exactly (a native mtime carries
  // nanoseconds that utimes cannot write back).
  const runner = path.join(fixture.root, 'tools', 'lib', 'diagnostics.mjs');
  utimesSync(runner, 1_000_000_000, 1_000_000_000);
  assert.equal((await typecheck(fixture)).code, 0);
  assert.equal((await typecheck(fixture)).code, 0);
  assert.equal(runs(fixture.root).length, 1, 'the same version reuses');
  setFakeTsrsVersion(fixture.root, '0.0.1-b');
  assert.equal((await typecheck(fixture)).code, 0);
  assert.equal(runs(fixture.root).length, 2, 'another tsrs version runs again');
  // The runner's own source, changed with its size and mtime kept: the tree fingerprint cannot see
  // it, only the runner version in the key can.
  const size = statSync(runner).size;
  writeFileSync(runner, readFileSync(runner, 'utf8').replace('// What', '// Whaz'));
  utimesSync(runner, 1_000_000_000, 1_000_000_000);
  assert.equal(statSync(runner).size, size);
  assert.equal((await typecheck(fixture)).code, 0);
  assert.equal(runs(fixture.root).length, 3, 'another runner version runs again');
});

// The build is skipped when its stamp matches (tools/lib/shared-build-stamp.mjs). A stale
// `shared/dist` would check the server against the old shared types: here the edit makes `value`
// a string, so a stale dist would PASS a broken tree.
test('a changed shared source is rebuilt before the projects check; an unchanged one is not', async (t) => {
  const fixture = checkout(t, { realShared: true });
  const first = await typecheck(fixture);
  assert.equal(first.code, 0, first.output);
  edit(fixture, 'shared/src/index.ts', "export const value: string = 'x';\n");
  const changed = await typecheck(fixture, ['tools/typecheck.mjs', '--timings']);
  assert.notEqual(changed.code, 0, changed.output);
  assert.match(changed.output, /shared build \(inputs changed\)/);
  assert.match(changed.output, /server\/src\/index\.ts.*error TS2322/);
  const emitted = path.join(fixture.root, 'shared', 'dist', 'index.d.ts');
  const built = statSync(emitted).mtimeMs;
  // The server follows shared's new type: only a server file changed, so no rebuild.
  edit(
    fixture,
    'server/src/index.ts',
    "import { value } from '../../shared/dist/index.js';\nexport const n: string = value;\n"
  );
  const serverOnly = await typecheck(fixture, ['tools/typecheck.mjs', '--timings']);
  assert.equal(serverOnly.code, 0, serverOnly.output);
  assert.match(serverOnly.output, /shared build skipped/);
  assert.equal(statSync(emitted).mtimeMs, built, 'shared/dist was not rewritten');
});

// `pnpm check` (Biome + the default typecheck) holds the same lock as `pnpm typecheck`, so an
// agent's check and another's typecheck queue instead of stacking (2026-11-11).
test('pnpm check and pnpm typecheck started at once never overlap', async (t) => {
  const fixture = checkout(t);
  const [checked, typechecked] = await Promise.all([
    typecheck(fixture, ['tools/check.mjs', 'tools/typecheck.mjs']),
    typecheck(fixture),
  ]);
  assert.equal(checked.code, 0, checked.output);
  assert.equal(typechecked.code, 0, typechecked.output);
  assert.match(checked.output, /\[check\] {3}biome +ok/);
  const ran = runs(fixture.root).sort((a, b) => a.start - b.start);
  for (let i = 1; i < ran.length; i++)
    assert.ok(ran[i].start >= ran[i - 1].end, JSON.stringify(ran));
  assert.match(`${checked.output}${typechecked.output}`, /waiting for the typecheck of PID \d+/);
});

/** A stand-in Biome (through `BIOME_BINARY`, which Biome's launcher honours) that logs its run. */
function fakeBiome(root, exitCode) {
  const file = path.join(root, 'fake-biome.cjs');
  writeFileSync(
    file,
    `#!${process.execPath}
const { appendFileSync } = require('node:fs');
const log = ${JSON.stringify(path.join(root, 'runs.log'))};
appendFileSync(log, \`start biome \${Date.now()}\\n\`);
setTimeout(() => {
  appendFileSync(log, \`end biome \${Date.now()}\\n\`);
  process.exit(${exitCode});
}, 1000);
`
  );
  chmodSync(file, 0o755);
  return { BIOME_BINARY: file };
}

// 2026-11-11: Biome (~0.7 s) and the typecheck ran one after the other inside the lock.
test('pnpm check runs Biome and the typecheck at once, and fails when either fails', async (t) => {
  const fixture = checkout(t);
  const passing = await typecheck(fixture, ['tools/check.mjs'], fakeBiome(fixture.root, 0));
  assert.equal(passing.code, 0, passing.output);
  const [biomeRun, build] = [
    runs(fixture.root).find((run) => run.pid === 'biome'),
    runs(fixture.root).find((run) => run.pid !== 'biome'),
  ];
  assert.ok(
    biomeRun.start < build.end && build.start < biomeRun.end,
    JSON.stringify(runs(fixture.root))
  );

  const lintFails = await typecheck(fixture, ['tools/check.mjs'], fakeBiome(fixture.root, 1));
  assert.equal(lintFails.code, 1, lintFails.output);
  assert.match(lintFails.output, /biome +FAILED/);

  edit(fixture, 'server/src/index.ts', "export const value: number = 'x';\n");
  const typeFails = await typecheck(fixture, ['tools/check.mjs'], fakeBiome(fixture.root, 0));
  assert.notEqual(typeFails.code, 0, typeFails.output);
  assert.match(typeFails.output, /typecheck +FAILED/);
});

// The reuse keys on the tree's tracked and unignored files plus GENERATED_INPUTS. A project that
// starts reading another ignored file (a new generated dist) would get stale answers reused
// after that file changes: every in-repo file the real projects read must be covered.
test('every file a project reads is fingerprinted', async () => {
  assert.equal(tsrsBinary.kind, 'native', tsrsBinary.reason);
  const listed = (cwd) =>
    spawnSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd, encoding: 'utf8' })
      .stdout.split('\n')
      .filter(Boolean)
      .map((file) => path.join(cwd, file));
  const covered = new Set([
    ...listed(repositoryRoot),
    ...listed(path.join(repositoryRoot, 'vendor', 'agent-cli-tool')),
  ]);
  const uncovered = new Set();
  for (const project of PROJECTS) {
    const run = spawnSync(tsrsBinary.exe, ['-p', project.config, '--listFilesOnly'], {
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    for (const file of run.stdout.split('\n').filter(Boolean)) {
      const real = realpathSync(file);
      if (!real.startsWith(`${repositoryRoot}${path.sep}`)) continue;
      if (real.split(path.sep).includes('node_modules')) continue;
      if (covered.has(real)) continue;
      if (GENERATED_INPUTS.some((directory) => real.startsWith(`${directory}${path.sep}`)))
        continue;
      uncovered.add(path.relative(repositoryRoot, real));
    }
  }
  assert.deepEqual([...uncovered], []);
});
