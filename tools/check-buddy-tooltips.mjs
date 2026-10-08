#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, unlinkSync } from 'node:fs';
import { openSession, resolveAuthToken, sleep } from './lib/headless-chrome.mjs';
const [workspaceId, baseUrl = 'http://localhost:7489', out] = process.argv.slice(2);
assert(workspaceId, 'Pass a workspace with an active Buddy');
const session = await openSession({ baseUrl, token: resolveAuthToken() });
const visibleText = () =>
  session.evaluate("document.querySelector('[role=tooltip]')?.textContent ?? ''");
try {
  await session.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await session.goto(`${baseUrl}/buddies/workspaces/${workspaceId}/channels`, 500);
  for (let i = 0; i < 100; i++) {
    if (
      await session.evaluate("!!document.querySelector('[data-worker-row] .buddy-background-link')")
    )
      break;
    await sleep(100);
  }
  await session.evaluate(`(async()=>{
    const ui=await import('/src/atoms/ui.ts');
    ui.setSetupDismissed(true); ui.dismissHomeScreenGuide();
  })()`);
  const wake = '[data-worker-row] button[aria-label^="Wake "]';
  const worker = '[data-worker-row] .buddy-background-link';
  for (const [selector, expected, name] of [
    [wake, /Wake up .+: catch up on the channels and act/, 'wake'],
    [worker, /\d+ workers? running|Loading workers/, 'workers'],
  ]) {
    await session.hover(selector);
    await sleep(200);
    assert.match(await visibleText(), expected);
    const geometry = await session.evaluate(`(()=>{
      const tooltip=document.querySelector('[role=tooltip]');
      const trigger=document.querySelector(${JSON.stringify(selector)});
      const r=tooltip.getBoundingClientRect();
      return {
        described:trigger.getAttribute('aria-describedby')===tooltip.id,
        body:tooltip.parentElement===document.body,
        visible:r.width>0&&r.height>0&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight
      };
    })()`);
    assert.deepEqual(geometry, { described: true, body: true, visible: true });
    if (out) {
      mkdirSync(out, { recursive: true });
      const png = `${out}/${name}.png`;
      await session.capture(png);
      execFileSync('cwebp', ['-quiet', '-q', '95', png, '-o', `${out}/${name}.webp`]);
      unlinkSync(png);
    }
    await session.hover('[role=tooltip]');
    await sleep(200);
    assert.match(await visibleText(), expected, 'tooltip must remain readable under the pointer');
    await session.hover('.channel-browser-workspace');
    await sleep(200);
    assert.equal(await visibleText(), '', 'tooltip must dismiss when the pointer leaves');
    await session.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    await sleep(100);
    assert.match(await visibleText(), expected, 'keyboard focus must show the same tooltip');
    await session.evaluate("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))");
    await sleep(100);
    assert.equal(await visibleText(), '', 'Escape must dismiss the tooltip');
    await session.evaluate('document.activeElement.blur()');
    console.log(name, 'real hover, painted portal, pointer persistence, focus and Escape pass');
  }
  assert.deepEqual(await session.blockedWrites(), []);
} finally {
  await session.close();
}
