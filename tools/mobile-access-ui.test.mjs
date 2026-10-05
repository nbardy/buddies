// Regression: a 404 check looked like an endless Tailscale search in Setup.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { openSession } from './lib/headless-chrome.mjs';

test('mobile check stops loading on 404 and recovers on retry', async () => {
  const app = express();
  let status = 404;
  app.get('/api/mobile-access', (_req, res) =>
    res.status(status).json({ kind: 'tailscale_missing' })
  );
  app.get('/api/dependencies', (_req, res) =>
    res.json({
      checks: ['rust', 'claude', 'codex'].map((id) => ({
        id,
        status: 'ready',
        message: 'Available',
      })),
    })
  );
  app.get('/api/buddies/overview', (_req, res) => res.json([]));
  app.use(express.static(path.resolve('client/dist')));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const out = path.resolve('output/tailscale-check-2026-10-05');
  await mkdir(out, { recursive: true });
  let session;
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    session = await openSession({ baseUrl, token: null, clockMs: Date.now() });
    await session.setViewport({ width: 1440, height: 1000, mobile: false, deviceScaleFactor: 1 });
    await session.goto(`${baseUrl}/`, 700);
    await session.click('dialog.dependencies-dialog footer button:last-child');
    const waitFor = (text) =>
      session.evaluate(`new Promise((resolve, reject) => {
      const deadline = performance.now() + 5000;
      const poll = () => document.getElementById('connect-mobile')?.textContent.includes(${JSON.stringify(text)})
        ? resolve() : performance.now() > deadline ? reject(new Error('Mobile check did not settle')) : setTimeout(poll, 20);
      poll();
    })`);
    await waitFor('Check failed');
    assert.ok(
      await session.evaluate(
        `document.getElementById('connect-mobile').textContent.includes('after the backend reloads')`
      )
    );
    assert.equal(
      await session.evaluate(
        `/Looking for Tailscale|Checking…/.test(document.getElementById('connect-mobile').textContent)`
      ),
      false
    );
    await session.capture(path.join(out, 'failed@desktop.png'));
    status = 200;
    await session.evaluate(`document.querySelector('#connect-mobile button').click()`);
    await waitFor('Needs Tailscale');
    assert.equal(
      await session.evaluate(
        `document.getElementById('connect-mobile').textContent.includes('Could not load')`
      ),
      false
    );
    await session.capture(path.join(out, 'recovered@desktop.png'));
  } finally {
    await session?.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
