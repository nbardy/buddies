// Pattern: hold-through-outage (docs/patterns.md#hold-through-outage)
// The Buddy MCP relay: a detached loopback process that owns the stable Buddy tool port and holds
// a turn's tool call while no backend is running.
//
// Why it exists (Task task_01a0f65c; measurements in
// agent_notes/2026-10-05_outage-tool-delivery.md): a Ctrl+C kills the terminal's whole process
// group, backend included, while adopted agent CLIs keep running. With nobody listening, a Buddy
// tool call gets ECONNREFUSED. Neither claude nor codex retries a refused connection (or a 503):
// the model sees a tool error at once, and whether it tries again is its own choice. Both CLIs DO
// wait on a request that was accepted and not yet answered. So this process accepts the request,
// waits for a backend, and forwards it. It is spawned detached (its own session and group, like
// an execution), so the Ctrl+C that ends the backend does not end it.
//
// Plain JS on purpose: the backend runs from src under tsx in dev and from dist in production, and
// this file is started with bare `node` in both (process.execArgv under tsx --test would start a
// test runner). It imports only node built-ins.
//
// argv: <stateFile> <preferredPort> <version>
//   stateFile      buddy-mcp.json: written here once listening, as {port, pid, key, version} (0600).
//                  Each backend reads it to find this relay; the port in it is what every turn's
//                  CLI was configured with, so a replacement relay listens on the same port.
//   preferredPort  that port (0 on a first start). If it is still busy after LISTEN_RETRY_MS, the
//                  relay takes any free port; the backend notices the change and says so.
//   version        a hash of this file, chosen by the backend. A backend that finds a different
//                  version stops this relay and starts its own.
//
// Protocol:
//   POST /relay/attach?port=N  with header x-relay-key. The backend holds this request open for as
//     long as it lives. The relay forwards to 127.0.0.1:N only while that connection is open: a
//     backend that dies, even by SIGKILL, closes it in the kernel, so the relay never forwards a
//     turn's bearer to a stale port that another process may have reused.
//   POST /mcp  (everything else): forwarded byte for byte, Authorization included. The relay
//     never reads the bearer. The backend's grant lookup decides every call, so a revoked or
//     Stopped turn still gets its 401. The attach key is this relay's own random value: the owner
//     secret never reaches this process.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';

const [stateFile, preferredPort, version] = process.argv.slice(2);

// 55 s, not 60: claude's MCP client aborts a request at 60.0 s (measured; MCP SDK default request
// timeout), and the relay must answer first so the model gets a clear "not delivered" message
// instead of "The operation timed out.". codex waited 130 s without aborting.
// The 60 s outage proof dominated feedback. Only isolated NODE_ENV=test children may
// shorten this budget; ctrl-c-adoption's real-time mode still proves the 55 s default.
const testHold = Number(process.env.UNLEASHD_TEST_RELAY_HOLD_MS);
const HOLD_MS =
  process.env.NODE_ENV === 'test' && Number.isInteger(testHold) && testHold > 0 ? testHold : 55_000;
// A relay with no backend attached and nothing held exits after this long, so a test server on
// temp stores does not leave relays behind.
const IDLE_EXIT_MS = 5 * 60_000;
// Long enough for a relay being replaced to release the port.
const LISTEN_RETRY_MS = 5_000;

const key = crypto.randomBytes(32).toString('base64url');

/** @type {{ port: number, socket: object } | null} The backend whose attach connection is open. */
let backend = null;
/** Held requests waiting for a backend: each is called with its port once one attaches. */
const waiting = new Set();
let held = 0;
let lastAttachedAt = Date.now();

function attach(req, res) {
  const port = Number(new URL(req.url, 'http://relay').searchParams.get('port'));
  if (req.headers['x-relay-key'] !== key || !Number.isInteger(port) || port <= 0)
    return void res.writeHead(403).end();
  const current = { port, socket: req.socket };
  backend = current;
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.write('attached\n');
  for (const wake of waiting) wake(port);
  // A later attach (a --replace backend) supersedes this one; only the current one detaches.
  req.socket.on('close', () => {
    if (backend !== current) return;
    backend = null;
    lastAttachedAt = Date.now();
  });
}

