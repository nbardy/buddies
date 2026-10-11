/** Read-only real-browser regression: node tools/check-reaction-layout.mjs URL [capture-dir]. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openSession, resolveAuthToken } from './lib/headless-chrome.mjs';

const url = new URL(process.argv[2]);
const session = await openSession({
  baseUrl: url.origin,
  token: resolveAuthToken(),
  clockMs: Date.now(),
});
try {
  for (const mobile of [false, true]) {
    await session.setViewport({
      width: mobile ? 390 : 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile,
    });
    await session.goto(url.href, 1500);
    await session.waitForNetworkIdle(500, 20000, /\/messages\?/);
    await session.evaluate(
      `document.querySelector('[aria-label="Close dependency checks"]')?.click()`
    );
    const selector = '[data-reaction-layout-probe]';
    await session.evaluate(`(() => {
      const posts = [...document.querySelectorAll('.channel-post-content')];
      const post = posts.find(p => p.querySelector('.channel-post-add-reaction')?.parentElement.children.length === 1);
      if (!post) throw new Error('No real post without existing actions to verify');
      post.setAttribute('data-reaction-layout-probe', '');
    })()`);
    await session.evaluate(
      `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center'})`
    );
    const measure = () =>
      session.evaluate(`(() => {
      const post = document.querySelector('${selector}');
      if (!post) throw new Error('No real post to verify');
      const rect = post.getBoundingClientRect();
      const button = post.querySelector('.channel-post-add-reaction');
      const style = getComputedStyle(button);
      return { width: rect.width, height: rect.height, opacity: style.opacity, display: style.display,
        pointerEvents: style.pointerEvents, buttonWidth: button.getBoundingClientRect().width };
    })()`);
    const capture = async (name) => {
      if (!process.argv[3]) return;
      fs.mkdirSync(process.argv[3], { recursive: true });
      await session.capture(`${process.argv[3]}/${mobile ? 'phone' : 'desktop'}-${name}.png`);
    };
    await session.evaluate('document.activeElement?.blur()');
    if (!mobile) await session.hover('.channel-browser-rail');
    const before = await measure();
    console.log(JSON.stringify({ device: mobile ? 'phone' : 'desktop', before }));
    await capture('before');
    if (mobile) {
      assert.equal(before.opacity, '1', 'Touch must expose the emoji action');
    } else {
      await session.hover(selector);
      const hovered = await measure();
      await capture('hover');
      assert.equal(hovered.opacity, '1');
      assert.equal(hovered.pointerEvents, 'auto');
      assert.equal(hovered.width, before.width, 'Hover changed post width');
      assert.equal(hovered.height, before.height, 'Hover changed post height');
      await session.evaluate(`document.querySelector('${selector}').focus()`);
      if (!mobile) await session.hover('.channel-browser-rail');
      const focused = await measure();
      assert.equal(focused.opacity, '1', 'Keyboard focus must expose the action');
      assert.equal(focused.height, before.height, 'Focus changed post height');
      await session.evaluate(
        `document.querySelector('${selector} .channel-post-add-reaction').focus()`
      );
      assert.equal(
        await session.evaluate(`document.activeElement.getAttribute('aria-label')`),
        'Add emoji reaction'
      );
    }
    assert.ok(before.buttonWidth > 0, 'Button must reserve its layout space');
    console.log(JSON.stringify({ device: mobile ? 'phone' : 'desktop', before, passed: true }));
  }
  console.log(JSON.stringify({ blockedWrites: await session.blockedWrites() }));
} finally {
  await session.close();
}
