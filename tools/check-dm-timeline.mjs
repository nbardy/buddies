#!/usr/bin/env node
// Fix guard: a new DM jumped to the top as old generations hydrated. Exercise
// the real follow hook with delayed content, then inspect real DM banners on both shells.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openSession, resolveAuthToken, sleep } from './lib/headless-chrome.mjs';

const [workspaceId, buddyId, baseUrl = 'http://localhost:7489', out = '/tmp/dm-timeline'] =
  process.argv.slice(2);
assert.ok(workspaceId && buddyId, 'Pass workspace-id and buddy-id');
fs.mkdirSync(out, { recursive: true });
const session = await openSession({ baseUrl, token: resolveAuthToken() });
try {
  const chain = await session.evaluate(
    `fetch('/api/buddies/${encodeURIComponent(buddyId)}/direct/chain').then(r => r.json())`
  );
  const id = chain.generations.at(-1);
  assert.ok(id, 'Buddy must have a DM');
  for (const width of [1440, 375]) {
    await session.setViewport({ width, height: 900, deviceScaleFactor: 1, mobile: width < 768 });
    await session.goto(
      `${baseUrl}/buddies/workspaces/${encodeURIComponent(workspaceId)}/channels?dm=${encodeURIComponent(id)}`,
      1000
    );
    await session.waitForNetworkIdle(500, 20000, /sigil\.worker|favicon/);
    await sleep(500);
    const banners = await session.evaluate(`
      [...document.querySelectorAll('.channel-dm-notice')].map(el => {
        const bounds = el.getBoundingClientRect();
        return { text: el.textContent, before: el.previousElementSibling?.className,
          align: getComputedStyle(el).textAlign, background: getComputedStyle(el).backgroundColor,
          width: bounds.width, listWidth: el.parentElement.getBoundingClientRect().width };
      })
    `);
    assert.ok(banners.length, 'DM must contain a reset');
    for (const banner of banners) {
      assert.match(banner.before, /channel.*day/);
      assert.equal(banner.align, 'center');
      assert.equal(banner.width, banner.listWidth);
      assert.notEqual(banner.background, 'rgba(0, 0, 0, 0)');
    }
    await session.evaluate(`(() => {
      const notice = [...document.querySelectorAll('.channel-dm-notice')].at(-1);
      const pane = notice.closest('.channel-browser-scroll, .mobile-channel__scroll');
      pane.scrollTop += notice.getBoundingClientRect().top - pane.getBoundingClientRect().top - 120;
    })()`);
    await sleep(100);
    await session.capture(`${out}/dm-${width}.png`);
    console.log(`${width}px: ${banners.length} dated, centered, full-width reset banners`);
  }
  // Mount the actual hook in the browser: no writes to owner data, no mock scroll API.
  await session.evaluate(`(async () => {
    const React = (await import('/node_modules/.vite/deps/react.js')).default;
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { useFollowBottom } = await import('/src/components/buddies/channel-data.ts');
    const host = document.createElement('div');
    document.body.append(host);
    function Probe() {
      const [height, grow] = React.useState(100);
      const follow = useFollowBottom(0, null, null);
      window.__dmProbe = { grow, pin: follow.pin };
      return React.createElement('div', { id: 'dm-scroll-probe', ref: follow.scrollRef,
        onScroll: follow.onScroll, style: { height: 200, overflowY: 'auto' } },
        React.createElement('div', { ref: follow.contentRef, style: { height } }));
    }
    createRoot(host).render(React.createElement(Probe));
  })()`);
  await sleep(200);
  await session.evaluate('window.__dmProbe.grow(2000)');
  await sleep(200);
  const position = () =>
    session.evaluate(
      `(() => { const n = document.querySelector('#dm-scroll-probe'); return { top: n.scrollTop, bottom: n.scrollHeight - n.scrollTop - n.clientHeight }; })()`
    );
  assert.equal((await position()).bottom, 0, 'empty new chat follows delayed old history');
  await session.evaluate("document.querySelector('#dm-scroll-probe').scrollTop = 100");
  await sleep(100);
  await session.evaluate('window.__dmProbe.grow(3000)');
  await sleep(200);
  assert.equal((await position()).top, 100, 'reading history keeps its position');
  await session.evaluate('window.__dmProbe.pin(); window.__dmProbe.grow(3500)');
  await sleep(200);
  assert.equal((await position()).bottom, 0, 'explicit reset pins the next generation');
  console.log(
    'Scroll: delayed history stays at bottom; reading history stays put; reset resumes following'
  );
} finally {
  await session.close();
}
