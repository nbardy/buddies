import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { WS_PATH } from '@unleashd/shared';
import { WebSocket } from 'ws';
import { decideAuth } from '../src/auth/gate';
import { digestToken, resolveAuthPolicy } from '../src/auth/policy';
import { NO_AUTO_INSTALL } from './fixtures/backend-env';
import { freePortSync } from './free-port';

/**
 * Boots the real server process with a shared secret configured and probes it
 * over real sockets. The point is the wiring, not the helpers: a unit test of
 * `decideAuth` would still pass if someone mounted the gate after the routes,
 * or restored `new WebSocketServer({ server })` and made every upgrade public
 * again.
 */

// Fixed 7527 collided across suite runs. Guard: two concurrent full server suites.
const PORT = freePortSync();
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'f4c1a9e2b7d60358f4c1a9e2b7d60358';
const OWNER = 'owner@example.com';
const TS_HOST = 'buddies-mac.tail0000.ts.net';

/**
 * The test client is always on loopback, which this machine's browser is
 * admitted from without a key. These headers are what `tailscale serve` sends
 * for a device with no user login (a tagged device): forwarded from a tailnet
 * address, so it must present the key like any other remote caller.
 */
const REMOTE = { 'x-forwarded-for': '100.101.102.103' } as const;
/** What Serve sends for the owner's own phone. */
const OWNER_PHONE = {
  host: TS_HOST,
  'x-forwarded-for': '100.64.0.7',
  'x-forwarded-host': TS_HOST,
  'x-forwarded-proto': 'https',
  'tailscale-user-login': OWNER,
} as const;

let serverProcess: ChildProcess | null = null;
let dataDirectory = '';

function startServer(): Promise<void> {
  dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'unleashd-auth-'));
  // The conventional token path is the documented default — exercise it rather
  // than the env var, which is the discouraged option.
  fs.writeFileSync(path.join(dataDirectory, 'auth-token'), `${TOKEN}\n`, 'utf8');
  const shimDirectory = path.join(dataDirectory, 'bin');
  fs.mkdirSync(shimDirectory, { recursive: true });
  const shim = path.join(shimDirectory, 'claude');
  fs.writeFileSync(shim, '#!/bin/sh\nexit 0\n', 'utf8');
  fs.chmodSync(shim, 0o755);
  // A tailnet owned by OWNER whose Serve forwards TS_HOST to this server.
  const status = { BackendState: 'Running', Self: { DNSName: `${TS_HOST}.`, UserID: 7 } };
  const serve = { Web: { [`${TS_HOST}:443`]: { Handlers: { '/': { Proxy: BASE } } } } };
  fs.writeFileSync(
    path.join(shimDirectory, 'status.json'),
    JSON.stringify({ ...status, User: { '7': { LoginName: OWNER } } })
  );
  fs.writeFileSync(path.join(shimDirectory, 'serve.json'), JSON.stringify(serve));
  const tailscale = path.join(shimDirectory, 'tailscale');
  fs.writeFileSync(
    tailscale,
    `#!/bin/sh\ncase "$1" in\n  status) cat "${shimDirectory}/status.json";;\n  serve) cat "${shimDirectory}/serve.json";;\nesac\n`,
    'utf8'
  );
  fs.chmodSync(tailscale, 0o755);

  return new Promise((resolve, reject) => {
    serverProcess = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        HOME: dataDirectory,
        ...NO_AUTO_INSTALL,
        PATH: `${shimDirectory}${path.delimiter}${process.env.PATH ?? ''}`,
        PORT: String(PORT),
        // Not development: the UI is served from PORT itself, which is where
        // the fake Serve config points (development would expect Vite's 7489).
        NODE_ENV: 'test',
        UNLEASHD_DATA_DIR: dataDirectory,
        UNLEASHD_AUTH_TOKEN: '',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => reject(new Error('server did not start in 30s')), 30_000);
    // Both lines: the tailnet test needs the owner read, which lands in the
    // background and could trail "Server running" on a loaded machine.
    let output = '';
    serverProcess.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('Server running') && output.includes(`tailnet owner: ${OWNER}`)) {
        clearTimeout(timer);
        setTimeout(resolve, 300);
      }
    });
    serverProcess.stderr?.on('data', (chunk: Buffer) => {
      console.error('[server]', chunk.toString().trim());
    });
    serverProcess.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function stopServer(): Promise<void> {
  const child = serverProcess;
  serverProcess = null;
  if (child) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }
  if (dataDirectory) fs.rmSync(dataDirectory, { recursive: true, force: true });
}

