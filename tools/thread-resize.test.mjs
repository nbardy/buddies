// Real browser boundary: a fixed thread width made longer replies hard to read.
// Run with THREAD_RESIZE_URL pointing at an existing channel/thread on a dev server.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, unlink } from 'node:fs/promises';
import test from 'node:test';
import { openSession, resolveAuthToken, sleep } from './lib/headless-chrome.mjs';

const url = process.env.THREAD_RESIZE_URL;
test(
  'thread divider resizes, persists, resets and leaves room for the channel',
  { skip: !url },
  async () => {
    const target = new URL(url);
    const session = await openSession({
      baseUrl: target.origin,
      token: resolveAuthToken(),
      showScrollbars: true,
    });
    const selector = '.channel-thread-resize';
    const capture = async (name) => {
      const file = `output/screenshots/thread-resize-review-20261006/${name}`;
      await session.capture(`${file}.png`);
      try {
        execFileSync('cwebp', ['-quiet', '-q', '95', `${file}.png`, '-o', `${file}.webp`]);
      } finally {
        await unlink(`${file}.png`);
      }
    };
    const width = () =>
      session.evaluate("document.querySelector('.channel-thread').getBoundingClientRect().width");
    const key = async (name) => {
      await session.evaluate(
        `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new KeyboardEvent('keydown', {key: ${JSON.stringify(name)}, bubbles:true}))`
      );
      await sleep(80);
    };
    try {
      await session.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      await session.goto(url);
      for (let i = 0; i < 100; i++) {
        if (await session.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)) break;
        await sleep(100);
      }
      await session.evaluate(
        'document.querySelector(\'[aria-label="Close dependency checks"]\')?.click()'
      );
      assert.ok(await session.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`));
      assert.equal(await width(), 420);
      await mkdir('output/screenshots/thread-resize-review-20261006', { recursive: true });
      await session.waitForNetworkIdle(500, 20000, /sigil.worker/);
      await capture('default');
      await session.drag(selector, -180);
      await sleep(100);
      assert.equal(await width(), 600);
      assert.equal(
        await session.evaluate(
          "getComputedStyle(document.querySelector('.channel-thread-resize')).backgroundImage"
        ),
        'none'
      );
      await session.evaluate(`document.querySelectorAll('.channel-browser-scroll').forEach(el => {
        el.scrollTop += el.scrollTop > 100 ? -100 : 100;
        el.dispatchEvent(new Event('scroll', {bubbles:true}));
      })`);
      await sleep(100);
      assert.equal(
        await session.evaluate(
          "document.querySelectorAll('.channel-browser-scroll[data-scrolling]').length"
        ),
        2
      );
      const thumb = await session.evaluate(
        `(() => { const s=getComputedStyle(document.querySelector('.channel-thread .channel-browser-scroll'),'::-webkit-scrollbar-thumb'); return {radius:s.borderRadius, border:s.borderRightWidth, clip:s.backgroundClip}; })()`
      );
      assert.deepEqual(thumb, { radius: '999px', border: '3px', clip: 'padding-box' });
      assert.notEqual(
        await session.evaluate(
          "getComputedStyle(document.querySelector('.channel-thread .channel-browser-scroll'),'::-webkit-scrollbar-thumb').backgroundColor"
        ),
        'rgba(0, 0, 0, 0)'
      );
      await capture('scroll-active');
      await sleep(1000);
      assert.equal(
        await session.evaluate(
          "document.querySelectorAll('.channel-browser-scroll[data-scrolling]').length"
        ),
        0
      );
      assert.equal(
        await session.evaluate(
          "getComputedStyle(document.querySelector('.channel-thread .channel-browser-scroll'),'::-webkit-scrollbar-thumb').backgroundColor"
        ),
        'rgba(0, 0, 0, 0)'
      );
      await key('ArrowLeft');
      assert.equal(await width(), 624);
      await key('ArrowRight');
      assert.equal(await width(), 600);
      await session.evaluate('location.reload()');
      await sleep(2000);
      assert.equal(await width(), 600);
      await capture('wide');
      await key('Home');
      assert.equal(await width(), 320);
      await key('End');
      assert.equal(
        await session.evaluate(
          `document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-valuenow')`
        ),
        '960'
      );
      await session.setViewport({ width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
      await sleep(100);
      const layout = await session.evaluate(`(() => {
      const parent = document.querySelector('.channel-browser-panes').getBoundingClientRect();
      const channel = document.querySelector('.channel-browser-pane').getBoundingClientRect();
      const thread = document.querySelector('.channel-thread').getBoundingClientRect();
      return {parent:parent.width, channel:channel.width, right:thread.right, viewport:innerWidth};
    })()`);
      assert.ok(layout.channel >= Math.min(320, layout.parent * 0.45) - 1);
      assert.ok(layout.right <= layout.viewport + 1);
      await session.evaluate(
        `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('dblclick', {bubbles:true}))`
      );
      await sleep(100);
      assert.equal(await session.evaluate("localStorage.getItem('unleashd-thread-width')"), '420');
    } finally {
      await session.close();
    }
  }
);
