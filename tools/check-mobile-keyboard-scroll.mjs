import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, unlinkSync } from 'node:fs';
import { inspectChannelModelPicker } from './lib/channel-model-picker.mjs';
import { openSession, resolveAuthToken } from './lib/headless-chrome.mjs';

// Read-only browser regression through real rendered controls, with a visual
// viewport shorter than the layout viewport (the iOS software-keyboard shape).
const session = await openSession({ baseUrl: 'http://localhost:7489', token: resolveAuthToken() });
const workspace = process.argv[2];
const channel = process.argv[3];
assert(workspace && channel, 'Pass workspace and channel ids');
async function capture(name) {
  if (!process.env.MOBILE_PROBE_SHOTS) return;
  mkdirSync(process.env.MOBILE_PROBE_SHOTS, { recursive: true });
  const file = `${process.env.MOBILE_PROBE_SHOTS}/${name}`;
  await session.capture(`${file}.png`);
  execFileSync('cwebp', ['-quiet', '-q', '95', `${file}.png`, '-o', `${file}.webp`]);
  unlinkSync(`${file}.png`);
}
try {
  await session.setViewport({ width: 375, height: 812, mobile: true, deviceScaleFactor: 2 });
  const path = `/buddies/workspaces/${workspace}/channels`;
  await session.goto(`http://localhost:7489${path}?view=threads`, 1500);
  await session.waitForNetworkIdle(500, 15000, /sigil.worker/);
  const page = await session.evaluate(`(() => {
    const content = document.querySelector('.mobile-content');
    const root = document.scrollingElement;
    window.scrollTo(0, 200);
    const result = { scroll: root.scrollTop, overflow: getComputedStyle(content).overflowY };
    window.scrollTo(0, 0);
    return result;
  })()`);
  assert.equal(page.overflow, 'visible');
  assert(page.scroll > 0, 'Threads must scroll the browser document');
  await session.evaluate(
    `document.querySelector('[aria-label="Close dependency checks"]')?.click()`
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  await capture('threads');
  await session.goto(`http://localhost:7489${path}?channel=${channel}`, 1500);
  await session.waitForNetworkIdle(500, 15000, /sigil.worker/);
  await session.evaluate(
    `document.querySelector('[aria-label="Close dependency checks"]')?.click()`
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  await session.evaluate(
    `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Got it')?.click()`
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  await capture('channel-before-top');
  await session.click('.mobile-channel-header__top');
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(
    await session.evaluate(`document.querySelector('.mobile-channel__scroll').scrollTop`),
    0
  );
  const opened = await session.evaluate(`(async () => {
    const tick = ms => new Promise(r => setTimeout(r, ms));
    document.querySelector('[aria-label="Close dependency checks"]')?.click();
    [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Got it')?.click();
    const input = document.querySelector('.channel-composer textarea');
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '@');
    input.dispatchEvent(new Event('input', {bubbles: true}));
    input.setSelectionRange(1, 1);
    await tick(300);
    input.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
    await tick(300);
    const chip = document.querySelector('.channel-composer-mention');
    if (!chip || chip.disabled) return false;
    chip.click();
    await tick(1000);
    return document.activeElement === input && !!document.querySelector('.channel-composer-model');
  })()`);
  assert(opened, 'Opening model picker must retain the focused draft');
  for (const [height, offsetTop] of [
    [460, 0],
    [340, 70],
    [812, 0],
  ]) {
    await session.evaluate(`(() => {
      const viewport = window.visualViewport;
      Object.defineProperty(viewport, 'height', {configurable: true, value: ${height}});
      Object.defineProperty(viewport, 'offsetTop', {configurable: true, value: ${offsetTop}});
      viewport.dispatchEvent(new Event('resize'));
    })()`);
    const result = await session.evaluate(`(${inspectChannelModelPicker.toString()})()`);
    assert(result.visible);
    await capture(`picker-${height}-${offsetTop}`);
  }
  console.log(
    'PASS: document scrolling, retained draft focus, Done visible at keyboard/panned/restored viewport sizes'
  );
} finally {
  await session.close();
}
