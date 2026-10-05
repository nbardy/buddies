import { exec } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { type ViteDevServer, createLogger, defineConfig } from 'vite';
import {
  buildSessionCookie,
  decideAuth,
  isAuthEndpoint,
  isSecureRequest,
} from '../server/src/auth/gate';
import { loginPageHtml } from '../server/src/auth/login-page';
import { type AuthPolicy, describePolicy, resolveAuthPolicy } from '../server/src/auth/policy';
import { isViteClientModule, patchViteResumeReload } from './src/pwa/resume';

const DEV_CLIENT_PORT = 7489;
const API_SERVER_PORT = 7499;
const LOCAL_DOMAIN = 'unleashd.localhost';
// Any tailnet's MagicDNS name: Setup's Connect mobile serves this port over
// Tailscale, and the owner's own tailnet name here 403'd every other install.
const TAILSCALE_DOMAIN = '.ts.net';
const LOCAL_DEV_URL =
  process.env.UNLEASHD_LOCAL_DOMAIN_ENABLED === '1'
    ? `http://${LOCAL_DOMAIN}`
    : `http://localhost:${DEV_CLIENT_PORT}`;
const viteLogger = createLogger();
const logViteError = viteLogger.error.bind(viteLogger);
const logViteInfo = viteLogger.info.bind(viteLogger);
let lastHmrMessage = '';
let lastHmrAt = 0;
const clientRoot = path.dirname(fileURLToPath(import.meta.url));
const sharedSourceEntry = path.resolve(clientRoot, '../shared/src/index.ts');

viteLogger.error = (message, options) => {
  const transientWebSocketRestart =
    message.includes('ws proxy') &&
    (message.includes('EPIPE') ||
      message.includes('ECONNRESET') ||
      message.includes('ECONNREFUSED'));
  const transientHttpRestart =
    message.includes('http proxy error:') &&
    (message.includes('EPIPE') ||
      message.includes('ECONNRESET') ||
      message.includes('ECONNREFUSED'));
  if (transientWebSocketRestart || transientHttpRestart) return;
  logViteError(message, options);
};

viteLogger.info = (message, options) => {
  if (message.includes('hmr update')) {
    const now = Date.now();
    if (message === lastHmrMessage && now - lastHmrAt < 1_000) return;
    lastHmrMessage = message;
    lastHmrAt = now;
  }
  logViteInfo(message, options);
};

function logUnexpectedProxyError(scope: string, error: NodeJS.ErrnoException) {
  if (error.code === 'EPIPE' || error.code === 'ECONNRESET' || error.code === 'ECONNREFUSED') {
    return;
  }
  console.error(`[${scope} proxy]`, error.message);
}

