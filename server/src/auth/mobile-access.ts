import { execFile } from 'node:child_process';
import type { MobileAccess, MobilePairing } from '@unleashd/shared';
import type { Express } from 'express';
import QRCode from 'qrcode';
import { PAIR_PATH } from './gate';
import type { PairingCodes } from './pairing';
import type { AuthPolicy, KeyLocation } from './policy';

// Pattern: sum-types (docs/patterns.md#sum-types)
// The phone URL is read from Tailscale itself, never composed from a guess. On
// 2026-09-09 the Mac's MagicDNS name changed (…-macbook-air → …-macbook-air-2)
// while Serve still answered only for the old name, and the phone got a dead URL.
// Only a Serve handler on THIS node's current name, proxying to the port that
// serves the UI, counts as ready. Guard: server/test/mobile-access.test.ts.

export type MobileAccessInput = {
  /** Candidate CLI paths in order; the first that spawns wins. */
  readonly tailscale: readonly string[];
  /** Port serving the client: the built app's own port, or Vite's in development. */
  readonly uiPort: number;
  readonly auth: AuthPolicy;
  readonly key: KeyLocation;
  readonly timeoutMs?: number;
};

export type MobileAccessDeps = MobileAccessInput & { readonly pairing: PairingCodes };

export type TailscaleStatus = {
  BackendState?: string;
  Self?: { DNSName?: string; UserID?: number };
  User?: Record<string, { LoginName?: string }>;
};
export type Cli = { kind: 'found'; path: string; status: TailscaleStatus } | { kind: 'missing' };
type ServeConfig = {
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
};

/** The macOS app bundles its CLI here; it is not on PATH unless the user linked it. */
export const TAILSCALE_CANDIDATES = [
  'tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
] as const;

// The parse stays inside the promise: a throw in execFile's callback is uncaught
// and killed the whole server when the app-bundled CLI printed "The Tailscale
// GUI failed to start" instead of JSON (2026-10-05). Guard: mobile-access.test.ts.
export function runJson<T>(file: string, args: string[], timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 4 << 20 }, (error, stdout) => {
      if (error) return reject(Object.assign(error, { stdout }));
      try {
        resolve(JSON.parse(stdout || '{}') as T);
      } catch {
        reject(new Error(`${file} ${args.join(' ')} printed: ${stdout.trim().slice(0, 200)}`));
      }
    });
  });
}

export async function findCli(candidates: readonly string[], timeoutMs: number): Promise<Cli> {
  for (const path of candidates) {
    try {
      const status = await runJson<TailscaleStatus>(
        path,
        ['status', '--json', '--peers=false'],
        timeoutMs
      );
      return { kind: 'found', path, status };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      // `status` exits non-zero while logged out but still prints the state we need.
      const stdout = (error as { stdout?: string }).stdout?.trim();
      if (stdout?.startsWith('{')) {
        return { kind: 'found', path, status: JSON.parse(stdout) as TailscaleStatus };
      }
      throw error;
    }
  }
  return { kind: 'missing' };
}

const LOOPBACK_PROXY = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d+)\/?$/;

/** Does Serve answer https://<host>/ by proxying to the UI port? */
function servesUi(serve: ServeConfig, host: string, uiPort: number): boolean {
  const proxy = serve.Web?.[`${host}:443`]?.Handlers?.['/']?.Proxy ?? '';
  return Number(LOOPBACK_PROXY.exec(proxy)?.[1]) === uiPort;
}

export async function readMobileAccess(input: MobileAccessInput): Promise<MobileAccess> {
  const timeoutMs = input.timeoutMs ?? 5_000;
  try {
    const cli = await findCli(input.tailscale, timeoutMs);
    if (cli.kind === 'missing') return { kind: 'tailscale_missing' };
    const state = cli.status.BackendState ?? 'NoState';
    const host = cli.status.Self?.DNSName?.replace(/\.$/, '') ?? '';
    if (state !== 'Running' || !host) return { kind: 'tailscale_stopped', state };
    const serve = await runJson<ServeConfig>(cli.path, ['serve', 'status', '--json'], timeoutMs);
    const serving = servesUi(serve, host, input.uiPort);
    // A key is created on first run, so open auth means the owner turned it
    // off. Serve connects from loopback, so it would publish the app unsigned.
    if (input.auth.kind === 'open') {
      return {
        kind: 'access_key_missing',
        command: 'unset UNLEASHD_AUTH_DISABLED',
        exposed: serving,
      };
    }
    if (!serving) {
      return {
        kind: 'serve_missing',
        host,
        command: `tailscale serve --bg --https=443 http://127.0.0.1:${input.uiPort}`,
      };
    }
    return {
      kind: 'ready',
      url: `https://${host}/`,
      funnel: serve.AllowFunnel?.[`${host}:443`] === true,
      key: input.key,
    };
  } catch (error) {
    return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
}

/** The QR the phone scans: the Serve URL with a one-time code, never the key. */
async function pairingFor(url: string, pairing: PairingCodes): Promise<MobilePairing> {
  const { code, expiresAt } = pairing.issue();
  const link = new URL(PAIR_PATH, url);
  link.searchParams.set('code', code);
  const svg = await QRCode.toString(link.toString(), {
    type: 'svg',
    margin: 1,
    errorCorrectionLevel: 'M',
  });
  return { url: link.toString(), svg, expiresAt };
}

export function registerMobileAccessRoutes(app: Express, deps: MobileAccessDeps): void {
  app.get('/api/mobile-access', async (_req, res) => {
    res.json(await readMobileAccess(deps));
  });
  // POST: it mints a code (the GET surface stays read-only). Only a caller
  // already past the gate reaches it, so only the owner can pair a phone.
  app.post('/api/mobile-access/pairing', async (_req, res) => {
    const access = await readMobileAccess(deps);
    if (access.kind !== 'ready') {
      res.status(409).json({ error: 'not_ready', access });
      return;
    }
    res.json(await pairingFor(access.url, deps.pairing));
  });
}
