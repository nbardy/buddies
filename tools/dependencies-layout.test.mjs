// Browser-boundary guard: the dependency window was a wide board with status
// text wrapping onto inconsistent columns and controls below the phone fold.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { openSession } from './lib/headless-chrome.mjs';

test('built dependency dialog stays compact, aligned, and actionable on both screens', async () => {
  const app = express();
  let installState = false;
  app.get('/api/dependencies', (_req, res) =>
    res.json({
      checks: installState
        ? ['rust', 'claude', 'codex'].map((id) => ({
            id,
            status: 'missing',
            message: 'Not installed',
          }))
        : [
            { id: 'rust', status: 'ready', message: 'Available' },
            { id: 'claude', status: 'failed', failure: 'quota', message: 'Usage limit' },
            { id: 'codex', status: 'ready', message: 'Answered Yes' },
          ],
    })
  );
  app.use(express.static(path.resolve('client/dist')));
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  let session;
  try {
    session = await openSession({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      token: null,
      clockMs: Date.now(),
    });
    for (const viewport of [
      { width: 1440, height: 1000, mobile: false, deviceScaleFactor: 1 },
      { width: 390, height: 844, mobile: true, deviceScaleFactor: 1 },
    ]) {
      await session.setViewport(viewport);
      await session.goto(`http://127.0.0.1:${server.address().port}/`, 700);
      const geometry = await session.evaluate(`(() => {
        const dialog = document.querySelector('dialog');
        const rect = dialog.getBoundingClientRect();
        return {width: rect.width, centerX: rect.x + rect.width / 2,
          centerY: rect.y + rect.height / 2,
          names: [...dialog.querySelectorAll('section strong')].map(e => e.getBoundingClientRect().x),
          footerBottom: dialog.querySelector('footer').getBoundingClientRect().bottom};
      })()`);
      assert.ok(geometry.width <= 430, 'dialog must remain compact');
      assert.ok(Math.abs(geometry.centerX - viewport.width / 2) < 2);
      assert.ok(Math.abs(geometry.centerY - viewport.height / 2) < 2);
      assert.equal(geometry.names.length, 3);
      assert.ok(
        geometry.names.every((x) => Math.abs(x - geometry.names[0]) < 1),
        'provider labels share a text column'
      );
      assert.ok(geometry.footerBottom < viewport.height, 'actions stay visible');
    }
    installState = true;
    await session.goto(`http://127.0.0.1:${server.address().port}/`, 700);
    await session.click('button[aria-label="Copy Install Rust / Cargo command"]');
    await session.evaluate('new Promise(resolve => setTimeout(resolve, 300))');
    assert.equal(
      await session.evaluate(
        'document.querySelector("button[aria-label*="Install Rust"]").textContent'
      ),
      'Copied'
    );
    assert.ok(
      await session.evaluate(
        'document.querySelector("dialog footer").getBoundingClientRect().bottom < innerHeight'
      )
    );
    await session.click('button[aria-label="Close dependency checks"]');
    assert.equal(await session.evaluate('document.querySelector("dialog") === null'), true);
  } finally {
    await session?.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
