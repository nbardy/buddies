import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { exec } from '../src/expedition/cambium';
import { command } from '../src/expedition/checks';

// A shared process spawner must not silently truncate a Git diff and call it exact evidence.
test('bounded command output fails; host checks retain their historical output tail', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'expedition-output-'));
  try {
    const alias = `alias.excess=!${JSON.stringify(process.execPath)} -e 'process.stdout.write("x".repeat(17 << 20))'`;
    const bounded = await exec('git', root, ['-c', alias, 'excess']);
    assert.notEqual(bounded.code, 0);
    assert.match(bounded.stderr, /maxBuffer|ENOBUFS|exceeded/);
    const tail = await command(
      `${JSON.stringify(process.execPath)} -e "process.stdout.write('x'.repeat(1048600)+'END')"`,
      root,
      1,
      new AbortController().signal
    );
    assert.equal(tail.code, 0);
    assert.equal(tail.stdout.length, 1 << 20);
    assert.ok(tail.stdout.endsWith('END'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
