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
const mode = process.argv[2];
const desktop = await launch();
try {
  await desktop.s('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await desktop.goto(`${BASE}/`, 4000);
  await desktop.clickText('Continue →');
  await sleep(3500);
  const scrollTo = `[...document.querySelectorAll('strong')].find((e) => e.textContent === 'Connect from mobile')?.scrollIntoView({ block: 'start' })`;
  if (mode === 'ready') {
    await desktop.evaluate(scrollTo);
    await sleep(400);
    report.confirmShown = await desktop.evaluate(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Tailscale is set up on my phone')`);
    report.qrBeforeConfirm = await desktop.evaluate(`!!document.querySelector('img[alt="QR code that signs your phone in"]')`);
    await desktop.shot('05-confirm-phone.png');
    await desktop.clickText('Tailscale is set up on my phone');
    await sleep(1500);
    report.qrAfterConfirm = await desktop.evaluate(`!!document.querySelector('img[alt="QR code that signs your phone in"]')`);
    report.qrCenterOffsetPx = await desktop.evaluate(`(() => {
      const img = document.querySelector('img[alt="QR code that signs your phone in"]');
      const section = document.getElementById('connect-mobile');
      const a = img.getBoundingClientRect(), b = section.getBoundingClientRect();
      return Math.round((a.left + a.width / 2) - (b.left + b.width / 2));
    })()`);
    await desktop.evaluate(`document.querySelector('img[alt="QR code that signs your phone in"]').scrollIntoView({ block: 'center' })`);
    await sleep(400);
    await desktop.shot('06-qr-centered.png');
  } else {
    await desktop.evaluate(scrollTo);
    await sleep(400);
    report.status = await desktop.evaluate(`document.getElementById('connect-mobile')?.innerText.split('\\n').slice(0, 3).join(' | ')`);
    report.anyQrOrConfirm = await desktop.evaluate(`!!document.querySelector('img[alt="QR code that signs your phone in"]') || [...document.querySelectorAll('button')].some((b) => b.textContent.includes('set up on my phone'))`);
    await desktop.shot('07-no-tailscale.png');
  }
} finally {
  await desktop.close();
}
console.log(JSON.stringify(report, null, 1));
