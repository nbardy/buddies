#!/usr/bin/env node
// `pnpm check [paths...]`: the one check to run while iterating. Biome (lint + format check, on
// the given paths, or the whole repo without any) and then the default typecheck (tsrs, every
// project), both inside the typecheck's machine-wide lock, so parallel agents queue instead of
// stacking. Ends with one summary line per part and its wall time. Exit code: the first failure's.
// `pnpm lint` and `pnpm typecheck` still run on their own.
import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { typecheckUnderLock, withLock } from './typecheck.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function biomeLauncher() {
  const manifest = createRequire(path.join(repositoryRoot, 'package.json')).resolve(
    '@biomejs/biome/package.json'
  );
  return path.join(path.dirname(manifest), JSON.parse(readFileSync(manifest, 'utf8')).bin.biome);
}

function biome(paths, current) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [biomeLauncher(), 'check', ...paths], {
      cwd: repositoryRoot,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    current.child = child;
    child.once('error', () => resolve(1));
    child.once('close', (code, signal) => {
      current.child = null;
      resolve(signal ? 130 : code);
    });
  });
}

async function timed(name, run) {
  const started = performance.now();
  const code = await run();
  return { name, code, seconds: (performance.now() - started) / 1000 };
}

/** Paths are relative to where `pnpm check` was typed (pnpm runs scripts from the root). */
export function biomePaths(argv, invokedFrom = process.env.INIT_CWD ?? process.cwd()) {
  return argv.length === 0 ? ['.'] : argv.map((file) => path.resolve(invokedFrom, file));
}

export async function main(argv) {
  const paths = biomePaths(argv);
  return withLock('check', async (current) => {
    const parts = [await timed('biome', () => biome(paths, current))];
    if (!current.interrupted) {
      parts.push(await timed('typecheck', () => typecheckUnderLock('default', current)));
    }
    process.stderr.write('\n[check] summary\n');
    for (const part of parts) {
      const verdict = part.code === 0 ? 'ok    ' : `FAILED (exit ${part.code})`;
      process.stderr.write(
        `[check]   ${part.name.padEnd(10)} ${verdict} ${part.seconds.toFixed(1)}s\n`
      );
    }
    return parts.find((part) => part.code !== 0)?.code ?? 0;
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
