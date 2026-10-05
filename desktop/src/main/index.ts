import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
// Buddies desktop main process (Cottontail). It does not run Buddies itself: it
// starts the UNMODIFIED server (server/dist/server.js) with the bundled Node as a
// child process, waits for its HTTP port, and points a CEF window at it.
//
// State lives in BUDDIES_DESKTOP_HOME (default ~/Library/Application Support/Buddies),
// never in the CLI's ~/.agent-viewer or ~/.buddies, so the app and a source checkout
// can run side by side without sharing SQLite stores.
import Electrobun, { BrowserWindow, PATHS } from 'electrobun/main';

const startedAt = Date.now();
const payload = join(PATHS.RESOURCES_FOLDER, 'app', 'payload');
const home =
  process.env.BUDDIES_DESKTOP_HOME ?? join(homedir(), 'Library', 'Application Support', 'Buddies');
mkdirSync(home, { recursive: true });
const logFile = join(home, 'desktop.log');

function log(message: string) {
  appendFileSync(logFile, `${new Date().toISOString()} +${Date.now() - startedAt}ms ${message}\n`);
}

/** The server refuses tokens under 16 chars; the file is the auth policy's default location. */
function authToken(dataDir: string): string {
  const file = join(dataDir, 'auth-token');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}

function sparePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') return reject(new Error('no port'));
      probe.close(() => resolve(address.port));
    });
  });
}

async function waitForServer(origin: string, token: string, server: { exited: Promise<number> }) {
  let exitCode: number | null = null;
  server.exited.then((code) => {
    exitCode = code;
  });
  for (let attempt = 0; attempt < 600; attempt++) {
    if (exitCode !== null)
      throw new Error(`server exited ${exitCode} before listening; see server.log`);
    try {
      const response = await fetch(`${origin}/api/provider-catalog`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(100);
  }
  throw new Error('server did not answer within 60s; see server.log');
}

const dataDir = join(home, 'agent-viewer');
const buddiesHome = join(home, 'buddies');
mkdirSync(dataDir, { recursive: true });
mkdirSync(buddiesHome, { recursive: true });
const token = authToken(dataDir);
// The server's first boot installs Rust (`brew install rust`, else rustup) for source
// builds. A packaged app never builds from source: the spike's first launch started
// `brew install rust` against the machine's Homebrew. Claiming the server's own
// once-per-install marker skips that installer; Claude/Codex installs still run.
// TODO(desktop): replace with an explicit server setting instead of the marker file.
mkdirSync(join(dataDir, 'dependency-setup'), { recursive: true });
const rustClaim = join(dataDir, 'dependency-setup', 'rust.attempted');
if (!existsSync(rustClaim)) writeFileSync(rustClaim, 'desktop app: no source builds\n');
const port = Number(process.env.BUDDIES_DESKTOP_PORT ?? (await sparePort()));
const origin = `http://127.0.0.1:${port}`;
const nodeBin = join(payload, 'node', 'bin');

// Finder launches apps with PATH=/usr/bin:/bin:/usr/sbin:/sbin. The bundled node
// goes first so `#!/usr/bin/env node` agent shims resolve to it; the server adds
// ~/.local/bin and ~/.cargo/bin itself when it probes for agent CLIs.
const server = Bun.spawn([join(nodeBin, 'node'), join(payload, 'server', 'dist', 'server.js')], {
  cwd: payload,
  env: {
    ...process.env,
    PATH: [nodeBin, process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'].join(':'),
    NODE_ENV: 'production',
    PORT: String(port),
    UNLEASHD_HOST: '127.0.0.1',
    UNLEASHD_DATA_DIR: dataDir,
    BUDDIES_HOME: buddiesHome,
    UNLEASHD_BUDDIES_DB: join(buddiesHome, 'buddies-v3.sqlite'),
  },
  stdout: Bun.file(join(home, 'server.log')),
  stderr: Bun.file(join(home, 'server.err.log')),
});
log(`spawned server pid=${server.pid} port=${port} payload=${payload}`);

let stopping = false;
function stopServer() {
  if (stopping) return;
  stopping = true;
  log(`stopping server pid=${server.pid}`);
  server.kill('SIGTERM');
}
Electrobun.events.on('before-quit', () => stopServer());
process.on('exit', () => stopServer());

// The window opens on a bundled page while the server boots (~250ms warm).
const window = new BrowserWindow({
  title: 'Buddies',
  url: 'views://loading/index.html',
  renderer: 'cef',
  frame: { width: 1280, height: 840, x: 120, y: 80 },
});
window.webview.on('dom-ready', () => log('dom-ready'));
window.on('close', () => {
  stopServer();
  Electrobun.Utils.quit();
});
log('window opened');

await waitForServer(origin, token, server);
log(`server ready ${origin}`);

// `?token=` sets the HttpOnly auth cookie and redirects to the same path without it,
// so the WebSocket handshake is authorized by the cookie like any browser session.
// The gate reads a cookie BEFORE the query, and cookies ignore the port: a cookie
// left by an earlier server on 127.0.0.1 with another token (fresh data dir, other
// port) is rejected and the valid ?token= is never read, so the window showed the
// login page on every launch after the first. Electrobun's Session cookie API does
// not reach the window's (global CEF) jar — remove() returned false, get() saw 0 —
// so the server's own public /__auth/logout clears it, then ?token= signs in.
// TODO(desktop): a valid ?token= should win over a stale cookie in the gate itself.
const signIn =
  process.env.BUDDIES_DESKTOP_TABS === '1'
    ? `views://tabs/index.html?origin=${encodeURIComponent(origin)}&token=${token}`
    : `${origin}/?token=${token}`;
let signedOut = false;
window.webview.on('dom-ready', () => {
  if (signedOut) return;
  signedOut = true; // the logout redirect landed on the login page
  window.webview.loadURL(signIn);
});
window.webview.loadURL(`${origin}/__auth/logout`);
