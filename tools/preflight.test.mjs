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
    []
  );
});

// Exercise install commands with executable fixtures, never the host toolchain.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkDependencies } from './preflight.mjs';

test('missing Rust installs through brew or Claude and verifies the result', () => {
  for (const installer of ['brew', 'claude']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-test-'));
    const write = (name, body) =>
      fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    try {
      const guard =
        installer === 'brew'
          ? '[ "$1" = install ] && [ "$2" = rust ] || exit 1'
          : '[ "$1" = -p ] && [ "$3" = --allowedTools ] && [ "$4" = Bash ] || exit 1';
      write(
        installer,
        `if [ "$1" = --version ]; then exit 0; fi\n${guard}\nfor bin in rustc cargo; do\n/bin/echo '#!/bin/sh' > "$HOME/$bin"\n/bin/echo 'exit 0' >> "$HOME/$bin"\n/bin/chmod +x "$HOME/$bin"\ndone`
      );
      const logs = [];
      checkDependencies({ env: { PATH: dir, HOME: dir }, log: (line) => logs.push(line) });
      assert.ok(
        logs.some((line) =>
          line.includes(installer === 'brew' ? 'brew install rust' : 'Asking Claude')
        )
      );
      assert.ok(logs.some((line) => line.includes('codex is not available')));
      fs.unlinkSync(path.join(dir, 'rustc'));
      write(installer, 'exit 0');
      assert.throws(
        () => checkDependencies({ env: { PATH: dir, HOME: dir }, log: () => {} }),
        /Rust installation did not complete/
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('fresh machines without brew or Claude can build using the official rustup installer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-rustup-'));
  const write = (name, body) =>
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  try {
    write(
      'curl',
      `if [ "$1" = --version ]; then exit 0; fi
      [ "$5" = https://sh.rustup.rs ] || exit 1
      /bin/echo fixture > "$7"`
    );
    write(
      'bash',
      `if [ "$1" = --version ]; then exit 0; fi
      [ "$2" = -y ] && [ "$3" = --profile ] && [ "$4" = minimal ] || exit 1
      /bin/mkdir -p "$HOME/.cargo/bin"
      for bin in rustc cargo; do
        /bin/echo '#!/bin/sh' > "$HOME/.cargo/bin/$bin"
        /bin/echo 'exit 0' >> "$HOME/.cargo/bin/$bin"
        /bin/chmod +x "$HOME/.cargo/bin/$bin"
      done`
    );
    checkDependencies({ env: { PATH: dir, HOME: dir }, log: () => {} });
    assert.ok(fs.existsSync(path.join(dir, '.cargo/bin/rustc')));
    assert.ok(fs.existsSync(path.join(dir, '.cargo/bin/cargo')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
