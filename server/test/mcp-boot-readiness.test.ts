import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  ask,
  disposeCase,
  eventually,
  fakeClaude,
  fakeExists,
  fakeFile,
  hire,
  killBackend,
  makeBackendCase,
  mcpCall,
  readFake,
  startBackend,
  workspace,
} from './fixtures/adoption-backend';

/**
 * Release blocker 3 (product review of P1, 2026-10-01): a replacement backend's Buddy MCP endpoint
 * listened (initialize) before boot adoption re-registered the adopted turns' grants
 * (loadConversations), so a running agent's tool call in that window got 401, an authorization
 * failure the agent cannot tell from a revoked grant. The endpoint now answers no authorization
 * decision until grant restoration finished (buddies/mcp.ts `grantsReady`).
 *
 * Deterministic: a test-only pause point (lifecycle/test-hooks.ts) holds the replacement exactly
 * between "MCP port listening" and "grants restored" while the test calls the endpoint.
 */

const PORT = 7537;

const FAKE = fakeClaude(String.raw`
async function main(scenario) {
  text('one;');
  mark(scenario + '.midturn', process.pid);
  setInterval(() => {}, 1000);
}
`);

test(
  'an adopted bearer never sees 401 while the replacement backend restores grants',
  { timeout: 180_000 },
  async () => {
    const c = makeBackendCase(PORT, 'mcp-ready', FAKE);
    try {
      await startBackend(c, 'A');
      const ws = await workspace(c, 'ready');
      const worker = await hire(c, ws, 'hold');
      await ask(c, worker, 'hold');
      await eventually(c, () => fakeExists(c, 'hold.midturn'), Boolean, 'mid-turn');
      const tools = JSON.parse(readFake(c, 'hold.tools')) as { url: string; auth: string };
      assert.equal(await mcpCall(tools), 200, 'the grant works on the first backend');
      await killBackend(c);

      fs.writeFileSync(fakeFile(c, 'pause-at-grant-restore'), '');
      const ready = startBackend(c, 'B', { UNLEASHD_TEST_PAUSE_DIR: c.fakeDir });
      // From the replacement's first moment, every call the agent could make: the earliest one the
      // port accepts must not be refused authorization.
      const statuses: string[] = [];
      let probing = true;
      const probe = (async () => {
        while (probing) {
          statuses.push(
            await mcpCall(tools).then(String, (error) => String(error.cause?.code ?? error))
          );
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      })();
      // The replacement is listening and has not restored grants yet: call it now.
      await eventually(c, () => fakeExists(c, 'paused-at-grant-restore'), Boolean, 'B paused');
      const held = mcpCall(tools);
      // Give the endpoint every chance to answer early before restoration is released.
      await new Promise((resolve) => setTimeout(resolve, 500));
      fs.writeFileSync(fakeFile(c, 'release-grant-restore'), '');
      assert.equal(await held, 200, 'a call inside the restore window waits, then succeeds');
      await ready;
      probing = false;
      await probe;
      assert.ok(!statuses.includes('401'), `no 401 during boot: ${statuses.join(',')}`);
      assert.ok(statuses.includes('200'), `the probe reached the endpoint: ${statuses.join(',')}`);
    } finally {
      await disposeCase(c);
    }
  }
);
