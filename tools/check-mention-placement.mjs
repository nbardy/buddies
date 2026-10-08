#!/usr/bin/env node
// Home opens Buddy suggestions below the field; bottom chat composers open above.
// Real browser guard: node tools/check-mention-placement.mjs <workspace-id> <channel-id>
import assert from 'node:assert/strict';
import { openSession, resolveAuthToken, sleep } from './lib/headless-chrome.mjs';

const [workspaceId, channelId, baseUrl = 'http://localhost:7489'] = process.argv.slice(2);
assert.ok(workspaceId && channelId, 'Pass a workspace and channel with active Buddies');
const session = await openSession({ baseUrl, token: resolveAuthToken() });
const waitFor = async (expression) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await session.evaluate(expression)) return;
    await sleep(100);
  }
  assert.fail(`Page did not become ready: ${expression}`);
};
const path = `${baseUrl}/buddies/workspaces/${encodeURIComponent(workspaceId)}/channels`;
try {
  for (const [width, height] of [
    [375, 812],
    [1440, 900],
  ]) {
    await session.setViewport({ width, height, deviceScaleFactor: 1, mobile: width < 768 });
    for (const home of width < 768 ? [true] : [true, false]) {
      await session.goto(
        `${path}?${home ? 'view=home' : `channel=${encodeURIComponent(channelId)}`}`,
        500
      );
      await waitFor('!!document.querySelector(".channel-composer textarea")');
      await session.evaluate(
        `document.querySelector('[aria-label="Close dependency checks"]')?.click()`
      );
      await sleep(100);
      await session.evaluate(
        `document.querySelector('[aria-labelledby="home-screen-guide-title"] button')?.click()`
      );
      await sleep(50);
      await session.evaluate(`(() => {
        const input = document.querySelector('.channel-composer textarea');
        input.focus();
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, '@');
        input.setSelectionRange(1, 1);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await waitFor('!!document.querySelector(".channel-composer-picker button")');
      const geometry = await session.evaluate(`(() => {
        const box = document.querySelector('.channel-composer').getBoundingClientRect();
        const menu = document.querySelector('.channel-composer-picker').getBoundingClientRect();
        const row = document.querySelector('.channel-composer-picker button').getBoundingClientRect();
        const visible = !!document.elementFromPoint(row.x + row.width / 2, row.y + row.height / 2)
          ?.closest('.channel-composer-picker');
        return { box: { top: box.top, bottom: box.bottom }, menu: {
          top: menu.top, bottom: menu.bottom, left: menu.left, right: menu.right }, visible,
          covering: document.elementFromPoint(row.x + row.width / 2, row.y + row.height / 2)?.className };
      })()`);
      assert.ok(
        geometry.visible,
        `${width}px: first Buddy suggestion is clipped or covered: ${JSON.stringify(geometry)}`
      );
      assert.ok(
        geometry.menu.top >= 0 && geometry.menu.bottom <= height,
        `${width}px: suggestions leave the viewport: ${JSON.stringify(geometry)}`
      );
      assert.ok(
        geometry.menu.left >= 0 && geometry.menu.right <= width,
        'Suggestions fit horizontally'
      );
      assert.ok(
        home ? geometry.menu.top >= geometry.box.bottom : geometry.menu.bottom <= geometry.box.top,
        `${width}px: ${home ? 'Home must open below' : 'bottom channel must open above'}: ${JSON.stringify(geometry)}`
      );
      await session.evaluate(`document.querySelector('.channel-composer textarea')
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`);
      await sleep(50);
      const picked = await session.evaluate(`(() => {
        const buttons = [...document.querySelectorAll('.channel-composer-picker button')];
        return buttons.findIndex(button => button.hasAttribute('data-selected')) === (buttons.length > 1 ? 1 : 0);
      })()`);
      assert.ok(picked, 'ArrowDown selects the next Buddy');
      await session.evaluate(`document.querySelector('.channel-composer textarea')
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
      await sleep(50);
      assert.equal(
        await session.evaluate(`!!document.querySelector('.channel-composer-picker')`),
        false,
        'Enter chooses the Buddy and closes suggestions'
      );
      assert.equal(
        await session.evaluate(`!!document.querySelector('.channel-composer-mention')`),
        true,
        'Chosen Buddy appears as a chip without posting'
      );
      console.log(
        `${width}px ${home ? 'Home below' : 'channel above'}: visible suggestions and keyboard selection pass`
      );
    }
  }
} finally {
  await session.close();
}
