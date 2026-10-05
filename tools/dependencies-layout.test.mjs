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
  const workspace = {
    id: 'project_fixture',
    name: 'Empty project',
    rootPath: '/tmp/example',
    createdAt: new Date().toISOString(),
    buddies: [],
    taskCounts: [],
  };
  app.get('/api/buddies/overview', (_req, res) => res.json([workspace]));
  app.get('/api/buddies/workspaces/project_fixture/inbox', (_req, res) =>
    res.json({ requests: [], waitingOn: [], channels: [], unreadThreads: 0 })
  );
  app.get('/api/buddies/workspaces/project_fixture/channels/archived', (_req, res) => res.json([]));
  app.get('/api/buddies/tasks', (_req, res) => res.json([]));
  app.get('/api/buddies/runs', (_req, res) => res.json([]));
  app.get('/api/mobile-access', (_req, res) => res.json({ kind: 'tailscale_missing' }));
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
  app.get('/buddies/workspaces/:id/channels', (_req, res) =>
    res.sendFile(path.resolve('client/dist/index.html'))
  );
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const out = path.resolve('output/onboarding-2026-10-05');
  await mkdir(out, { recursive: true });
  let session;
  try {
    session = await openSession({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      token: null,
      clockMs: Date.now(),
    });
    const waitForTeam = () =>
      session.evaluate(`new Promise((resolve, reject) => {
      const deadline = performance.now() + 5000;
      const poll = () => document.querySelector('dialog textarea') ? resolve() : performance.now() > deadline ? reject(new Error('Team form did not load')) : setTimeout(poll, 20);
      poll();
    })`);
    for (const viewport of [
      { width: 1440, height: 1000, mobile: false, deviceScaleFactor: 1 },
      { width: 390, height: 844, mobile: true, deviceScaleFactor: 1 },
    ]) {
      await session.setViewport(viewport);
      await session.goto(`http://127.0.0.1:${server.address().port}/`, 700);
      assert.ok(
        await session.evaluate(
          'document.querySelector("dialog h2").textContent.includes("Welcome")'
        )
      );
      await session.capture(path.join(out, `welcome@${viewport.mobile ? 'phone' : 'desktop'}.png`));
      await session.click('dialog.dependencies-dialog footer button:last-child');
      const geometry = await session.evaluate(`(() => {
        const dialog = document.querySelector('dialog');
        const rect = dialog.getBoundingClientRect();
        return {width: rect.width, centerX: rect.x + rect.width / 2,
          centerY: rect.y + rect.height / 2,
          names: [...dialog.querySelectorAll('section[aria-label="Rust / Cargo"] strong, section[aria-label="Claude Code"] strong, section[aria-label="Codex"] strong')].map(e => e.getBoundingClientRect().x),
          footerBottom: dialog.querySelector('footer').getBoundingClientRect().bottom};
      })()`);
      assert.ok(
        geometry.width <= 570,
        'dialog stays a centred card (560px, owner widened it 2026-10-05)'
      );
      assert.ok(Math.abs(geometry.centerX - viewport.width / 2) < 2);
      assert.ok(Math.abs(geometry.centerY - viewport.height / 2) < 2);
      assert.equal(geometry.names.length, 3);
      assert.ok(
        geometry.names.every((x) => Math.abs(x - geometry.names[0]) < 1),
        'provider labels share a text column'
      );
      assert.ok(geometry.footerBottom < viewport.height, 'actions stay visible');
      await session.capture(path.join(out, `setup@${viewport.mobile ? 'phone' : 'desktop'}.png`));
      await session.click('dialog.dependencies-dialog footer button:last-child');
      assert.ok(
        await session.evaluate(
          'document.querySelector("dialog h2").textContent.includes("Create your team")'
        )
      );
      await waitForTeam();
      await session.capture(path.join(out, `team@${viewport.mobile ? 'phone' : 'desktop'}.png`));
      await session.click('dialog.dependencies-dialog footer button:first-child');
      assert.ok(
        await session.evaluate('document.querySelector("dialog h2").textContent.includes("Setup")')
      );
    }
    state = 'login';
    for (const [name, viewport] of [
      ['desktop', { width: 1440, height: 1000, mobile: false, deviceScaleFactor: 1 }],
      ['phone', { width: 390, height: 844, mobile: true, deviceScaleFactor: 1 }],
    ]) {
      await session.setViewport(viewport);
      await session.goto(`http://127.0.0.1:${server.address().port}/`, 700);
      await session.click('dialog.dependencies-dialog footer button:last-child');
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
    await session.click('dialog.dependencies-dialog footer button:last-child');
    await session.click('button[aria-label="Copy Install Rust / Cargo command"]');
    await session.evaluate('new Promise(resolve => setTimeout(resolve, 300))');
    assert.equal(
      await session.evaluate('document.querySelector("dialog section button").textContent'),
      'Copied'
    );
    assert.ok(
      await session.evaluate(
        'document.querySelector("dialog.dependencies-dialog footer").getBoundingClientRect().bottom < innerHeight'
      )
    );
    await session.click('button[aria-label="Close dependency checks"]');
    await session.evaluate('new Promise(resolve => setTimeout(resolve, 100))');
    await session.evaluate(
      `[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Got it')?.click()`
    );
    await session.evaluate('new Promise(resolve => setTimeout(resolve, 100))');
    assert.equal(
      await session.evaluate('document.querySelector("dialog.dependencies-dialog") === null'),
      true
    );
    // Reload without goto(): screenshot navigation deliberately clears localStorage.
    // Restarting the fixture server on the same origin must also preserve dismissal.
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    const reload = async () => {
      await session.evaluate('location.reload()');
      await session.evaluate('new Promise(resolve => setTimeout(resolve, 700))');
      await session.evaluate(
        `[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Got it')?.click()`
      );
      await session.evaluate('new Promise(resolve => setTimeout(resolve, 100))');
      assert.equal(
        await session.evaluate('document.querySelector("dialog.dependencies-dialog") === null'),
        true
      );
    };
    const reopen = async () => {
      await session.click('button[title="Settings"]');
      await session.click('.config-menu button:first-child');
      assert.equal(
        await session.evaluate('document.querySelector("dialog.dependencies-dialog").open'),
        true
      );
    };
    await reload();
    await session.capture(path.join(out, 'dismissed-after-restart@phone.png'));
    await reopen();
    await session.capture(path.join(out, 'reopened-from-settings@phone.png'));
    await session.click('dialog.dependencies-dialog footer button:last-child');
    await session.click('dialog.dependencies-dialog footer button:last-child');
    assert.ok(
      await session.evaluate(
        'document.querySelector("dialog h2").textContent.includes("Create your team")'
      )
    );
    await waitForTeam();
    assert.ok(
      await session.evaluate(
        'document.querySelector("dialog textarea").placeholder.includes("kick off your Buddies")'
      )
    );
    assert.equal(
      await session.evaluate('document.querySelector("dialog form button[type=submit]").disabled'),
      true
    );
    await session.capture(path.join(out, 'create-team@phone.png'));
    await session.click('dialog.dependencies-dialog footer button:last-child');
    await reload();
    await reopen();
    await session.evaluate(
      'document.querySelector("dialog.dependencies-dialog").dispatchEvent(new Event("cancel"))'
    );
    await reload();
    for (const [name, viewport] of [
      ['desktop', { width: 1440, height: 1000, mobile: false, deviceScaleFactor: 1 }],
      ['phone', { width: 390, height: 844, mobile: true, deviceScaleFactor: 1 }],
    ]) {
      await session.setViewport(viewport);
      await session.goto(
        `http://127.0.0.1:${port}/buddies/workspaces/project_fixture/channels`,
        700
      );
      await session.evaluate(
        `localStorage.setItem('unleashd-setup-dismissed', 'true'); localStorage.setItem('buddies-home-screen-guide-dismissed', 'true'); location.reload()`
      );
      await session.evaluate('new Promise(resolve => setTimeout(resolve, 700))');
      await session.evaluate(
        `[...document.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === 'New Buddy' || button.textContent.includes('New Buddy')).click()`
      );
      await session.evaluate('new Promise(resolve => setTimeout(resolve, 200))');
      assert.equal(
        await session.evaluate(
          `document.querySelector('dialog[aria-label="Create your team"] input').value`
        ),
        workspace.rootPath
      );
      assert.equal(
        await session.evaluate(
          `document.querySelector('dialog[aria-label="Create your team"] input').readOnly`
        ),
        true
      );
      const bounds = await session.evaluate(
        `(() => { const rect = document.querySelector('dialog[aria-label="Create your team"]').getBoundingClientRect(); return { centerX: rect.x + rect.width / 2, centerY: rect.y + rect.height / 2 }; })()`
      );
      assert.ok(Math.abs(bounds.centerX - viewport.width / 2) < 2);
      assert.ok(Math.abs(bounds.centerY - viewport.height / 2) < 2);
      await session.capture(path.join(out, `empty-workspace-team@${name}.png`));
    }
    // Regression: "Connect mobile" opened the wizard on Welcome, so the Connect section
    // never mounted. Both desktop entry points must land on the Setup step, section shown.
    const connectSection = async (shot) => {
      await session.evaluate('new Promise(resolve => setTimeout(resolve, 300))');
      assert.ok(
        await session.evaluate('document.querySelector("dialog h2").textContent.includes("Setup")')
      );
      const title = await session.evaluate(`(() => {
        const r = document.getElementById('connect-mobile-title').getBoundingClientRect();
        const footer = document.querySelector('dialog.dependencies-dialog footer');
        return { top: r.top, bottom: r.bottom, limit: footer.getBoundingClientRect().top };
      })()`);
      assert.ok(
        title.top >= 0 && title.bottom <= title.limit,
        'Connect from mobile is scrolled into view'
      );
      await session.capture(path.join(out, shot));
    };
    await session.setViewport({ width: 1440, height: 1000, mobile: false, deviceScaleFactor: 1 });
    await session.goto(`http://127.0.0.1:${port}/buddies/workspaces/project_fixture/channels`, 700);
    await session.evaluate(
      `localStorage.setItem('unleashd-setup-dismissed', 'true'); location.reload()`
    );
    await session.evaluate('new Promise(resolve => setTimeout(resolve, 700))');
    await session.capture(path.join(out, 'workspace-rail@desktop.png'));
    await session.click('.channel-browser-rail-connect');
    await connectSection('connect-mobile-from-rail@desktop.png');
    await session.goto(`http://127.0.0.1:${port}/`, 700);
    await session.evaluate(
      `localStorage.setItem('unleashd-setup-dismissed', 'true'); location.reload()`
    );
    await session.evaluate('new Promise(resolve => setTimeout(resolve, 700))');
    await session.click('button[title="Settings"]');
    await session.click('.config-item--connect-mobile');
    await connectSection('connect-mobile-from-gear@desktop.png');
  } finally {
    await session?.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
