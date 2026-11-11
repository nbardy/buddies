#!/usr/bin/env node
// `pnpm check [--fresh] [--timings] [paths...]`: the one check to run while iterating. Biome
// (lint + format check, on the given paths, or the whole repo without any) and the default
// typecheck (tsrs, every project) run AT ONCE inside the typecheck's machine-wide lock, so
// parallel agents queue instead of stacking. Biome prints live; the typecheck's output is held
// until Biome finishes, so the two never interleave. Ends with one summary line per part and its
// wall time. Exit code: the first failure's. `pnpm lint` and `pnpm typecheck` still run alone.
// `node tools/check.mjs` skips pnpm's own ~0.5 s startup.
import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { liveOutput, parseArgs, typecheckUnderLock, withLock } from './typecheck.mjs';

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
    current.children.add(child);
    child.once('error', () => {
      current.children.delete(child);
      resolve(1);
    });
    child.once('close', (code, signal) => {
      current.children.delete(child);
      resolve(signal ? 130 : code);
    });
  });
}

async function timed(name, run) {
  const started = performance.now();
  const code = await run();
  return { name, code, seconds: (performance.now() - started) / 1000 };
}

/**
 * Paths are relative to where `pnpm check` was typed (pnpm runs scripts from the root and records
 * the typing directory as INIT_CWD). An INIT_CWD outside this checkout belongs to an outer pnpm
 * that started this one (a test fixture under `pnpm test:tools`): Biome then aborted with "path is
 * expected to be under the root" (2026-11-11), so only an INIT_CWD inside the checkout counts.
 */
export function biomePaths(argv, initCwd = process.env.INIT_CWD) {
  const inside = initCwd !== undefined && !path.relative(repositoryRoot, initCwd).startsWith('..');
  const base = inside ? initCwd : process.cwd();
  return argv.length === 0 ? ['.'] : argv.map((file) => path.resolve(base, file));
}

/** Hold everything written through `current` until `release()`, then print it and go live. */
function holdOutput(current) {
  const held = [];
  current.output = (stream, text) => held.push([stream, text]);
  return () => {
    for (const [stream, text] of held) liveOutput(stream, text);
    current.output = liveOutput;
  };
}

export async function main(argv) {
  const flags = argv.filter((arg) => arg.startsWith('--'));
  const paths = biomePaths(argv.filter((arg) => !arg.startsWith('--')));
  const options = parseArgs(flags);
  return withLock('check', async (current) => {
    const release = holdOutput(current);
    const parts = await Promise.all([
      timed('biome', async () => {
        const code = await biome(paths, current);
        release();
        return code;
      }),
      timed('typecheck', () => typecheckUnderLock(options, current)),
    ]);
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
