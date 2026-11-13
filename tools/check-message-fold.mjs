#!/usr/bin/env node
// Real rendered posts: catches missing folds, height leaks, broken toggles and width changes.
// Usage: node tools/check-message-fold.mjs /buddies/workspaces/ID/channels?channel=ID
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { openSession, resolveAuthToken, sleep } from './lib/headless-chrome.mjs';

const route = process.argv[2];
assert.ok(route, 'Pass a channel route containing both short and long real messages');
const out = 'output/message-fold';
await mkdir(out, { recursive: true });
const session = await openSession({ baseUrl: 'http://localhost:7489', token: resolveAuthToken() });
try {
  for (const [name, width] of [
    ['desktop', 1440],
    ['phone', 375],
  ]) {
    await session.setViewport({ width, height: 900, deviceScaleFactor: 1, mobile: width < 768 });
    await session.goto(`http://localhost:7489${route}`);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await session.evaluate("!!document.querySelector('.channel-message-fold')")) break;
      await sleep(100);
    }
    // Setup arrives after the channel on a fresh mobile load; close only device-local prompts.
    for (let attempt = 0; attempt < 10; attempt++) {
      await session.evaluate(`(() => {
        document.querySelector('button[aria-label="Close dependency checks"]')?.click();
        [...document.querySelectorAll('dialog[aria-labelledby="home-screen-guide-title"] button')].find(b => b.textContent === 'Got it')?.click();
      })()`);
      await sleep(100);
    }
    assert.equal(await session.evaluate("document.querySelectorAll('dialog[open]').length"), 0);
    const result = await session.evaluate(`(() => {
      const button = document.querySelector('.channel-message-fold');
      if (!button) throw new Error('No long message found');
      const preview = document.getElementById(button.getAttribute('aria-controls'));
      window.foldButton = button;
      preview.scrollIntoView({block:'center'});
      const short = [...document.querySelectorAll('.channel-message-preview')].find(p => p.firstElementChild.getBoundingClientRect().height < 300);
      return {collapsed: button.getAttribute('aria-expanded'), height: preview.getBoundingClientRect().height,
        natural: preview.firstElementChild.getBoundingClientRect().height,
        shortHasFold: short ? Boolean(short.nextElementSibling?.classList.contains('channel-message-fold')) : null};
    })()`);
    assert.equal(result.collapsed, 'false');
    assert.ok(result.height <= 320 && result.natural > 320, JSON.stringify(result));
    assert.equal(result.shortHasFold, false, 'Short posts should have no toggle');
    await session.capture(`${out}/${name}-collapsed.png`);
    await session.evaluate('window.foldButton.click()');
    await sleep(100);
    assert.ok(
      await session.evaluate(`(() => {
      const b = window.foldButton, p = document.getElementById(b.getAttribute('aria-controls'));
      return b.textContent === 'Show less' && b.getAttribute('aria-expanded') === 'true' && p.clientHeight >= p.firstElementChild.clientHeight;
    })()`),
      'Expansion exposes the full rendered body'
    );
    await session.capture(`${out}/${name}-expanded.png`);
    await session.evaluate('window.foldButton.click()');
    await sleep(100);
    assert.equal(
      await session.evaluate("window.foldButton.getAttribute('aria-expanded')"),
      'false'
    );
    console.log(`${name}: short message unchanged; long message folds, expands and collapses`);
  }
} finally {
  await session.close();
}
