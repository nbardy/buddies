import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { gates } from '../src/expedition/gates';

// Bug caught: an authoring replacement silently invalidates the owner's existing plan files.
for (const file of fs
  .readdirSync(path.resolve(__dirname, '../../docs/expeditions/examples'))
  .filter((f) => f.endsWith('.ts'))) {
  test(`gates: ${file}`, async () => {
    const result = await gates(path.resolve(__dirname, '../../docs/expeditions/examples', file));
    assert.ok(result.preview.firstWave.length);
    assert.ok(result.contract.leader.startsWith('buddy:'));
  });
}
