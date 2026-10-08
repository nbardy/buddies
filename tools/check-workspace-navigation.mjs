#!/usr/bin/env node
// Browser regression guard for the rewrite's workspace bullets and stretched Buddy rows.
// Uses real data and the screenshot driver's read-only session; requires pnpm dev.
// node tools/check-workspace-navigation.mjs <workspace-id> [base-url]
import assert from 'node:assert/strict';
import { inspectChannelStarLayout } from './lib/channel-star-layout.mjs';
import { openSession, resolveAuthToken, sleep } from './lib/headless-chrome.mjs';

const [workspaceId, baseUrl = 'http://localhost:7489'] = process.argv.slice(2);
assert.ok(workspaceId, 'Pass a workspace with at least one active Buddy');
const session = await openSession({ baseUrl, token: resolveAuthToken() });
const waitFor = async (expression) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await session.evaluate(expression)) return;
    await sleep(100);
  }
  assert.fail(`Page did not become ready: ${expression}`);
};

try {
  for (const width of [375, 1440]) {
    await session.setViewport({ width, height: 900, deviceScaleFactor: 1, mobile: width < 768 });
    await session.goto(`${baseUrl}/`, 500);
    await waitFor('!!document.querySelector(".workspace-home-link")');
    const lists = await session.evaluate(`
      [...document.querySelectorAll('.workspace-home-tiles, .workspace-home-list')]
        .map(list => getComputedStyle(list).listStyleType)
    `);
    assert.ok(lists.length > 0, 'Workspace lists must render');
    assert.ok(
      lists.every((style) => style === 'none'),
      `${width}px: workspace list bullets returned`
    );

    await session.goto(
      `${baseUrl}/buddies/workspaces/${encodeURIComponent(workspaceId)}/channels`,
      500
    );
    await waitFor('!!document.querySelector("[data-worker-row]")');
    const layout = await session.evaluate(`(${inspectChannelStarLayout.toString()})()`);
    assert.ok(layout.checked > 0, 'Shared highlight rows must render with their right-side stars');
    const duplicate = await session.evaluate(`
      [...document.querySelectorAll('h2, h3')].some(heading => heading.textContent === 'Direct messages')
    `);
    assert.equal(duplicate, false, `${width}px: duplicate Direct messages section returned`);
    if (width > 768) {
      const rows = await session.evaluate(`
        [...document.querySelectorAll('.channel-browser-buddy')].map(row => {
          const bounds = row.getBoundingClientRect();
          const list = row.parentElement.getBoundingClientRect();
          return { height: bounds.height, overflow: bounds.right - list.right };
        })
      `);
      assert.ok(rows.length > 0, 'Buddy rows must render');
      assert.ok(
        rows.every((row) => row.height <= 26),
        `Buddy rows stretched: ${JSON.stringify(rows)}`
      );
      assert.ok(
        rows.every((row) => row.overflow <= 1),
        `Buddy rows overflowed: ${JSON.stringify(rows)}`
      );
      const gap = await session.evaluate(
        `getComputedStyle(document.querySelector('.channel-browser-channels button')).columnGap`
      );
      assert.ok(Number.parseFloat(gap) <= 4, `Channel hash spacing grew: ${gap}`);
      console.log(
        `Desktop: ${rows.length} Buddy rows fit the rail at 26px or less; hash gap ${gap}`
      );
    }
    console.log(`${width}px: no workspace bullets or duplicate Direct messages section`);
  }
} finally {
  await session.close();
}