/** node:http, not fetch: fetch will not send an arbitrary Host header. */
function probe(
  pathname: string,
  headers: Record<string, string>,
  method = 'GET'
): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port: PORT, path: pathname, method, headers },
      (response) => {
        response.resume();
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers })
        );
      }
    );
    request.on('error', reject);
    request.end();
  });
}

function connectWebSocket(headers: Record<string, string>): Promise<'open' | 'rejected'> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}${WS_PATH}`, { headers });
    const timer = setTimeout(() => {
      socket.terminate();
      resolve('rejected');
    }, 5_000);
    socket.on('open', () => {
      clearTimeout(timer);
      socket.close();
      resolve('open');
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve('rejected');
    });
  });
}

describe('shared-secret auth (real server)', () => {
  before(startServer);
  after(stopServer);

  test('API data is not served to a remote caller without a credential', async () => {
    const response = await fetch(`${BASE}/api/provider-catalog`, { headers: REMOTE });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
      error: 'unauthorized',
      message: 'Missing or invalid access key',
    });
  });

  test('bearer token unlocks the API', async () => {
    const response = await fetch(`${BASE}/api/provider-catalog`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 200);
  });

  test('a wrong key of a different length is rejected, not a crash', async () => {
    // timingSafeEqual throws on unequal buffer lengths; comparing SHA-256
    // digests is what keeps this a 401 instead of a 500.
    for (const wrong of ['x', `${TOKEN}extra`, TOKEN.replace('f', 'a')]) {
      const response = await fetch(`${BASE}/api/provider-catalog`, {
        headers: { ...REMOTE, authorization: `Bearer ${wrong}` },
      });
      assert.equal(response.status, 401, `expected 401 for ${wrong.slice(0, 8)}…`);
    }
  });

  test('the app shell itself is gated and answers with a login form', async () => {
    const response = await fetch(BASE, { headers: { ...REMOTE, accept: 'text/html' } });
    assert.equal(response.status, 401);
    const body = await response.text();
    assert.match(body, /action="\/__auth\/login"/);
    assert.match(body, /Enter your access key to continue/);
  });

  test('?token= establishes a cookie and strips itself from the URL', async () => {
    const response = await fetch(`${BASE}/?token=${TOKEN}`, {
      headers: { accept: 'text/html' },
      redirect: 'manual',
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/');
    const cookie = response.headers.get('set-cookie') ?? '';
    assert.match(cookie, /unleashd_auth=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);

    const withCookie = await fetch(`${BASE}/api/provider-catalog`, {
      headers: { ...REMOTE, cookie: `unleashd_auth=${TOKEN}` },
    });
    assert.equal(withCookie.status, 200);
  });

  test('the login form exchanges the key for a cookie', async () => {
    const response = await fetch(`${BASE}/__auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: TOKEN, redirectTo: '/chat/abc' }).toString(),
      redirect: 'manual',
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/chat/abc');
    assert.match(response.headers.get('set-cookie') ?? '', /unleashd_auth=/);

    const rejected = await fetch(`${BASE}/__auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: 'not-the-key-at-all' }).toString(),
      redirect: 'manual',
    });
    assert.equal(rejected.status, 401);
    assert.equal(rejected.headers.get('set-cookie'), null);
  });

  test('GET /__auth/login answers 200, so a 401 redirect cannot loop', async () => {
    // The client redirects here on any 401. If this path were itself gated the
    // browser would bounce between 401 and redirect forever.
    const response = await fetch(`${BASE}/__auth/login?redirectTo=/chat/xyz`, {
      headers: { ...REMOTE, accept: 'text/html' },
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /name="redirectTo" value="\/chat\/xyz"/);
  });

  test('a crafted redirectTo cannot turn the form into an open redirect', async () => {
    const response = await fetch(`${BASE}/__auth/login?redirectTo=//evil.example.com`, {
      headers: { ...REMOTE, accept: 'text/html' },
    });
    const body = await response.text();
    assert.match(body, /name="redirectTo" value="\/"/);
    assert.doesNotMatch(body, /evil\.example\.com/);
  });

  test('the JSON login path tells a wrong key apart from an unreachable server', async () => {
    // The form submits with Accept: application/json precisely so it can show
    // "Invalid access key" inline instead of reloading the whole page. A plain
    // 302/HTML response would collapse that distinction.
    const rejected = await fetch(`${BASE}/__auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ token: 'wrong-key-entirely' }).toString(),
    });
    assert.equal(rejected.status, 401);
    assert.deepEqual(await rejected.json(), { ok: false, error: 'invalid_key' });
    assert.equal(rejected.headers.get('set-cookie'), null);

    const accepted = await fetch(`${BASE}/__auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ token: TOKEN, redirectTo: '/buddies' }).toString(),
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { ok: true, redirectTo: '/buddies' });
    assert.match(accepted.headers.get('set-cookie') ?? '', /unleashd_auth=/);
  });

  test('the session cookie is persistent, not a session cookie', async () => {
    // Dropping Max-Age turns this into a session cookie, and the only symptom
    // is "my phone makes me sign in again every day" — which is nearly
    // untraceable after the fact. Pin the durability here.
    const response = await fetch(`${BASE}/__auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        // What `tailscale serve` sends; it is what makes the cookie Secure.
        'x-forwarded-proto': 'https',
      },
      body: new URLSearchParams({ token: TOKEN }).toString(),
      redirect: 'manual',
    });
    const cookie = response.headers.get('set-cookie') ?? '';

    const maxAge = Number(cookie.match(/Max-Age=(\d+)/)?.[1] ?? '0');
    assert.ok(maxAge >= 60 * 60 * 24 * 30, `Max-Age must outlast a month, got ${maxAge}s`);
    // Chrome silently clamps anything past 400 days.
    assert.ok(maxAge <= 60 * 60 * 24 * 400, `Max-Age must stay under Chrome's 400-day clamp`);

    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Path=\//);
    assert.match(cookie, /Secure/);
    // Strict would withhold the cookie when the app is opened from a link in
    // another app, producing a spurious login prompt.
    assert.match(cookie, /SameSite=Lax/);
  });

  test('the cookie is not marked Secure on a plain-http origin', async () => {
    // A Secure cookie is dropped outright over http, so the loopback/LAN dev
    // path would silently never stay signed in.
    const response = await fetch(`${BASE}/__auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: TOKEN }).toString(),
      redirect: 'manual',
    });
    const cookie = response.headers.get('set-cookie') ?? '';
    assert.doesNotMatch(cookie, /Secure/);
    assert.match(cookie, /Max-Age=\d+/);
  });

  test('the WebSocket command channel refuses unauthenticated remote upgrades', async () => {
    assert.equal(await connectWebSocket({ ...REMOTE }), 'rejected');
    assert.equal(await connectWebSocket({ ...REMOTE, cookie: 'unleashd_auth=wrong' }), 'rejected');
    assert.equal(await connectWebSocket({ ...REMOTE, cookie: `unleashd_auth=${TOKEN}` }), 'open');
  });

  test("this machine's browser gets in without a key, API and socket alike", async () => {
    // The 2026-10-05 onboarding complaint: the owner's own desktop was asked
    // for a key it had never seen.
    assert.equal((await fetch(`${BASE}/api/provider-catalog`)).status, 200);
    assert.equal(await connectWebSocket({ origin: BASE }), 'open');
  });

  test('a foreign web page cannot ride the local admission', async () => {
    // Browsers do not block cross-site WebSockets: without the Origin check,
    // any site the owner visits could open ws://localhost/ws and run agents.
    assert.equal(await connectWebSocket({ origin: 'https://evil.example' }), 'rejected');
    assert.equal(await connectWebSocket({ origin: 'null' }), 'rejected');
    const crossSitePost = await probe(
      '/api/mobile-access/pairing',
      { host: `127.0.0.1:${PORT}`, origin: 'https://evil.example' },
      'POST'
    );
    assert.equal(crossSitePost.status, 401);
    // DNS rebinding: evil.example re-resolved to 127.0.0.1 is same-origin to
    // itself, so only the Host header gives it away.
    const rebound = await probe('/api/provider-catalog', {
      host: `evil.example:${PORT}`,
      origin: `http://evil.example:${PORT}`,
    });
    assert.equal(rebound.status, 401);
  });

  test("the owner's tailnet devices get in; other tailnet users and Funnel do not", async () => {
    assert.equal((await probe('/api/provider-catalog', { ...OWNER_PHONE })).status, 200);
    assert.equal(await connectWebSocket({ ...OWNER_PHONE, origin: `https://${TS_HOST}` }), 'open');
    // Someone the owner shared the machine with is a different login.
    const sharee = await probe('/api/provider-catalog', {
      ...OWNER_PHONE,
      'tailscale-user-login': 'friend@example.com',
    });
    assert.equal(sharee.status, 401);
    // A page the phone visits cannot drive the socket through Serve either.
    assert.equal(
      await connectWebSocket({ ...OWNER_PHONE, origin: 'https://evil.example' }),
      'rejected'
    );
    // Funnel requests carry no login; Serve marks them instead.
    const { 'tailscale-user-login': _login, ...anonymous } = OWNER_PHONE;
    const funnel = await probe('/api/provider-catalog', {
      ...anonymous,
      'tailscale-funnel-request': '?1',
    });
    assert.equal(funnel.status, 401);
  });

  test('a pairing QR signs a phone in once, and never carries the key', async () => {
    const minted = await fetch(`${BASE}/api/mobile-access/pairing`, {
      method: 'POST',
      headers: { origin: BASE },
    });
    assert.equal(minted.status, 200, await minted.clone().text());
    const pairing = (await minted.json()) as { url: string; svg: string; expiresAt: number };
    const link = new URL(pairing.url);
    assert.equal(link.host, TS_HOST);
    assert.equal(link.pathname, '/__auth/pair');
    assert.doesNotMatch(pairing.url, new RegExp(TOKEN));
    assert.match(pairing.svg, /^<svg/);

    // A remote caller cannot mint one: only someone already admitted can pair.
    const remoteMint = await fetch(`${BASE}/api/mobile-access/pairing`, {
      method: 'POST',
      headers: REMOTE,
    });
    assert.equal(remoteMint.status, 401);

    const target = `${link.pathname}${link.search}`;
    const scanned = await probe(target, { ...REMOTE, 'x-forwarded-proto': 'https' });
    assert.equal(scanned.status, 302);
    assert.equal(scanned.headers.location, '/');
    const cookie = String(scanned.headers['set-cookie'] ?? '');
    assert.match(cookie, new RegExp(`unleashd_auth=${TOKEN}`));
    assert.match(cookie, /Secure/);

    const rescanned = await probe(target, { ...REMOTE });
    assert.equal(rescanned.status, 302);
    assert.equal(rescanned.headers.location, '/__auth/login?error=pairing-expired');
    assert.equal(rescanned.headers['set-cookie'], undefined);
  });

  // Wire compression lives on the same gated wiring, so it is probed here
  // against the same real process. Without it a real `init` is 2.4 MB and
  // /api/conversations/:id up to 1.4 MB uncompressed over a phone's LAN link.
  test('large API responses are gzip-encoded once past the gate', async () => {
    const response = await fetch(`${BASE}/api/provider-catalog`, {
      headers: { authorization: `Bearer ${TOKEN}`, 'accept-encoding': 'gzip' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-encoding'), 'gzip');
    // fetch inflates transparently; the body must still be the JSON catalog,
    // and large enough that the 1 KB threshold was not what decided this.
    const body = await response.text();
    assert.ok(body.length > 4096, `catalog body only ${body.length} bytes`);
    JSON.parse(body);
  });

  test('the WebSocket negotiates permessage-deflate and init arrives intact', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}${WS_PATH}`, {
      headers: { cookie: `unleashd_auth=${TOKEN}` },
    });
    try {
      const first = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no hello within 10s')), 10_000);
        socket.once('message', (data) => {
          clearTimeout(timer);
          resolve(data.toString());
        });
        socket.once('error', reject);
      });
      assert.match(socket.extensions, /permessage-deflate/);
      assert.equal(JSON.parse(first).type, 'hello');
    } finally {
      socket.close();
    }
  });
});

describe('auth policy resolution', () => {
  const noFiles = () => {
    throw new Error('ENOENT');
  };

  test('a fresh install creates a private key once, and every later start reuses it', () => {
    // pnpm dev resolves this in the backend AND Vite at once; both must end up
    // with the same key, or the browser holds a cookie only one gate accepts.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unleashd-key-'));
    try {
      const first = resolveAuthPolicy({ env: {}, dataDirectory: directory });
      const second = resolveAuthPolicy({ env: {}, dataDirectory: directory });
      const keyPath = path.join(directory, 'auth-token');
      assert.deepEqual(first.ok && first.key, { kind: 'created', path: keyPath });
      assert.deepEqual(second.ok && second.key, { kind: 'unchanged' });
      const token = fs.readFileSync(keyPath, 'utf8').trim();
      assert.match(token, /^[0-9a-f]{64}$/);
      assert.equal(first.ok && first.policy.kind === 'required' && first.policy.token, token);
      assert.equal(second.ok && second.policy.kind === 'required' && second.policy.token, token);
      // Any local account could otherwise read the key.
      assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('an empty named key file is an error, not a reason to invent a key', () => {
    const resolution = resolveAuthPolicy({
      env: { UNLEASHD_AUTH_TOKEN_FILE: '/run/secrets/buddies' },
      dataDirectory: '/nonexistent',
      readFile: () => '\n',
      createFile: () => assert.fail('must not create a key'),
    });
    assert.equal(resolution.ok, false);
  });

  test('a too-short token is a startup error, not a weak accepted secret', () => {
    const resolution = resolveAuthPolicy({
      env: { UNLEASHD_AUTH_TOKEN: 'hunter2' },
      dataDirectory: '/nonexistent',
      readFile: noFiles,
    });
    assert.equal(resolution.ok, false);
    assert.match(resolution.ok ? '' : resolution.error, /at least 16/);
  });

  test('opting out requires the explicit flag, and then no key is created', () => {
    const resolution = resolveAuthPolicy({
      env: { UNLEASHD_AUTH_DISABLED: '1' },
      dataDirectory: '/nonexistent',
      readFile: noFiles,
      createFile: () => assert.fail('must not create a key'),
    });
    assert.equal(resolution.ok, true);
    assert.deepEqual(resolution.ok && resolution.policy, {
      kind: 'open',
      reason: 'explicitly-disabled',
    });
  });
});

describe('request classification', () => {
  const policy = { kind: 'required', digest: digestToken(TOKEN), token: TOKEN } as const;
  const owner = { kind: 'known', login: OWNER } as const;

  test('a forged Tailscale login from a LAN peer is not the owner', () => {
    // Serve always connects from loopback. Vite listens on every interface
    // once a key exists, so a LAN host can send this header straight to it.
    const decision = decideAuth(
      policy,
      { method: 'GET', url: '/api/x', headers: { ...OWNER_PHONE }, peer: '192.168.1.20' },
      owner
    );
    assert.equal(decision.kind, 'challenge');
    const lanBrowser = decideAuth(
      policy,
      { method: 'GET', url: '/', headers: { host: 'localhost:7489' }, peer: '192.168.1.20' },
      owner
    );
    assert.equal(lanBrowser.kind, 'challenge');
  });
});
