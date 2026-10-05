import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

/**
 * The backend's side of the Buddy MCP relay (server/relay/buddy-mcp-relay.mjs, which explains
 * why it exists). The relay owns the stable port that every turn's CLI calls and outlives the
 * backend. A backend finds the relay (or starts one) and attaches its internal MCP listener. The
 * attach connection stays open for the backend's whole life, and the relay forwards only while it
 * is open.
 */
// Pattern: hold-through-outage (docs/patterns.md#hold-through-outage)

// Same relative path from src/buddies (tsx) and dist/buddies (built).
const RELAY_ENTRY = path.resolve(__dirname, '..', '..', 'relay', 'buddy-mcp-relay.mjs');
/** Any edit to the relay is a new version: a backend replaces an older relay it finds. */
const RELAY_VERSION = createHash('sha256')
  .update(fs.readFileSync(RELAY_ENTRY))
  .digest('hex')
  .slice(0, 16);
// The relay waits up to 5 s for a port a predecessor still holds, so it has written its state
// file well before this.
const RELAY_START_MS = 10_000;
const ATTACH_ATTEMPTS = 3;

/** What a live relay wrote to the state file. */
type RelayState = { port: number; pid: number; key: string; version: string };

/**
 * The state file as found. `relay`: one wrote it. `port`: only a port is known, from a backend
 * before the relay ({port}, P1), or 0 on a first start.
 */
type Found = { t: 'relay'; state: RelayState } | { t: 'port'; port: number };

function readFound(stateFile: string): Found {
  let raw: Partial<RelayState>;
  try {
    raw = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Partial<RelayState>;
  } catch {
    return { t: 'port', port: 0 };
  }
  if (typeof raw.pid === 'number' && typeof raw.key === 'string' && typeof raw.version === 'string')
    return { t: 'relay', state: raw as RelayState };
  return { t: 'port', port: typeof raw.port === 'number' && raw.port > 0 ? raw.port : 0 };
}

/** Alive AND still a relay: a reused pid runs a command line that never names the relay. */
function isRelay(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).includes(RELAY_ENTRY);
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The relay to attach to: the current one if it runs, else a new one on the same port. */
async function ensureRelay(stateFile: string): Promise<RelayState> {
  const found = readFound(stateFile);
  if (found.t === 'relay' && found.state.version === RELAY_VERSION && isRelay(found.state.pid))
    return found.state;
  // An older relay holds the port: stop it so the new one can take it. Calls it holds right now
  // fail, which is only ever the case when the relay itself changed.
  if (found.t === 'relay' && isRelay(found.state.pid)) process.kill(found.state.pid, 'SIGTERM');
  const port = found.t === 'relay' ? found.state.port : found.port;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  // Detached like an execution (own session and group, no stdio): the terminal's Ctrl+C, which
  // ends the backend, must not end the relay. Bare node, never process.execArgv (see the relay).
  const child = spawn(process.execPath, [RELAY_ENTRY, stateFile, String(port), RELAY_VERSION], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  child.on('error', () => undefined);
  const giveUp = Date.now() + RELAY_START_MS;
  for (;;) {
    const now = readFound(stateFile);
    if (now.t === 'relay' && now.state.pid === child.pid) {
      if (port !== 0 && now.state.port !== port)
        // Loud, never silent: turns adopted from the previous backend call the old URL and will
        // get connection errors from their Buddy tools until they end.
        console.error(
          `[buddies-mcp] port ${port} is taken; adopted turns lose their Buddy tools. Relay listening on ${now.state.port}.`
        );
      return now.state;
    }
    if (Date.now() > giveUp) throw new Error(`The Buddy MCP relay did not start (${stateFile})`);
    await sleep(50);
  }
}

/** Open the attach request; resolves once the relay accepted it. */
function attach(state: RelayState, backendPort: number): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: state.port,
      method: 'POST',
      path: `/relay/attach?port=${backendPort}`,
      headers: { 'x-relay-key': state.key },
      agent: false,
    });
    request.on('response', (response) =>
      response.statusCode === 200
        ? resolve(response)
        : reject(new Error(`relay refused attach: ${response.statusCode}`))
    );
    request.on('error', reject);
    request.end();
  });
}

export type RelayLink = { readonly port: number; close(): void };

/**
 * Attach `backendPort` to the relay for this backend's lifetime. If the relay goes away while the
 * backend lives (killed, or idle-exited during a long stall), it is started again and re-attached.
 */
export async function attachToRelay(stateFile: string, backendPort: number): Promise<RelayLink> {
  let closed = false;
  let response: http.IncomingMessage | null = null;
  let port = 0;

  async function connect(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const state = await ensureRelay(stateFile);
      try {
        response = await attach(state, backendPort);
        port = state.port;
        response.resume();
        response.on('close', () => {
          if (!closed)
            void sleep(200)
              .then(connect)
              .catch((error) => console.error('[buddies-mcp] relay re-attach failed:', error));
        });
        return;
      } catch (error) {
        if (attempt >= ATTACH_ATTEMPTS) throw error;
        // Alive by pid and command line but not answering: replace it.
        if (isRelay(state.pid)) process.kill(state.pid, 'SIGTERM');
        await sleep(200);
      }
    }
  }

  await connect();
  return {
    get port() {
      return port;
    },
    close() {
      closed = true;
      response?.destroy();
    },
  };
}