function openInBrowser(url: string) {
  const startCmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${startCmd} ${url}`);
}

// =============================================================================
// Dev-server auth
//
// The Vite dev server is the LAN-facing surface: it serves the app shell and
// proxies /api and /ws to the loopback-bound backend, so before this gate
// existed anyone on the same wifi had the full API via http://<lan-ip>:7489.
// The backend enforces the same secret independently — this is not the only
// check, it is the one that stops the app shell and the proxy from answering.
// =============================================================================
const APP_DATA_DIR = process.env.UNLEASHD_DATA_DIR ?? path.join(os.homedir(), '.agent-viewer');

function resolveDevAuthPolicy(): AuthPolicy {
  const resolution = resolveAuthPolicy({
    env: process.env,
    // Loopback so an unconfigured dev server is never the thing that refuses to
    // start; `devServerHost` below is what keeps that promise honest.
    listenHost: '127.0.0.1',
    dataDirectory: APP_DATA_DIR,
  });
  if (!resolution.ok) throw new Error(`[auth] ${resolution.error}`);
  return resolution.policy;
}

/**
 * Without a shared secret the dev server binds loopback only. Exposing it on
 * every interface has to be earned by configuring a token, otherwise `pnpm dev`
 * silently republishes the whole API to the local network.
 */
function devServerHost(policy: AuthPolicy): boolean | string {
  return policy.kind === 'required' ? true : '127.0.0.1';
}

function devAuthPlugin(policy: AuthPolicy) {
  return {
    name: 'unleashd-dev-auth',
    configureServer(server: ViteDevServer) {
      console.log(`[unleashd] ${describePolicy(policy)}`);
      if (policy.kind === 'open') return;

      // Connect middleware only ever runs on the httpServer's `request` event.
      // A WebSocket arrives as an `upgrade` event instead, so without this the
      // middleware chain below never sees Vite's HMR socket at all and it
      // accepts any connection that can reach the port — confirmed reachable
      // from the LAN, not just the tailnet. Vite's own ?token= guard does not
      // cover it: that only engages when an `Origin` header is present, so any
      // non-browser client simply omits `Origin`.
      //
      // prependListener, not on: Vite attaches its own upgrade listener when
      // the dev server is built, and this has to reject the socket before that
      // one completes the handshake.
      server.httpServer?.prependListener('upgrade', (request, socket) => {
        const decision = decideAuth(policy, {
          method: request.method ?? 'GET',
          url: request.url ?? '/',
          headers: request.headers,
        });
        if (decision.kind === 'challenge') {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
          socket.destroy();
        }
      });

      server.middlewares.use((request, response, next) => {
        const gateRequest = {
          method: request.method ?? 'GET',
          url: request.url ?? '/',
          headers: request.headers,
        };
        // /__auth/* is the login form itself; the proxy hands it to the
        // backend, which validates the submitted key and sets the cookie.
        if (isAuthEndpoint(gateRequest.url)) {
          next();
          return;
        }
        const decision = decideAuth(policy, gateRequest);
        if (decision.kind === 'allow') {
          next();
          return;
        }
        if (decision.kind === 'establish') {
          response.statusCode = 302;
          response.setHeader(
            'Set-Cookie',
            buildSessionCookie(decision.token, { secure: isSecureRequest(gateRequest) })
          );
          response.setHeader('Location', decision.location);
          response.end();
          return;
        }
        response.statusCode = 401;
        if (decision.wants === 'json') {
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(loginPageHtml({ notice: { kind: 'none' }, redirectTo: gateRequest.url }));
      });
    },
  };
}

const devAuthPolicy = resolveDevAuthPolicy();

// Once per PROCESS, not per config load. A Vite restart (vite.config.ts or .env
// edit, `r` in the terminal) re-imports this file as a fresh module and re-runs
// configureServer on a new httpServer, so a module-level `let` resets and the
// page reopened on every restart. globalThis outlives the re-import; a new
// `pnpm dev` / `pnpm dev:replace` is a new process and opens once.
const BROWSER_OPENED = Symbol.for('unleashd.dev.browserOpened');
const processFlags = globalThis as { [BROWSER_OPENED]?: true };

function openPreferredDevUrlPlugin() {
  return {
    name: 'open-preferred-dev-url',
    configureServer(server: ViteDevServer) {
      server.httpServer?.once('listening', () => {
        if (processFlags[BROWSER_OPENED]) return;
        processFlags[BROWSER_OPENED] = true;
        console.log(`[unleashd] Opening ${LOCAL_DEV_URL}`);
        openInBrowser(LOCAL_DEV_URL);
      });
    },
  };
}

// Dev client only. The phone's installed app drops Vite's hot-reload socket
// on every app switch; without this the client reloads the document on resume.
function keepPageOnResumePlugin() {
  return {
    name: 'unleashd-keep-page-on-resume',
    apply: 'serve' as const,
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      if (!isViteClientModule(id)) return null;
      return { code: patchViteResumeReload(code), map: null };
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  customLogger: viteLogger,
  plugins: [
    react(),
    devAuthPlugin(devAuthPolicy),
    openPreferredDevUrlPlugin(),
    keepPageOnResumePlugin(),
  ],
  // The shared package's ESM and CJS watch builds update dist file-by-file.
  // Reading that mutable output from Vite creates a window where index.js is
  // absent or inconsistent with its leaf modules. The browser build can
  // consume the canonical TypeScript entry directly and let Vite own HMR.
  resolve: {
    alias: {
      '@unleashd/shared': sharedSourceEntry,
    },
  },
  server: {
    host: devServerHost(devAuthPolicy),
    port: DEV_CLIENT_PORT,
    open: false,
    allowedHosts: [LOCAL_DOMAIN, TAILSCALE_DOMAIN],
    proxy: {
      '/ws': {
        target: `ws://127.0.0.1:${API_SERVER_PORT}`,
        ws: true,
        // Suppress EPIPE/ECONNRESET noise during backend restarts.
        // Vite reconnects automatically — these errors are expected and transient.
        configure: (proxy) => {
          const silence = (err: NodeJS.ErrnoException) => {
            if (err.code === 'EPIPE' || err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED')
              return;
            console.error('[ws proxy]', err.message);
          };
          proxy.on('error', silence);
          proxy.on('proxyReqWs', (_proxyReq, _req, socket) => {
            socket.on('error', silence);
          });
        },
      },
      '/__auth': {
        target: `http://127.0.0.1:${API_SERVER_PORT}`,
        configure: (proxy) => {
          proxy.on('error', (error) => logUnexpectedProxyError('http', error));
        },
      },
      '/api': {
        target: `http://127.0.0.1:${API_SERVER_PORT}`,
        configure: (proxy) => {
          proxy.on('error', (error) => logUnexpectedProxyError('http', error));
        },
      },
    },
  },
});
