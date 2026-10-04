/**
 * headless-chrome.mjs — the shared driver behind the screenshot tools.
 *
 * Zero dependencies: drives headless Chrome over the DevTools Protocol using
 * Node's global WebSocket (Node >= 22). Deliberately does NOT add playwright or
 * puppeteer — this repo has neither, and a screenshot script is not worth a
 * browser download in every install.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findChrome() {
  const found = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(
      `No Chrome/Chromium found. Looked in:\n  ${CHROME_CANDIDATES.join('\n  ')}\nSet one of these paths, or install Chrome.`
    );
  }
  return found;
}

/**
 * The server's shared secret, resolved in the server's own order
 * (server/src/auth/policy.ts): UNLEASHD_AUTH_TOKEN, UNLEASHD_AUTH_TOKEN_FILE,
 * then <UNLEASHD_DATA_DIR or ~/.agent-viewer>/auth-token. Null means no secret
 * is configured; a gated server then answers 401 and `openSession` says so.
 */
export function resolveAuthToken(env = process.env) {
  const inline = env.UNLEASHD_AUTH_TOKEN?.trim();
  if (inline) return inline;
  const dataDir = env.UNLEASHD_DATA_DIR?.trim() || path.join(os.homedir(), '.agent-viewer');
  const file = env.UNLEASHD_AUTH_TOKEN_FILE?.trim() || path.join(dataDir, 'auth-token');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() || null : null;
}

/** Minimal CDP client: one socket, id-matched responses, event waiters. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error)})`));
        else resolve(msg.result);
      }
      for (const listener of this.listeners) listener(msg);
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error(`CDP connect failed: ${wsUrl}`)), {
        once: true,
      });
    });
    return new Cdp(ws);
  }

  // `params` keeps its default on purpose. The rule's unsafe fix removed it on
  // 2026-09-06, which changed this method's contract (a two-arg call would send
  // `params: undefined` to CDP instead of `{}`). Reordering is not an option
  // either: `sessionId` is optional and must stay last.
  // biome-ignore lint/style/useDefaultParameterLast: sessionId must remain the trailing optional
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  once(method, sessionId, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      const listener = (msg) => {
        if (msg.method !== method) return;
        if (sessionId && msg.sessionId !== sessionId) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(msg.params);
      };
      this.listeners.add(listener);
    });
  }
}

async function launchChrome(chromePath) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unleashd-shots-'));
  const child = spawn(
    chromePath,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--hide-scrollbars',
      // Software raster and WebGL: on the GPU path the Buddy sigil shader
      // rendered a few hundred different speckle pixels per card between two
      // runs, and status-dot edges antialiased differently (2026-09-25).
      '--disable-gpu',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      // The dev server is plain http on a LAN-ish origin; no need for the
      // sandbox in a throwaway profile, and it avoids CI permission issues.
      '--no-sandbox',
      'about:blank',
    ],
    // No pipes: nothing reads Chrome's output, and a helper process that
    // outlives the SIGKILL (crashpad) inherited the stderr pipe, which kept the
    // Node process alive after a finished run (2026-09-25).
    { stdio: 'ignore' }
  );

  // Chrome writes the chosen port here once the debugger is listening.
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(portFile)) {
      const [port] = fs.readFileSync(portFile, 'utf8').split('\n');
      if (port) return { child, userDataDir, port: Number(port) };
    }
    await sleep(100);
  }
  child.kill('SIGKILL');
  throw new Error('Chrome did not expose a DevTools port within 20s');
}

/**
 * Stable pixels, installed before any page script runs:
 *
 * - A frozen clock. Every "3m ago" and "Resets in 2h" is computed from
 *   Date.now(), so two runs minutes apart rendered different text. Pinning
 *   Date to one instant (the baseline run's, via --baseline) makes relative
 *   times identical without touching a single component. Timers still run —
 *   setTimeout/rAF/performance.now are untouched — only wall time stands still.
 * - Motion jumps to its end. Spinners, pulses, fades and blinking carets are
 *   caught mid-frame at whatever moment the capture lands. Zero-length
 *   animations (not `animation: none`) still fire animationend, so components
 *   that wait for it keep working; a transparent caret removes the blink.
 * - `[data-volatile]` is removed from layout: the escape hatch for a region
 *   that is live by nature and cannot be stabilised by the clock. display:none,
 *   not visibility:hidden — a hidden timestamp still changed width and
 *   reflowed the sentence after it (buddy-team, 2026-09-25).
 * - No writes leave the page. fetch/XHR/sendBeacon with a method other than
 *   GET/HEAD/OPTIONS reject as a network error would, and WebSocket.send is a
 *   no-op (every client→server WS message is a command: create, send, stop,
 *   done, delete, queue, config). Before this, opening a channel POSTed
 *   `owner-read` to whatever server the tool pointed at — the owner's live one.
 *   Blocked writes are recorded in `window.__screenshotBlocked`.
 *   Guarded in the page, not with CDP Fetch interception: pausing every request
 *   through CDP stalled the app's idle-time chunk preloads so the network never
 *   went quiet (measured 2026-09-25: 22 requests still open after 90s).
 */
