// Regression guard: Node 22.5-22.12 passed `engines` but crashed at runtime on node:sqlite.
import assert from 'node:assert/strict';
import test from 'node:test';
import { findProblems } from './preflight.mjs';

const ok = { isGitCheckout: true, submoduleReady: true };

test('Node below the node:sqlite floor is rejected with the fix', () => {
  const [p] = findProblems({ ...ok, nodeVersion: 'v22.12.0' });
  assert.match(p, /too old/);
  assert.match(p, /nvm install/);
});

test('Node at the floor and above passes', () => {
  for (const nodeVersion of ['v22.13.0', 'v22.20.1', 'v24.3.0']) {
    assert.deepEqual(findProblems({ ...ok, nodeVersion }), []);
  }
});

test('a clone without the submodule names the git command', () => {
  const [p] = findProblems({ nodeVersion: 'v24.3.0', isGitCheckout: true, submoduleReady: false });
  assert.match(p, /git submodule update --init --recursive/);
});

test('a tarball install (no .gitmodules) does not demand a submodule', () => {
  assert.deepEqual(
    findProblems({ nodeVersion: 'v24.3.0', isGitCheckout: false, submoduleReady: false }),
    [],
  );
});
