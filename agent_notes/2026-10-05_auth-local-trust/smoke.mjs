// Real-browser smoke for the auth change: local browser with no key, the
// Connect-mobile QR, and a "remote" phone redeeming the pairing link.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = 'http://localhost:7531';
const OUT = path.dirname(new URL(import.meta.url).pathname);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-chrome-'));
  const child = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else events.push(msg);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params, sessionId }));
    });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (method, params) => send(method, params, sessionId);
  await s('Page.enable');
  await s('Runtime.enable');
  await s('Network.enable');
  const evaluate = async (expression) => {
    const r = await s('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
    return r.result?.value;
  };
  return {
    s, evaluate,
    goto: async (url, settle = 2500) => { await s('Page.navigate', { url }); await sleep(settle); },
    shot: async (name) => {
      const { data } = await s('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64'));
    },
    clickText: async (text) => {
      const point = await evaluate(`(() => {
        const el = [...document.querySelectorAll('button, a')].find((e) => e.textContent.trim() === ${JSON.stringify(text)});
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`);
      if (!point) throw new Error(`no button "${text}"`);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await s('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
      }
    },
    close: async () => { ws.close(); child.kill('SIGKILL'); },
  };
}

const report = {};
const desktop = await launch();
try {
  await desktop.s('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await desktop.goto(`${BASE}/`, 4000);
  const body = await desktop.evaluate('document.body.innerText');
  report.localUrl = await desktop.evaluate('location.pathname');
  report.localShowsLogin = /Enter your access key/.test(body);
  await desktop.shot('01-local-no-key.png');
  // Fresh install: onboarding opens on Welcome; Setup holds Connect from mobile.
  await desktop.clickText('Continue →');
  await sleep(3000);
  await desktop.clickText('Show QR code');
  await sleep(1500);
  report.qrShown = await desktop.evaluate(`!!document.querySelector('img[alt="QR code that signs your phone in"]')`);
  report.pairUrl = await desktop.evaluate(`[...document.querySelectorAll('input')].map((i) => i.value).find((v) => v.includes('ts.net')) ?? null`);
  await desktop.evaluate(`document.querySelector('img[alt="QR code that signs your phone in"]')?.scrollIntoView({ block: 'center' })`);
  await sleep(300);
  await desktop.shot('02-connect-mobile-qr.png');
  // The code itself, read back from the QR's own request, for the phone leg.
  report.code = await desktop.evaluate(`fetch('/api/mobile-access/pairing', { method: 'POST' }).then((r) => r.json()).then((p) => new URL(p.url).search)`);
} finally {
  await desktop.close();
}

const phone = await launch();
try {
  await phone.s('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  // What Serve sends for a device that is not the owner's: forwarded, no login.
  await phone.s('Network.setExtraHTTPHeaders', { headers: { 'X-Forwarded-For': '100.101.102.103' } });
  await phone.goto(`${BASE}/`, 2500);
  report.remoteShowsLogin = /Enter your access key/.test(await phone.evaluate('document.body.innerText'));
  await phone.shot('03-remote-before-pairing.png');
  await phone.goto(`${BASE}/__auth/pair${report.code}`, 4000);
  report.remoteAfterPairPath = await phone.evaluate('location.pathname');
  report.remoteAfterPairShowsLogin = /Enter your access key/.test(await phone.evaluate('document.body.innerText'));
  await phone.shot('04-remote-after-pairing.png');
} finally {
  await phone.close();
}
console.log(JSON.stringify(report, null, 1));
