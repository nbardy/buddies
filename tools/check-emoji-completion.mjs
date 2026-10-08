#!/usr/bin/env node
// Real read-only browser guard: no posts are sent. Uses the shared desktop/mobile composer.
import assert from 'node:assert/strict';
import { openSession, resolveAuthToken, sleep } from './lib/headless-chrome.mjs';
const [workspaceId, channelId, baseUrl = 'http://localhost:7489', shotDir] = process.argv.slice(2);
assert.ok(workspaceId && channelId, 'Pass workspace and channel ids');
const session = await openSession({ baseUrl, token: resolveAuthToken() });
const waitFor = async (expression) => {
  for (let i = 0; i < 100; i++) {
    if (await session.evaluate(expression)) return;
    await sleep(100);
  }
  assert.fail(`Not ready: ${expression}`);
};
const type = async (text) => {
  await session.evaluate(`(() => {
    const input = document.querySelector('.channel-composer textarea');
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)});
    input.setSelectionRange(${text.length}, ${text.length});
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(100);
};
const key = async (key) => {
  await session.evaluate(
    `document.querySelector('.channel-composer textarea').dispatchEvent(new KeyboardEvent('keydown', {key:${JSON.stringify(key)}, bubbles:true}))`
  );
  await sleep(100);
};
try {
  for (const width of [375, 1440]) {
    await session.setViewport({ width, height: 900, deviceScaleFactor: 1, mobile: width < 768 });
    // Home on phone shares the composer, channel view on desktop proves the bottom placement.
    await session.goto(
      `${baseUrl}/buddies/workspaces/${workspaceId}/channels?${width < 768 ? 'view=home' : `channel=${channelId}`}`,
      500
    );
    await waitFor('!!document.querySelector(".channel-composer textarea")');
    await session.evaluate(
      `document.querySelector('[aria-label="Close dependency checks"]')?.click(); document.querySelector('[aria-labelledby="home-screen-guide-title"] button')?.click()`
    );
    await sleep(500);
    await session.evaluate(`document.querySelector('[aria-labelledby="home-screen-guide-title"] button')?.click()`);
    await sleep(100);
    await type(':');
    await waitFor(`!!document.querySelector('[aria-label="Choose an emoji"]')`);
    assert.ok(
      await session.evaluate(
        `document.querySelectorAll('.channel-composer-picker button').length > 1`
      )
    );
    await key('ArrowDown');
    assert.equal(
      await session.evaluate(
        `Array.from(document.querySelectorAll('.channel-composer-picker button')).findIndex(b=>b.hasAttribute('data-selected'))`
      ),
      1
    );
    await key('Escape');
    assert.equal(
      await session.evaluate(`!!document.querySelector('.channel-composer-picker')`),
      false
    );
    await type(':rocket');
    await waitFor('!!document.querySelector(".channel-composer-picker")');
    if (shotDir) await session.capture(`${shotDir}/emoji-${width}.png`);
    const geometry = await session.evaluate(`(() => {
      const r=document.querySelector('.channel-composer-picker').getBoundingClientRect();
      const b=document.querySelector('.channel-composer-picker button').getBoundingClientRect();
      return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,covering: document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)?.outerHTML, visible:!!document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)?.closest('.channel-composer-picker')};
    })()`);
    assert.ok(
      geometry.top >= 0 &&
        geometry.bottom <= 900 &&
        geometry.left >= 0 &&
        geometry.right <= width &&
        geometry.visible,
      JSON.stringify(geometry)
    );
    if (shotDir) await session.capture(`${shotDir}/emoji-${width}.png`);
    await key('Tab');
    assert.equal(
      await session.evaluate(`document.querySelector('.channel-composer textarea').value`),
      '🚀 '
    );
    assert.equal(
      await session.evaluate(`!!document.querySelector('.channel-composer-picker')`),
      false
    );
    await type(':smile');
    await key('Enter');
    assert.equal(
      await session.evaluate(`document.querySelector('.channel-composer textarea').value`),
      '😄 '
    );
    await type(':heart');
    await session.click('.channel-composer-picker button');
    assert.equal(
      await session.evaluate(`document.querySelector('.channel-composer textarea').value`),
      '❤️ '
    );
    await type('https:');
    assert.equal(
      await session.evaluate(`!!document.querySelector('.channel-composer-picker')`),
      false
    );
    await type('@');
    await waitFor(`!!document.querySelector('[aria-label="Mention a Buddy"]')`);
    await type('');
    console.log(
      `${width}px: colon/search, arrows, Escape, Tab, Enter, click, geometry and @ coexistence pass`
    );
  }
  assert.equal(
    (await session.blockedWrites()).filter((item) => /channel.post/.test(JSON.stringify(item)))
      .length,
    0,
    'Picking must not submit a post'
  );
} finally {
  await session.close();
}
