#!/usr/bin/env node
// Real read-only browser guard: no posts are sent. Uses the shared desktop/mobile composer.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import { openSession, resolveAuthToken, sleep } from './lib/headless-chrome.mjs';
const [workspaceId, channelId, baseUrl = 'http://localhost:7489', shotDir] = process.argv.slice(2);
assert.ok(workspaceId && channelId, 'Pass workspace and channel ids');
const session = await openSession({ baseUrl, token: resolveAuthToken() });
const capture = async (name) => {
  if (!shotDir) return;
  const png = `${shotDir}/${name}.png`;
  try {
    await session.capture(png);
    execFileSync('cwebp', ['-quiet', '-q', '95', png, '-o', `${shotDir}/${name}.webp`]);
  } finally {
    try {
      unlinkSync(png);
    } catch {}
  }
};
const waitFor = async (expression) => {
  for (let i = 0; i < 100; i++) {
    if (await session.evaluate(expression)) return;
    await sleep(100);
  }
  console.log(await session.evaluate('document.body.innerText.slice(0, 600)'));
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
    await session.evaluate(
      `document.querySelector('[aria-labelledby="home-screen-guide-title"] button')?.click()`
    );
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
    await capture(`emoji-${width}`);
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
    await capture(`emoji-${width}`);
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

  for (const width of [375, 1440]) {
    await session.setViewport({ width, height: 900, deviceScaleFactor: 1, mobile: width < 768 });
    await session.goto(
      `${baseUrl}/buddies/workspaces/${workspaceId}/channels?channel=${channelId}`,
      500
    );
    await waitFor(`!!document.querySelector('[aria-label="Edit message"]')`);
    await session.evaluate(
      `document.querySelector('[aria-label="Close dependency checks"]')?.click()`
    );
    await sleep(200);
    await session.evaluate(
      `document.querySelector('[aria-labelledby="home-screen-guide-title"] button')?.click()`
    );
    await session.evaluate(
      `document.querySelector('[aria-label="Edit message"]').scrollIntoView({block:'center'})`
    );
    await session.click('[aria-label="Edit message"]');
    await waitFor(`!!document.querySelector('[aria-label="Edit message…"]')`);
    const original = await session.evaluate(
      `document.querySelector('[aria-label="Edit message…"]').value`
    );
    assert.ok(original.length > 0, 'Edit opens the original body');
    await session.evaluate(`(() => {
      const input=document.querySelector('[aria-label="Edit message…"]');
      const value=input.value+' :rocket'; input.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,value);
      input.setSelectionRange(value.length,value.length); input.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    await waitFor(`!!document.querySelector('[aria-label="Choose an emoji"]')`);
    await session.evaluate(
      `document.querySelector('[aria-label="Choose an emoji"] button').click()`
    );
    assert.ok(
      await session.evaluate(
        `document.querySelector('[aria-label="Edit message…"]').value.endsWith('🚀 ')`
      )
    );
    await capture(`edit-${width}`);
    await session.evaluate(
      `Array.from(document.querySelectorAll('.channel-composer button')).find(b=>b.textContent==='Cancel').click()`
    );
    await session.evaluate(
      `document.querySelector('[aria-label="Add emoji reaction"]').scrollIntoView({block:'center'})`
    );
    // Empty reaction controls must not decorate every message; hover/focus makes them available.
    await session.evaluate('document.activeElement?.blur()');
    await session.hover('header');
    assert.equal(
      await session.evaluate(
        `getComputedStyle(document.querySelector('[aria-label="Add emoji reaction"]')).display`
      ),
      'none'
    );
    await capture(`react-rest-${width}`);
    await session.evaluate(
      `document.querySelector('[aria-label="Add emoji reaction"]').closest('.channel-post-content').focus()`
    );
    assert.notEqual(
      await session.evaluate(
        `getComputedStyle(document.querySelector('[aria-label="Add emoji reaction"]')).display`
      ),
      'none'
    );
    await session.evaluate('document.activeElement?.blur()');
    await session.hover('.channel-post-content:has([aria-label="Add emoji reaction"])');
    assert.notEqual(
      await session.evaluate(
        `getComputedStyle(document.querySelector('[aria-label="Add emoji reaction"]')).display`
      ),
      'none'
    );
    await capture(`react-hover-${width}`);
    await session.click('[aria-label="Add emoji reaction"]');
    await waitFor(`!!document.querySelector('[aria-label="Emoji reactions"]')`);
    await capture(`react-${width}`);
    await session.click('[aria-label="Close emoji picker"]');
    console.log(`${width}px: owner edit, emoji insertion, Cancel, reaction picker and close pass`);
  }
  const usage = await session.evaluate(`JSON.parse(localStorage.getItem('unleashd-emoji-usage'))`);
  assert.ok(usage['🚀'] >= 1, 'Composer and editing selections persist frequency counts');
  await session.evaluate('location.reload()');
  await sleep(500);
  await waitFor('!!document.querySelector(".channel-composer textarea")');
  await type(':');
  assert.ok(
    await session.evaluate(
      `document.querySelector('.channel-composer-picker button').textContent.includes(':rocket:')`
    ),
    'Most-used emoji stays first after a page reload'
  );
  await type('');
  assert.equal(
    (await session.blockedWrites()).filter((item) =>
      /\/api\/buddies\/channels\/[^/]+\/posts/.test(JSON.stringify(item))
    ).length,
    0,
    'Picking must not submit a post'
  );
} finally {
  await session.close();
}
