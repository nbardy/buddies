// Render the workspace Home with a CSS override file layered on top (read-only session, no code
// change). The design-iteration loop: edit the override, re-render, compare, repeat; the converged
// override becomes the patch for ChannelLanding.css.
// Run with the dev server up:
//   node product/design/workspace-home/render-override.mjs <workspaceId> <override.css|-> <out.png> [width] [scrollY]
import * as fs from 'node:fs';
import { openSession, resolveAuthToken, sleep } from '../../../tools/lib/headless-chrome.mjs';

const base = 'http://localhost:7489';
const [workspace, cssFile, out, width = '1440', scrollY = '0'] = process.argv.slice(2);
const css = cssFile === '-' ? '' : fs.readFileSync(cssFile, 'utf8');

const session = await openSession({ baseUrl: base, token: resolveAuthToken(), clockMs: Date.now() });
try {
  await session.setViewport({ width: Number(width), height: 900, deviceScaleFactor: 2, mobile: false });
  await session.goto(`${base}/buddies/workspaces/${workspace}/channels`, 3000);
  await session.waitForNetworkIdle(500, 20000, /sigil|prefetch/);
  await sleep(1200);
  // Freeze the aura so renders differ only by the override.
  await session.evaluate(`document.getAnimations().forEach(a => { a.pause(); a.currentTime = 0; })`);
  await session.evaluate(`(() => {
    const s = document.createElement('style'); s.textContent = ${JSON.stringify(css)}; document.head.append(s);
    const pane = document.querySelector('.landing')?.closest('[class*="scroll"]') ?? document.scrollingElement;
    pane.scrollTop = ${Number(scrollY)};
    return document.fonts.ready.then(() => true);
  })()`);
  await sleep(500);
  await session.capture(out);
} finally {
  await session.close();
}
