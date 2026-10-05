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
