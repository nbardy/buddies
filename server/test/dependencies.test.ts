import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { type Dependencies, DependenciesSchema } from '@unleashd/shared';
import express from 'express';
import { createDependencyChecks, registerDependencyRoutes } from '../src/providers/dependencies';
import { installedAgent } from '../src/providers/installed-agent';

// Two budgets, never one. A probe that should SUCCEED gets a load-tolerant budget: the full
// server suite runs these real /bin/sh fixtures beside other lanes, and at load 35 on 10 cores
// (f1011d0 rerun, 2026-10-08) a 1.5 s budget timed out rustc (read as missing) and claude's
// "Yes" (read as failed). Only the hang assertion keeps a short budget, on its own instance,
// so load can only make that assertion more true. Production keeps its 45 s default.
const READY_BUDGET_MS = 30_000;
const HANG_BUDGET_MS = 1_500;

test('readiness requires a successful Yes, missing and hanging agents remain actionable', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deps-test-'));
  const executable = async (name: string, body: string) =>
    fs.writeFile(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const checks = createDependencyChecks({ PATH: dir, HOME: dir, CLAUDECODE: '1' }, READY_BUDGET_MS);
  const hanging = createDependencyChecks({ PATH: dir, HOME: dir }, HANG_BUDGET_MS);
  const app = express();
  registerDependencyRoutes(app, checks);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await checks.refresh();
  try {
    await executable('rustc', 'echo rustc');
    await executable('cargo', 'echo cargo');
    await executable('claude', '[ -z "$CLAUDECODE" ] || exit 1; echo Yes');
    await checks.refresh();
    const snapshot: Pick<Dependencies, 'checks'> = DependenciesSchema.parse(
      await (await fetch(`${url}/api/dependencies`)).json()
    );
    assert.deepEqual(
      snapshot.checks.map((c) => c.status),
      ['ready', 'ready', 'missing']
    );
    await executable('codex', 'echo Yes; exit 1');
    const first = checks.refresh();
    assert.equal(checks.refresh(), first, 'parallel refreshes share one probe');
    await first;
    assert.equal(
      checks.snapshot().checks[2].status,
      'failed',
      'Yes on a failed process is not ready'
    );
    await executable('codex', 'echo Yes');
    assert.equal((await fetch(`${url}/api/dependencies/check`, { method: 'POST' })).status, 202);
    await checks.refresh();
    assert.equal(checks.snapshot().checks[2].status, 'ready');
    await executable('claude', '/bin/sleep 10');
    const hangStarted = Date.now();
    await hanging.refresh();
    assert.match(hanging.snapshot().checks[1].message, /no response within/i);
    assert.ok(Date.now() - hangStarted < 10_000, 'a hanging probe is cut off, not awaited');
    await executable('claude', 'echo "Weekly limit reached" >&2; exit 1');
    await checks.refresh();
    assert.equal(checks.snapshot().checks[1].failure, 'quota');
    assert.match(checks.snapshot().checks[1].message, /Installed.*usage limit/);
    await executable('claude', 'echo yesterday');
    await checks.refresh();
    assert.equal(checks.snapshot().checks[1].status, 'failed', 'substring yes is not a response');
  } finally {
    checks.close();
    hanging.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('first boot installs missing tools once; every restart checks login without reinstalling', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deps-boot-'));
  const bin = path.join(dir, 'bin');
  const setup = path.join(dir, 'setup');
  await fs.mkdir(bin);
  const executable = async (name: string, body: string) =>
    fs.writeFile(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  // Installers are executable fixtures; the service still traverses the real
  // process/filesystem boundary, including discovery of newly installed binaries.
  await executable(
    'brew',
    `if [ "$1" = '--version' ]; then echo brew; exit; fi
    echo brew >> "$HOME/attempts"
    /bin/cat > "$HOME/bin/rustc" <<'SCRIPT'
#!/bin/sh
echo rustc
SCRIPT
    /bin/cp "$HOME/bin/rustc" "$HOME/bin/cargo"
    /bin/chmod +x "$HOME/bin/rustc" "$HOME/bin/cargo"`
  );
  await executable(
    'curl',
    `echo curl >> "$HOME/attempts"\nwhile [ "$1" != '--output' ]; do shift; done\nshift\necho fixture > "$1"`
  );
  await executable(
    'bash',
    `echo bash >> "$HOME/attempts"\n/bin/mkdir -p "$HOME/.local/bin"\n/bin/cat > "$HOME/.local/bin/claude" <<'SCRIPT'\n#!/bin/sh\nif [ "$1" = '--version' ]; then echo claude; exit; fi\necho probe >> "$HOME/probes"\necho 'Not logged in' >&2\nexit 1\nSCRIPT\n/bin/chmod +x "$HOME/.local/bin/claude"`
  );
  await executable(
    'npm',
    `echo npm >> "$HOME/attempts"\n/bin/mkdir -p "$HOME/.local/bin"\n/bin/cat > "$HOME/.local/bin/codex" <<'SCRIPT'\n#!/bin/sh\nif [ "$1" = '--version' ]; then echo codex; exit; fi\necho probe >> "$HOME/probes"\necho Yes\nSCRIPT\n/bin/chmod +x "$HOME/.local/bin/codex"`
  );
  const env = { PATH: bin, HOME: dir };
  const first = createDependencyChecks(env, READY_BUDGET_MS, setup, READY_BUDGET_MS);
  const restarted = createDependencyChecks(env, READY_BUDGET_MS, setup, READY_BUDGET_MS);
  try {
    await first.refresh();
    assert.deepEqual(
      first.snapshot().checks.map((c) => c.status),
      ['ready', 'failed', 'ready']
    );
    assert.equal(first.snapshot().checks[1].failure, 'login');
    assert.match(execFileSync('codex', ['--version'], { env, encoding: 'utf8' }), /codex/);
    const attempts = await fs.readFile(path.join(dir, 'attempts'), 'utf8');
    assert.deepEqual(attempts.trim().split('\n').sort(), ['bash', 'brew', 'curl', 'npm']);
    await restarted.refresh();
    assert.equal(restarted.snapshot().checks[1].failure, 'login');
    assert.equal(await fs.readFile(path.join(dir, 'attempts'), 'utf8'), attempts);
    assert.equal(
      (await fs.readFile(path.join(dir, 'probes'), 'utf8')).trim().split('\n').length,
      4
    );
    // An installed tool disappearing later is actionable, never an automatic reinstall.
    await fs.unlink(path.join(dir, '.local/bin/codex'));
    await restarted.refresh();
    assert.equal(restarted.snapshot().checks[2].status, 'missing');
    assert.equal(await fs.readFile(path.join(dir, 'attempts'), 'utf8'), attempts);
  } finally {
    first.close();
    restarted.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// Regression (2026-10-05): every test that booted the real backend on a temp HOME was "first
// boot" and installed rustup/codex/claude into it (466 MB each, detached, outliving the test), so
// $TMPDIR filled the disk. UNLEASHD_AUTO_INSTALL=0 must probe without running ANY installer.
test('auto-install off: missing tools are reported, no installer runs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deps-noinstall-'));
  const bin = path.join(dir, 'bin');
  await fs.mkdir(bin);
  for (const name of ['brew', 'curl', 'npm', 'bash'])
    await fs.writeFile(
      path.join(bin, name),
      `#!/bin/sh\necho ${name} >> "$HOME/attempts"\nexit 1\n`,
      {
        mode: 0o755,
      }
    );
  const env = { PATH: bin, HOME: dir, UNLEASHD_AUTO_INSTALL: '0' };
  const checks = createDependencyChecks(
    env,
    READY_BUDGET_MS,
    path.join(dir, 'setup'),
    READY_BUDGET_MS
  );
  try {
    await checks.refresh();
    assert.deepEqual(
      checks.snapshot().checks.map((c) => c.status),
      ['missing', 'missing', 'missing']
    );
    await assert.rejects(fs.readFile(path.join(dir, 'attempts'), 'utf8'), { code: 'ENOENT' });
  } finally {
    checks.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// Fresh-install trial 2026-10-05: with only Claude installed, an unpinned Buddy spawned the
// hardcoded Codex (ENOENT). The agent is read from the real PATH on every request, so a
// first-boot install that lands after startup is picked up without a restart, and a file that
// is not executable (a half-written download) does not count.
test('the installed agent follows PATH on every read: none, then claude, then codex first', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'installed-agent-'));
  const env = { PATH: `${path.join(dir, 'absent')}${path.delimiter}${dir}`, HOME: dir };
  const app = express();
  const checks = createDependencyChecks({ ...env }, READY_BUDGET_MS);
  registerDependencyRoutes(app, checks, () => installedAgent(env));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const agent = async () =>
    DependenciesSchema.parse(await (await fetch(`${url}/api/dependencies`)).json()).agent;
  try {
    assert.deepEqual(await agent(), { kind: 'none' });
    await fs.writeFile(path.join(dir, 'codex'), '#!/bin/sh\n', { mode: 0o644 });
    assert.deepEqual(await agent(), { kind: 'none' }, 'a non-executable file is not installed');
    await fs.writeFile(path.join(dir, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
    assert.deepEqual(await agent(), { kind: 'agent', provider: 'claude' });
    await fs.chmod(path.join(dir, 'codex'), 0o755);
    // Both installed: Codex, the pre-existing fallback, so an install with both keeps its agent.
    assert.deepEqual(await agent(), { kind: 'agent', provider: 'codex' });
  } finally {
    checks.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