// Pattern: fix-guards (docs/patterns.md#fix-guards)
function stabilisingScript(clockMs) {
  return `(() => {
  const T0 = ${Number(clockMs)};
  const RealDate = Date;
  globalThis.Date = new Proxy(RealDate, {
    construct: (target, args, newTarget) =>
      Reflect.construct(target, args.length ? args : [T0], newTarget),
    apply: () => new RealDate(T0).toString(),
    get: (target, key, receiver) => (key === 'now' ? () => T0 : Reflect.get(target, key, receiver)),
  });
  const blocked = (window.__screenshotBlocked = []);
  const READS = new Set(['GET', 'HEAD', 'OPTIONS']);
  const realFetch = window.fetch;
  window.fetch = (input, init) => {
    const request = new Request(input, init);
    if (READS.has(request.method)) return realFetch(request);
    blocked.push(request.method + ' ' + new URL(request.url).pathname);
    return Promise.reject(new TypeError('Failed to fetch (blocked: read-only screenshot session)'));
  };
  const realOpen = XMLHttpRequest.prototype.open;
  const realSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__screenshotWrite = READS.has(String(method).toUpperCase())
      ? null
      : String(method).toUpperCase() + ' ' + new URL(url, location.href).pathname;
    return realOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    if (!this.__screenshotWrite) return realSend.call(this, body);
    blocked.push(this.__screenshotWrite);
    this.abort();
  };
  navigator.sendBeacon = (url) => {
    blocked.push('BEACON ' + new URL(url, location.href).pathname);
    return false;
  };
  WebSocket.prototype.send = function () {
    blocked.push('WS send');
  };
  const css = \`*, *::before, *::after {
    animation-duration: 0s !important; animation-delay: 0s !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0s !important; transition-delay: 0s !important;
    caret-color: transparent !important;
  }
  [data-volatile] { display: none !important; }\`;
  document.addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.dataset.screenshotStabiliser = '';
    style.textContent = css;
    document.documentElement.appendChild(style);
  }, { once: true });
})();`;
}

