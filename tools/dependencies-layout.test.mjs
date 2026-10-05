// Browser-boundary guard: the dependency window was a wide board with status
// text wrapping onto inconsistent columns and controls below the phone fold.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { openSession } from './lib/headless-chrome.mjs';

test('built dependency dialog stays compact, aligned, and actionable on both screens', async () => {
  const app = express();
  let state = 'quota';
  // This preview has no workspace store; return an empty inventory, not an HTTP error.
  app.get('/api/buddies/overview', (_req, res) => res.json([]));
  app.get('/api/dependencies', (_req, res) =>
    res.json({
      checks:
        state === 'missing'
          ? ['rust', 'claude', 'codex'].map((id) => ({
              id,
              status: 'missing',
              message: 'Not installed',
            }))
          : [
              { id: 'rust', status: 'ready', message: 'Available' },
              {
                id: 'claude',
                status: 'failed',
                failure: state === 'login' ? 'login' : 'quota',
                message:
                  state === 'login'
                    ? 'Log in from your terminal, then check again.'
                    : 'Usage limit',
              },
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
    state = 'login';
    const out = path.resolve('output/dependencies-dismissal-2026-10-05');
    await mkdir(out, { recursive: true });
    for (const [name, viewport] of [
      ['desktop', { width: 1440, height: 1000, mobile: false, deviceScaleFactor: 1 }],
      ['phone', { width: 390, height: 844, mobile: true, deviceScaleFactor: 1 }],
    ]) {
      await session.setViewport(viewport);
      await session.goto(`http://127.0.0.1:${server.address().port}/`, 700);
      assert.ok(
        await session.evaluate(
          'document.querySelector("dialog").textContent.includes("Login required")'
        )
      );
      assert.equal(
        await session.evaluate(
          `document.querySelector('input[aria-label="Sign in to Claude Code command"]').value`
        ),
        'claude auth login'
      );
      await session.capture(path.join(out, `login-fixture@${name}.png`));
    }
    state = 'missing';
    await session.goto(`http://127.0.0.1:${server.address().port}/`, 700);
    await session.click('button[aria-label="Copy Install Rust / Cargo command"]');
    await session.evaluate('new Promise(resolve => setTimeout(resolve, 300))');
    assert.equal(
      await session.evaluate('document.querySelector("dialog section button").textContent'),
      'Copied'
    );
    assert.ok(
      await session.evaluate(
        'document.querySelector("dialog footer").getBoundingClientRect().bottom < innerHeight'
      )
    );
    await session.click('button[aria-label="Close dependency checks"]');
    assert.equal(await session.evaluate('document.querySelector("dialog") === null'), true);
    // Reload without goto(): screenshot navigation deliberately clears localStorage.
    // Restarting the fixture server on the same origin must also preserve dismissal.
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    const reload = async () => {
      await session.evaluate('location.reload()');
      await session.evaluate('new Promise(resolve => setTimeout(resolve, 700))');
      assert.equal(await session.evaluate('document.querySelector("dialog") === null'), true);
    };
    const reopen = async () => {
      await session.click('button[title="Settings"]');
      await session.click('.config-menu button:first-child');
      assert.equal(await session.evaluate('document.querySelector("dialog").open'), true);
    };
    await reload();
    await session.capture(path.join(out, 'dismissed-after-restart@phone.png'));
    await reopen();
    await session.capture(path.join(out, 'reopened-from-settings@phone.png'));
    await session.click('dialog footer button:last-child');
    await reload();
    await reopen();
    await session.evaluate('document.querySelector("dialog").dispatchEvent(new Event("cancel"))');
    await reload();
  } finally {
    await session?.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
