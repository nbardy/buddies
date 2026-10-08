// Real channel boundary: HTML links open the shared viewer, run scripts in an opaque origin,
// and keep the parent inaccessible. Use a real uploaded HTML link, never mutate channel data.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { openSession, resolveAuthToken, sleep } from './lib/headless-chrome.mjs';

const [baseUrl, pagePath, linkPath, out] = process.argv.slice(2);
if (!out)
  throw new Error(
    'Usage: node tools/check-channel-html-viewer.mjs BASE_URL PAGE_PATH LOCAL_HTML_PATH OUTPUT_DIR'
  );
fs.mkdirSync(out, { recursive: true });
const session = await openSession({ baseUrl, token: resolveAuthToken() });
const checks = [];
try {
  for (const [name, width, height] of [
    ['desktop', 1440, 900],
    ['phone', 375, 812],
  ]) {
    await session.setViewport({ width, height, deviceScaleFactor: 1, mobile: width < 768 });
    await session.goto(`${baseUrl}${pagePath}`, 1500);
    await session.waitForNetworkIdle(500, 20000, /\/messages\?/);
    const href = `/api/files?path=${encodeURIComponent(linkPath)}`;
    const selector = `a[href=${JSON.stringify(href)}]`;
    await session.evaluate(
      `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center'})`
    );
    await session.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    for (let i = 0; i < 100; i++) {
      if (
        await session.evaluate("!!document.querySelector('.channel-file-overlay iframe[srcdoc]')")
      )
        break;
      await sleep(100);
    }
    const state = await session.evaluate(`(() => {
      const dialog = document.querySelector('.channel-file-overlay');
      const frame = dialog?.querySelector('iframe');
      return { open: dialog?.open, sandbox: frame?.getAttribute('sandbox'),
        html: !!frame?.srcdoc, download: dialog?.querySelector('a[download]')?.getAttribute('href') };
    })()`);
    assert.equal(state.open, true);
    assert.equal(state.html, true);
    assert.equal(state.sandbox, 'allow-scripts allow-downloads');
    assert.equal(state.download, href);
    await sleep(1000);
    // The probe runs INSIDE the real sandboxed document, after its own scripts.
    await session.evaluate(`(() => {
      window.__htmlViewerProbe = null;
      const frame = document.querySelector('.channel-file-overlay iframe');
      window.addEventListener('message', event => {
        if (event.source === frame.contentWindow && event.data?.viewerProbe) window.__htmlViewerProbe = event.data;
      });
      frame.srcdoc = frame.srcdoc + '<script>let denied=false;try{void parent.document.cookie}catch{denied=true}const left=document.getElementById("left"),swap=document.getElementById("swap");const before=left?.value;swap?.click();parent.postMessage({viewerProbe:true,denied,title:document.title,options:document.querySelectorAll("select option").length,swapped:swap?left.value!==before:null,fragment:[...document.links].find(a=>a.hash)?.href??null},"*")<\/script>';
    })()`);
    let probe;
    for (let i = 0; i < 100; i++) {
      probe = await session.evaluate('window.__htmlViewerProbe');
      if (probe) break;
      await sleep(100);
    }
    assert.equal(probe?.denied, true, 'HTML scripts cannot read the app document/cookies');
    if (probe.swapped !== null) assert.equal(probe.swapped, true, 'The linked page controls work');
    if (probe.fragment) assert.ok(probe.fragment.startsWith('about:srcdoc#'));
    assert.ok(probe.title, 'The linked HTML renders');
    const png = path.join(out, `${name}.png`);
    await session.capture(png);
    execFileSync('cwebp', ['-quiet', '-q', '95', png, '-o', path.join(out, `${name}.webp`)]);
    fs.unlinkSync(png);
    checks.push({ name, state, probe });
    await session.click('.channel-file-close');
    assert.equal(
      await session.evaluate("!!document.querySelector('.channel-file-overlay')"),
      false
    );
  }
  fs.writeFileSync(
    path.join(out, 'checks.json'),
    JSON.stringify({ checks, blockedWrites: await session.blockedWrites() }, null, 2)
  );
  console.log(JSON.stringify(checks));
} finally {
  await session.close();
}
