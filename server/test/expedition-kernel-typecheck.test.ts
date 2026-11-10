import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { tempDir } from './fixtures/temp';

// Regression guard, 2026-11-10: `zodToJsonSchema(schema)` on a generic zod schema made tsc 5.9
// instantiate zod's whole type graph. Typechecking authoring/index.ts alone ran out of a 4 GB heap
// after 42 s, so `pnpm typecheck` crashed for the whole server and four parallel agents drove the
// machine's load average past 50.
//
// The cause was zod's declarations loaded TWICE: under `moduleResolution: node` (node10) this file's
// `import 'zod'` read zod's .d.cts while zod-to-json-schema's `import 'zod/v3'` read the .d.ts copy,
// and relating two identical-but-distinct type graphs explodes. With the TypeScript 7 configs
// (bundler resolution, exports-aware) both read one copy, and the typed call checks in 0.1 s on
// TS 7 (and in 1.6 s even on TS 5.9 under bundler). Forcing the two copies back under TS 7 with the
// typed call: 10.5M instantiations, 1.36 GB, 21 s and TS2589. The shipped file stays on the untyped
// call (authoring/index.ts), which held at 337k instantiations even with both copies loaded.
//
// TS 7 is a native binary, so a Node heap flag caps nothing. The guard reads tsc's own counters:
// instantiations are deterministic, memory nearly so, neither depends on machine load.
const MAX_INSTANTIATIONS = 2_000_000; // shipped: 336,601; the bad pattern: 10,471,531
const MAX_MEMORY_KB = 600 * 1024; // shipped: ~123 MB; the bad pattern: ~1,355 MB

async function compile(args: string[]): Promise<{ code: number; text: string }> {
  const repositoryRoot = path.resolve(__dirname, '..', '..');
  const { tscLauncher } = await import(
    pathToFileURL(path.join(repositoryRoot, 'tools/lib/tsc.mjs')).href
  );
  const server = path.join(repositoryRoot, 'server');
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [tscLauncher(path.join(server, 'tsconfig.json')), ...args],
      { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ code: error ? 1 : 0, text: `${stdout}${stderr}` })
    );
  });
}

test('the authoring library typechecks alone within a bounded type graph', async () => {
  const server = path.resolve(__dirname, '..');
  const config = path.join(tempDir('kernel-typecheck-'), 'tsconfig.json');
  await writeFile(
    config,
    JSON.stringify({
      extends: path.join(server, 'tsconfig.test.json'),
      // The config lives in a temp dir, so point tsc back at the server's node types.
      compilerOptions: { typeRoots: [path.join(server, 'node_modules/@types')], types: ['node'] },
      include: [],
      files: [path.join(server, 'src/expedition-kernel/authoring/index.ts')],
    })
  );

  const checked = await compile(['--noEmit', '-p', config, '--extendedDiagnostics']);
  assert.equal(checked.code, 0, checked.text.slice(-2000));
  const counter = (name: string) => {
    const match = checked.text.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'));
    assert.ok(match, `tsc printed no "${name}" counter:\n${checked.text.slice(-2000)}`);
    return Number(match[1]);
  };
  assert.ok(counter('Instantiations') < MAX_INSTANTIATIONS, checked.text);
  assert.ok(counter('Memory used') < MAX_MEMORY_KB, checked.text);

  // The precondition of the blow-up: one copy of zod's declarations, never both dialects.
  const listed = await compile(['--noEmit', '-p', config, '--listFilesOnly']);
  const zodTypes = listed.text
    .split('\n')
    .filter((file) => /[\\/]zod[\\/]v3[\\/]types\.d\.c?ts$/.test(file.trim()));
  assert.equal(zodTypes.length, 1, `zod's type graph is loaded more than once:\n${zodTypes.join('\n')}`);
});
