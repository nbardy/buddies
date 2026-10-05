import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDependencyChecks } from '../../server/src/providers/dependencies';
import { resolveLoginPath } from '../src/main/login-path';

// Regression: a Finder-launched app (PATH=/usr/bin:/bin:…) reported Codex "missing" because
// it lives in ~/.bun/bin, a directory the server did not append (2026-10-05). Everything
// here crosses real boundaries: a real login-shell child process and the real dependency
// probe spawning real executables.
const FINDER_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-path-'));
  const bunBin = path.join(home, '.bun', 'bin');
  // A directory NO list of well-known locations would contain.
  const exotic = path.join(home, 'opt', 'weird-manager', 'shims');
  for (const dir of [bunBin, exotic]) await fs.mkdir(dir, { recursive: true });
  const agent = (dir: string, name: string) =>
    fs.writeFile(path.join(dir, name), '#!/bin/sh\necho Yes\n', { mode: 0o755 });
  await agent(exotic, 'claude');
  await agent(bunBin, 'codex');
  // Stand-in for the user's zsh: prints an rc-file banner like a real one, then exposes the
  // agent dirs the way ~/.zshrc would, and runs the -c command. Records the flags it got.
  const shell = path.join(home, 'fake-zsh');
  await fs.writeFile(
    shell,
    `#!/bin/sh\necho "welcome banner from .zshrc"\necho "$1" > "${home}/flags"\nPATH="${exotic}:${bunBin}:$PATH"\nexec /bin/sh -c "$2"\n`,
    { mode: 0o755 }
  );
  return { home, shell, bunBin };
}

test('agents in ~/.bun/bin and an unlisted directory are found through the login-shell PATH, and Rust is not required', async () => {
  const { home, shell } = await fixture();
  const finderEnv = { PATH: FINDER_PATH, SHELL: shell };
  try {
    // Without the fix: the inherited Finder PATH finds neither agent.
    const before = createDependencyChecks(
      { PATH: FINDER_PATH, HOME: home, UNLEASHD_SOURCE_BUILDS: '0' },
      1500
    );
    await before.refresh();
    before.close();
    assert.deepEqual(
      before.snapshot().checks.map((c) => `${c.id}:${c.status}`),
      ['claude:missing', 'codex:missing']
    );

    const login = await resolveLoginPath(finderEnv, home);
    assert.equal(login.kind, 'login-shell');
    assert.match(await fs.readFile(path.join(home, 'flags'), 'utf8'), /^-ilc/);
    assert.ok(login.path.endsWith(FINDER_PATH), 'inherited PATH is kept');

    const env = { PATH: login.path, HOME: home, UNLEASHD_SOURCE_BUILDS: '0' };
    const checks = createDependencyChecks(env, 1500);
    await checks.refresh();
    checks.close();
    assert.deepEqual(
      checks.snapshot().checks.map((c) => `${c.id}:${c.status}`),
      ['claude:ready', 'codex:ready']
    );
    // Spawn parity: the server mutates and then hands this same PATH to real turns.
    assert.equal(
      env.PATH.split(path.delimiter)[0],
      path.join(home, 'opt', 'weird-manager', 'shims')
    );
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('a login shell that fails is a typed fallback carrying the well-known dirs, never a silent success', async () => {
  const { home, bunBin } = await fixture();
  const broken = path.join(home, 'broken-zsh');
  await fs.writeFile(broken, '#!/bin/sh\nexit 3\n', { mode: 0o755 });
  try {
    const login = await resolveLoginPath({ PATH: FINDER_PATH, SHELL: broken }, home);
    assert.equal(login.kind, 'fallback');
    assert.match(login.kind === 'fallback' ? login.reason : '', /failed/);
    assert.ok(login.path.split(path.delimiter).includes(bunBin));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test('a hanging login shell is killed at the timeout', async () => {
  const { home } = await fixture();
  const hang = path.join(home, 'hang-zsh');
  await fs.writeFile(hang, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  try {
    const started = Date.now();
    const login = await resolveLoginPath({ PATH: FINDER_PATH, SHELL: hang }, home, 300);
    assert.equal(login.kind, 'fallback');
    assert.ok(Date.now() - started < 5000);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});