/** One blank headless tab: the base both the app session and the comparer use. */
async function openTab() {
  const { child, userDataDir, port } = await launchChrome(findChrome());
  let cdp;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  // Wait for Chrome to exit before deleting its profile: a killed Chrome still
  // flushes files for a moment, and rmSync then fails ENOTEMPTY — which, from a
  // `finally`, replaced the real error the script was about to report.
  const close = async () => {
    try {
      cdp?.ws.close();
    } catch {
      // socket already gone
    }
    child.kill('SIGKILL');
    await exited;
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };

  try {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    cdp = await Cdp.connect(version.webSocketDebuggerUrl);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);

    const evaluate = async (expression) => {
      const result = await cdp.send(
        'Runtime.evaluate',
        { expression, returnByValue: true, awaitPromise: true },
        sessionId
      );
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
      }
      return result.result?.value;
    };
    return { cdp, sessionId, evaluate, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * A blank tab for in-browser computation (the PNG comparer decodes images with
 * createImageBitmap here). Returns { evaluate, close }; `await close()` in a
 * finally.
 */
export async function openBlankTab() {
  const { evaluate, close } = await openTab();
  return { evaluate, close };
}

/**
 * One headless tab against the running app, already authenticated: the
 * `?token=` navigation sets the gate's cookie for every later page load.
 *
 * READ-ONLY: the page cannot send a write (see stabilisingScript).
 * `blockedWrites()` lists what was refused so a run can report it.
 *
 * `clockMs` is the instant the page's Date is frozen at (see stabilisingScript).
 *
 * Returns { goto, evaluate, setViewport, waitForNetworkIdle, capture,
 * click, blockedWrites, close }.
 * `await close()` must run (use try/finally) or a Chrome process outlives the
 * script.
 */
export async function openSession({ baseUrl, token, clockMs }) {
  const { cdp, sessionId, evaluate, close } = await openTab();
  try {
    // In-flight HTTP requests, for waitForNetworkIdle. WebSocket and
    // EventSource streams never finish, so they are not counted.
    const inFlight = new Map();
    let lastNetworkChange = Date.now();
    cdp.listeners.add((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Network.requestWillBeSent') {
        if (msg.params.type === 'WebSocket' || msg.params.type === 'EventSource') return;
        inFlight.set(msg.params.requestId, msg.params.request.url);
      } else if (
        msg.method === 'Network.loadingFinished' ||
        msg.method === 'Network.loadingFailed'
      ) {
        inFlight.delete(msg.params.requestId);
      } else {
        return;
      }
      lastNetworkChange = Date.now();
    });
    await cdp.send('Network.enable', {}, sessionId);
    await cdp.send(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: stabilisingScript(clockMs) },
      sessionId
    );

    // Blocked writes are recorded in the page, so a navigation would drop them:
    // bank them before leaving each page.
    const blocked = [];
    const pageBlocked = async () => (await evaluate('window.__screenshotBlocked ?? []')) ?? [];
    const goto = async (url, settleMs) => {
      blocked.push(...(await pageBlocked()));
      // Every page starts from empty device-local state. The app keeps UI prefs
      // in localStorage — including the last active chat, which desktop `/`
      // restores — so without this a screen's pixels depended on which screens
      // ran before it, and `--only x` shot a different `x` than a full run.
      // Cookies are kept: they carry the auth session.
      await cdp.send(
        'Storage.clearDataForOrigin',
        {
          origin: new URL(url).origin,
          storageTypes: 'local_storage,session_storage,indexeddb,cache_storage',
        },
        sessionId
      );
      // A request the previous page left open gets no loadingFinished/Failed
      // once its document is gone, and would hold every later idle wait open.
      inFlight.clear();
      const loaded = cdp.once('Page.loadEventFired', sessionId, 30_000);
      const { errorText } = await cdp.send('Page.navigate', { url }, sessionId);
      if (errorText) throw new Error(`navigate ${url}: ${errorText}`);
      await loaded;
      await sleep(settleMs);
    };

    /** viewport: { width, height, deviceScaleFactor, mobile } — touch follows `mobile`. */
    const setViewport = async (viewport) => {
      await cdp.send('Emulation.setDeviceMetricsOverride', viewport, sessionId);
      // The app picks its tree by width alone, but touch keeps hover/pointer
      // media queries honest for the phone and tablet sizes.
      await cdp.send(
        'Emulation.setTouchEmulationEnabled',
        // maxTouchPoints must be 1..16 even when disabling.
        { enabled: viewport.mobile, maxTouchPoints: 5 },
        sessionId
      );
    };

    /**
     * Resolve [] once no HTTP request has been in flight for `quietMs`, or
     * the open URLs after `timeoutMs`. A fixed settle raced the app's second-wave
     * loads (the usage panel, a swarm counter, a transcript that loads after
     * its summary): one run caught the "Loading…" placeholder and the next did
     * not, which a compare reports as a regression. Polled fetches refire on an
     * interval, so a short quiet window is reachable between them.
     * `ignore` matches URLs of background work that paints nothing on the
     * screen under test (the caller knows which).
     */
    const waitForNetworkIdle = async (quietMs, timeoutMs, ignore) => {
      const deadline = Date.now() + timeoutMs;
      const pending = () => [...inFlight.values()].filter((url) => !ignore.test(url));
      while (Date.now() < deadline) {
        if (pending().length === 0 && Date.now() - lastNetworkChange >= quietMs) return [];
        await sleep(50);
      }
      // Still-open requests on timeout, so a run can say what never finished.
      return pending();
    };

    // A real user gesture is required by native clipboard permissions; calling
    // element.click() through Runtime.evaluate does not create one.
    const click = async (selector) => {
      const point = await evaluate(`(() => {
        const element = document.querySelector(${JSON.stringify(selector)});
        if (!element) throw new Error('No element for click');
        element.scrollIntoView({block: 'center'});
        const rect = element.getBoundingClientRect();
        return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
      })()`);
      await cdp.send('Page.bringToFront', {}, sessionId);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', {type, ...point, button: 'left', clickCount: 1}, sessionId);
      }
    };

    const capture = async (file) => {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
    };

    const blockedWrites = async () => [...blocked, ...(await pageBlocked())];

    await goto(token ? `${baseUrl}/?token=${encodeURIComponent(token)}` : `${baseUrl}/`, 500);
    const gated = await evaluate(`document.title.toLowerCase().includes('sign in') ||
      !!document.querySelector('form input[type=password]')`);
    if (gated) {
      throw new Error(
        token
          ? 'The auth gate rejected the token — is it the running server’s secret?'
          : 'The server is gated and no token was found (UNLEASHD_AUTH_TOKEN, UNLEASHD_AUTH_TOKEN_FILE, ~/.agent-viewer/auth-token).'
      );
    }

    return { goto, evaluate, setViewport, waitForNetworkIdle, capture, click, blockedWrites, close };
  } catch (error) {
    await close();
    throw error;
  }
}
