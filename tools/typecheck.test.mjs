import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const typescript = realpathSync(path.join(repositoryRoot, 'shared', 'node_modules', 'typescript'));
const tsrs = realpathSync(path.join(repositoryRoot, 'node_modules', 'tsrs'));

// A checkout shaped like this one: the real tools/typecheck.mjs, real TypeScript projects, and a
// stand-in shared build that records when it ran and takes long enough for two runs to collide.
function checkout(t, { withTsrs = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'typecheck-single-flight-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  mkdirSync(path.join(root, 'tools', 'lib'), { recursive: true });
  for (const file of ['tools/typecheck.mjs', 'tools/lib/tsc.mjs', 'tools/lib/diagnostics.mjs']) {
    copyFileSync(path.join(repositoryRoot, file), path.join(root, file));
  }
  // Ignored like the real checkout's outputs: `tsc -b` writes build info beside its configs.
  write('.gitignore', 'node_modules\n*.tsbuildinfo\nruns.log\n');
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
  const project = { compilerOptions: { strict: true, noEmit: true, types: [] }, include: ['src'] };
  for (const directory of ['server', 'client', 'vendor/agent-cli-tool']) {
    write(`${directory}/src/index.ts`, 'export const value: number = 1;\n');
    mkdirSync(path.join(root, directory, 'node_modules'), { recursive: true });
    symlinkSync(typescript, path.join(root, directory, 'node_modules', 'typescript'), 'dir');
  }
  write('server/tsconfig.test.json', JSON.stringify(project));
  write('vendor/agent-cli-tool/tsconfig.json', JSON.stringify(project));
  write('client/tsconfig.app.json', JSON.stringify(project));
  write('client/tsconfig.test.json', JSON.stringify(project));
  write('client/tsconfig.node.json', JSON.stringify(project));
  write(
    'client/tsconfig.json',
    JSON.stringify({ files: [], references: [{ path: './tsconfig.app.json' }] })
  );
  write('node_modules/.modules.yaml', 'installed\n');
  if (withTsrs) symlinkSync(tsrs, path.join(root, 'node_modules', 'tsrs'), 'dir');
  const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(git('init', '-q').status, 0);
  // Outside the tree, as the real lock is (the temp directory): a lock inside it changes it.
  return { root, lock: path.join(root, 'node_modules', 'typecheck.lock.json') };
}

function typecheck({ root, lock }) {
  const child = spawn(process.execPath, [path.join(root, 'tools', 'typecheck.mjs')], {
    cwd: root,
    env: { ...process.env, UNLEASHD_TYPECHECK_LOCK: lock },
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  return new Promise((resolve) => {
    child.once('close', (code) => resolve({ pid: child.pid, code, output }));
  });
}

/** The shared-build intervals each typecheck process ran, by pid. */
function runs(root) {
  const intervals = new Map();
  for (const line of readFileSync(path.join(root, 'runs.log'), 'utf8').trim().split('\n')) {
    const [event, pid, at] = line.split(' ');
    const interval = intervals.get(pid) ?? {};
    interval[event] = Number(at);
    intervals.set(pid, interval);
  }
  return [...intervals.entries()].map(([pid, interval]) => ({ pid: Number(pid), ...interval }));
}

// 2026-11-10: concurrent agents' typechecks ran side by side and contended for the machine.
test('two typechecks started at once never overlap, and the waiter reuses the result', async (t) => {
  const fixture = checkout(t);
  const [first, second] = await Promise.all([typecheck(fixture), typecheck(fixture)]);
  assert.equal(first.code, 0, first.output);
  assert.equal(second.code, 0, second.output);
  const ran = runs(fixture.root);
  assert.equal(ran.length, 1, JSON.stringify(ran));
  const waiter = [first, second].find(({ pid }) => pid !== ran[0].pid);
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
  writeFileSync(
    path.join(fixture.root, 'server/src/index.ts'),
    "export const value: number = 'x';\n"
  );
  const failing = await typecheck(fixture);
  assert.notEqual(failing.code, 0);
  assert.match(failing.output, /error TS2322/);
  assert.match(failing.output, /FAILED: tsc -p server\/tsconfig\.test\.json/);
});

test('with tsrs installed the default typecheck runs tsrs, with no fallback', async (t) => {
  const fixture = checkout(t);
  writeFileSync(
    path.join(fixture.root, 'client/src/index.ts'),
    "export const value: number = 'x';\n"
  );
  const result = await typecheck(fixture);
  assert.notEqual(result.code, 0);
  assert.match(result.output, /FAILED: tsrs -p client\/tsconfig\.app\.json/);
  assert.doesNotMatch(result.output, /FALLBACK/);
});
