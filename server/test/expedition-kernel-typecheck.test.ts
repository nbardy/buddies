import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { tempDir } from './fixtures/temp';

// Regression guard, 2026-11-10: `zodToJsonSchema(schema)` on a generic zod schema made tsc 5.9
// instantiate zod's whole type graph. Typechecking authoring/index.ts alone ran out of a 4 GB heap
// after 42 s, so `pnpm typecheck` crashed for the whole server and four parallel agents drove the
// machine's load average past 50. With the converter called through an untyped signature the file
// checks in about half a second. This runs tsc on that one file under a 1 GB heap: the bad pattern
// cannot fit, the fixed one has room to spare.
test('the authoring library typechecks inside a 1 GB heap', async () => {
  const server = path.resolve(__dirname, '..');
  const config = path.join(tempDir('kernel-typecheck-'), 'tsconfig.json');
  const { writeFile } = await import('node:fs/promises');
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
  const tsc = path.join(server, 'node_modules/typescript/lib/tsc.js');
  const out = await new Promise<{ code: number; text: string }>((resolve) => {
    execFile(
      process.execPath,
      ['--max-old-space-size=1024', tsc, '--noEmit', '-p', config],
      { timeout: 120_000 },
      (error, stdout, stderr) =>
        resolve({ code: error ? 1 : 0, text: `${stdout}${stderr}`.slice(-2000) })
    );
  });
  assert.equal(out.code, 0, out.text);
});