/** The attached backend's port, waiting for one until `deadline`; null if none came. */
function backendBy(deadline) {
  if (backend) return Promise.resolve(backend.port);
  return new Promise((resolve) => {
    const wake = (port) => {
      clearTimeout(timer);
      waiting.delete(wake);
      resolve(port);
    };
    const timer = setTimeout(() => wake(null), Math.max(0, deadline - Date.now()));
    waiting.add(wake);
  });
}

/** One forward. 'answered' once the backend's response began; 'failed' if it never did. */
function forward(port, req, body, res) {
  return new Promise((resolve) => {
    const upstream = http.request(
      { host: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        // Responses may stream (SSE): every chunk goes on as it arrives.
        answer.pipe(res);
        answer.on('error', () => res.destroy());
        resolve('answered');
      }
    );
    upstream.on('error', () => resolve('failed'));
    // A caller that leaves before its response is written takes the backend's request down with
    // it, so the backend sees its reply undelivered: a request-addressed message it was about to
    // show stays queued instead of being acknowledged to nobody (mcp.ts `Shown`, task_01a11a97).
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });
    upstream.end(body);
  });
}

/**
 * Hold, forward, and resend until a response begins or HOLD_MS passes. A forward that failed
 * before any response byte (refused, or the backend died mid-call) is sent again to the next
 * backend. The backend may already have run it, and that is safe: every writing Buddy tool takes
 * an idempotency `key` (docs/patterns.md#idempotency-keys) and `runs cancel` is idempotent, so the
 * resend replays the first result instead of writing twice.
 */
async function deliver(req, res, body) {
  const deadline = Date.now() + HOLD_MS;
  for (;;) {
    const port = await backendBy(deadline);
    // The CLI gave up (timeout, Stop killed it): nothing left to deliver to.
    if (res.destroyed) return;
    if (port === null) return unavailable(res, body);
    if ((await forward(port, req, body, res)) === 'answered') return;
    // The attach connection usually closes moments after a failed forward. The pause keeps a
    // backend that is attached but refusing from spinning this loop until the deadline.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** A JSON-RPC error: both CLIs show its message to the model verbatim (measured). */
function unavailable(res, body) {
  let id = null;
  try {
    id = JSON.parse(body.toString('utf8')).id ?? null;
  } catch {}
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32000,
        message: `The Buddy backend has been unavailable for ${HOLD_MS / 1000} s; this call was NOT delivered. Calling again with the same key is safe once it is back.`,
      },
    })
  );
}

const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/relay/attach')) return attach(req, res);
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    held++;
    deliver(req, res, Buffer.concat(chunks)).finally(() => held--);
  });
});
// A held tool call and an attach connection both outlive Node's default request timeouts.
server.requestTimeout = 0;
server.headersTimeout = 0;

function listen(port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function listenPreferred(port) {
  const giveUp = Date.now() + LISTEN_RETRY_MS;
  for (;;) {
    try {
      return await listen(port);
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || port === 0) throw error;
      if (Date.now() > giveUp) return listen(0);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

await listenPreferred(Number(preferredPort));
const tmp = `${stateFile}.${process.pid}.tmp`;
fs.writeFileSync(
  tmp,
  `${JSON.stringify({ port: server.address().port, pid: process.pid, key, version })}\n`,
  { mode: 0o600 }
);
fs.renameSync(tmp, stateFile);

setInterval(() => {
  if (!backend && held === 0 && Date.now() - lastAttachedAt > IDLE_EXIT_MS) process.exit(0);
  // Its data directory was deleted (a test's temp store): no backend can find this relay again.
  if (!fs.existsSync(stateFile)) process.exit(0);
}, 10_000).unref();
// The interval is unref'd: the listening server keeps the process alive.
process.on('SIGTERM', () => process.exit(0));
