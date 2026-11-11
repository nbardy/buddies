import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sharedBuildInputs, writeBuildStamp } from '../../tools/lib/shared-build-stamp.mjs';
import { tscExecutable } from '../../tools/lib/tsc.mjs';

const sharedRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cacheRoot = path.join(sharedRoot, 'node_modules', '.cache');
const distRoot = path.join(sharedRoot, 'dist');
const lockPath = path.join(cacheRoot, 'build.lock');
// The native compiler, spawned directly (no Node launcher per compile): tools/lib/tsc.mjs.
const { exe: tsc } = await tscExecutable(path.join(sharedRoot, 'package.json'));

async function acquireLock() {
  await mkdir(cacheRoot, { recursive: true });
  const token = randomUUID();
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for shared build lock');
    try {
      const handle = await open(lockPath, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
      await handle.close();
      return async () => {
        try {
          const current = JSON.parse(await readFile(lockPath, 'utf8'));
          if (current.token === token) await rm(lockPath, { force: true });
        } catch {}
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = JSON.parse(await readFile(lockPath, 'utf8'));
        if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('Invalid lock owner');
        try {
          process.kill(owner.pid, 0);
        } catch (checkError) {
          if (checkError.code === 'ESRCH') await rm(lockPath, { force: true });
        }
      } catch {
        // The owner can still be writing its lock. Reclaim only an old partial
        // lock left by a process that died before recording its PID.
        try {
          if (Date.now() - (await stat(lockPath)).mtimeMs > 5_000) {
            await rm(lockPath, { force: true });
          }
        } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function compile(config, outDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(tsc, ['-p', config, '--outDir', outDir], {
      cwd: sharedRoot,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`TypeScript ${config} failed (${signal ?? code})`));
    });
  });
}

async function filesUnder(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory())
      files.push(...(await filesUnder(path.join(directory, entry.name), relative)));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

async function publish(stage) {
  const files = await filesUnder(stage);
  // Add new dependencies before replacing the modules that may import them.
  const added = files.filter((file) => !existsSync(path.join(distRoot, file)));
  const existing = files.filter((file) => existsSync(path.join(distRoot, file)));
  for (const file of [...added, ...existing]) {
    const target = path.join(distRoot, file);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await copyFile(path.join(stage, file), temporary);
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

const release = await acquireLock();
let stage;
try {
  // Digested BEFORE compiling: a source edited mid-build leaves a stamp that no longer matches,
  // so the next typecheck rebuilds (tools/lib/shared-build-stamp.mjs).
  const inputs = sharedBuildInputs(sharedRoot);
  stage = await mkdtemp(path.join(cacheRoot, 'build-'));
  // The two emits are independent (the CJS one writes only under cjs/): run them at once.
  await Promise.all([
    compile('tsconfig.json', stage),
    compile('tsconfig.cjs.json', path.join(stage, 'cjs')),
  ]);
  await mkdir(path.join(stage, 'cjs'), { recursive: true });
  await writeFile(path.join(stage, 'cjs', 'package.json'), '{\n  "type": "commonjs"\n}\n');
  await publish(stage);
  writeBuildStamp(sharedRoot, inputs);
} finally {
  if (stage) await rm(stage, { recursive: true, force: true });
  await release();
}
