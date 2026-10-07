import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { decideExecutionGate } from '../../server/src/buddies/execution-gate';
import { serverEnv } from '../src/main/server-env';

// Regression (2026-10-05): the copied-store gate disables Buddy execution whenever a store
// path is not the home default, and the app's stores live in Application Support. Without
// the explicit opt-in the packaged app served Buddies that never replied. This runs the
// server's own gate on the exact environment the app spawns the server with.
test('the desktop server env runs Buddies on the app-owned stores', () => {
  const home = path.join(
    os.tmpdir(),
    'desktop-env-home',
    'Library',
    'Application Support',
    'Buddies'
  );
  const env = serverEnv({
    inherited: { HOME: os.homedir() },
    nodeBin: '/Applications/Buddies.app/Contents/Resources/app/payload/node/bin',
    loginPath: '/usr/bin:/bin',
    port: 4567,
    dataDir: path.join(home, 'agent-viewer'),
    buddiesHome: path.join(home, 'buddies'),
  });
  assert.deepEqual(decideExecutionGate(env), { t: 'enabled' });
  // The opt-in is the only thing standing between these paths and a disabled runner.
  const { UNLEASHD_BUDDY_EXECUTION: _, ...withoutOptIn } = env;
  assert.equal(decideExecutionGate(withoutOptIn).t, 'disabled');
});

// The immutable payload is not a checkout. Upstream must work in the managed source,
// and manager turns must inherit both the publishing command and app-local pnpm.
test('managed desktop environment points upstream at source and keeps the stores separate', () => {
  const env = serverEnv({
    inherited: {},
    nodeBin: '/app/node/bin',
    loginPath: '/usr/bin:/bin',
    port: 1234,
    dataDir: '/app-home/agent-viewer',
    buddiesHome: '/app-home/buddies',
    managed: { home: '/app-home', bundle: '/app', source: '/app-home/source' },
  });
  assert.equal(env.UNLEASHD_CHECKOUT_ROOT, '/app-home/source');
  assert.equal(env.BUDDIES_DESKTOP_PUBLISH, '/app/tools/desktop-source.mjs');
  assert.equal(env.BUDDIES_MANAGED_HOME, '/app-home');
  assert.equal(env.PATH, '/app/node/bin:/app-home/toolchain/node_modules/.bin:/usr/bin:/bin');
  assert.equal(env.UNLEASHD_BUDDIES_DB, '/app-home/buddies/buddies-v3.sqlite');
});
