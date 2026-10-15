#!/usr/bin/env node
// Real-browser regression guard: unopened conversations and routes must cost no startup reads.
import assert from 'node:assert/strict';
import { openSession, resolveAuthToken } from './lib/headless-chrome.mjs';

const mobile = process.argv[3] === 'mobile';
const session = await openSession({
  baseUrl: process.argv[2] ?? 'http://localhost:7489',
  token: resolveAuthToken(),
  clockMs: Date.now(),
  initialPath: '/buddies',
  viewport: {
    width: mobile ? 390 : 1440,
    height: mobile ? 844 : 1000,
    deviceScaleFactor: 1,
    mobile,
  },
});
try {
  // Include the old 3-second idle preload window. The session blocks all remote writes.
  await session.waitForNetworkIdle(3_500, 20_000, /sigil.worker/);
  const paths = session.requestedPaths();
  const histories = paths.filter((p) => /^\/api\/conversations\/[^/]+\/messages$/.test(p));
  const unusedRoutes = paths.filter((p) => /\/swarm\/Swarm(?:Dashboard|Detail|Analytics)/.test(p));
  const directory = await session.evaluate(
    mobile
      ? 'document.querySelector(".mobile-buddies__grid") !== null'
      : 'document.querySelector(".buddies-directory-content") !== null'
  );
  console.log({ historyRequests: histories.length, unusedRoutes: unusedRoutes.length, directory });
  assert.deepEqual(histories, [], 'opening Buddies must not download unopened chat histories');
  assert.ok(directory, 'the Buddies directory must finish loading');
  assert.deepEqual(unusedRoutes, [], 'opening Buddies must not preload swarm pages');
  console.log(
    `route-loading PASS (${mobile ? 'mobile' : 'desktop'}; ${paths.length} paths; no unopened histories or swarm pages)`
  );
} finally {
  await session.close();
}
