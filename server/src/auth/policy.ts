import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Auth gate — backend half of a two-gate design.
 * Vite devAuthPlugin (client/vite.config.ts:devAuthPlugin) is the LAN-facing
 * gate for the dev server's static assets; this backend gate (policy + gate.ts)
 * guards /api + WebSocket upgrade. Both enforce the same secret resolved here
 * (resolveAuthPolicy) — the backend is not the only check. See docs/auth.md.
 */

/**
 * Shared-secret auth for a single-user personal tool.
 *
 * The secret is a bearer credential: whoever presents it is the user. That is
 * proportionate here (one human, one machine) but it means the wire matters —
 * see docs/auth.md for why plain http on the LAN is the weak path and the
 * Tailscale path is not.
 *
 * The owner never has to type it on their own devices: this machine's browser
 * and the owner's tailnet devices are admitted without it (gate.ts), and a
 * phone pairs from a QR code (pairing.ts). The key is what everything else needs.
 */

const MINIMUM_TOKEN_LENGTH = 16;

/** D = required ⊕ open. There is no "maybe authenticated" state. */
export type AuthPolicy =
  | {
      readonly kind: 'required';
      readonly digest: Buffer;
      /** The key itself: a pairing code is exchanged for a cookie holding it. */
      readonly token: string;
    }
  | { readonly kind: 'open'; readonly reason: 'explicitly-disabled' };

/** Where the key came from this start, so startup can say when it made one. */
export type KeyOrigin =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'created'; readonly path: string };

export type PolicyResolution =
  | { readonly ok: true; readonly policy: AuthPolicy; readonly key: KeyOrigin }
  | { readonly ok: false; readonly error: string };

export interface PolicyInput {
  readonly env: NodeJS.ProcessEnv;
  readonly dataDirectory: string;
  /** Injected so tests exercise resolution without touching the real disk. */
  readonly readFile?: (filePath: string) => string;
  /** Creates a file that must not exist yet; throws EEXIST when it does. */
  readonly createFile?: (filePath: string, content: string) => void;
}

export function digestToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

function defaultReadFile(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}

function defaultCreateFile(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  // wx: `pnpm dev` starts the backend and Vite at once and both resolve the
  // policy. Exclusive create makes the first writer win; the other reads it.
  writeFileSync(filePath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

type ConfiguredKey =
  | { readonly kind: 'found'; readonly token: string }
  | { readonly kind: 'absent' };

/**
 * κ: environment → configured key. Precedence is explicit-env, explicit-file,
 * conventional file. A token file is preferred over the env var because the
 * server spawns agent CLIs as children, and children inherit the environment —
 * a secret in `UNLEASHD_AUTH_TOKEN` is readable by every agent it launches.
 */
function readConfiguredKey(input: PolicyInput, read: (filePath: string) => string): ConfiguredKey {
  const inline = input.env.UNLEASHD_AUTH_TOKEN?.trim();
  if (inline) return { kind: 'found', token: inline };

  const explicitPath = input.env.UNLEASHD_AUTH_TOKEN_FILE?.trim();
  if (explicitPath) {
    // An explicitly named file that cannot be read, or is empty, is a
    // configuration error, never an invitation to make up a different key.
    const token = read(explicitPath).trim();
    if (!token) throw new Error(`${explicitPath} is empty`);
    return { kind: 'found', token };
  }

  try {
    const token = read(conventionalKeyPath(input.dataDirectory)).trim();
    return token ? { kind: 'found', token } : { kind: 'absent' };
  } catch {
    return { kind: 'absent' };
  }
}

function conventionalKeyPath(dataDirectory: string): string {
  return path.join(dataDirectory, 'auth-token');
}

/** Where the owner's key lives, so Setup can say where to find it. Same precedence as above. */
export type KeyLocation =
  | { readonly kind: 'env' }
  | { readonly kind: 'file'; readonly path: string };

export function keyLocation(env: NodeJS.ProcessEnv, dataDirectory: string): KeyLocation {
  if (env.UNLEASHD_AUTH_TOKEN?.trim()) return { kind: 'env' };
  const explicitPath = env.UNLEASHD_AUTH_TOKEN_FILE?.trim();
  return { kind: 'file', path: explicitPath || conventionalKeyPath(dataDirectory) };
}

function requiredPolicy(token: string, key: KeyOrigin): PolicyResolution {
  if (token.length < MINIMUM_TOKEN_LENGTH) {
    return {
      ok: false,
      error: `Auth token is ${token.length} characters; at least ${MINIMUM_TOKEN_LENGTH} are required. Generate one with: openssl rand -hex 32`,
    };
  }
  return { ok: true, policy: { kind: 'required', digest: digestToken(token), token }, key };
}

/**
 * A fresh install has no key, so make one. Before 2026-10-05 a missing key
 * meant "open on loopback", which left any website in the owner's browser able
 * to open ws://localhost/ws and run agents (browsers allow cross-site
 * WebSockets), and made Setup's first mobile step an `openssl` command.
 */
function createKey(input: PolicyInput, read: (filePath: string) => string): PolicyResolution {
  const keyPath = conventionalKeyPath(input.dataDirectory);
  const token = randomBytes(32).toString('hex');
  try {
    (input.createFile ?? defaultCreateFile)(keyPath, `${token}\n`);
    return requiredPolicy(token, { kind: 'created', path: keyPath });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      return {
        ok: false,
        error: `Could not create the access key at ${keyPath}: ${(error as Error).message}`,
      };
    }
    // The other dev process created it first; use theirs.
    return requiredPolicy(read(keyPath).trim(), { kind: 'unchanged' });
  }
}

export function resolveAuthPolicy(input: PolicyInput): PolicyResolution {
  const read = input.readFile ?? defaultReadFile;
  let configured: ConfiguredKey;
  try {
    configured = readConfiguredKey(input, read);
  } catch (error) {
    return {
      ok: false,
      error: `UNLEASHD_AUTH_TOKEN_FILE could not be read: ${(error as Error).message}`,
    };
  }

  if (configured.kind === 'found') return requiredPolicy(configured.token, { kind: 'unchanged' });
  if (input.env.UNLEASHD_AUTH_DISABLED === '1') {
    return {
      ok: true,
      policy: { kind: 'open', reason: 'explicitly-disabled' },
      key: { kind: 'unchanged' },
    };
  }
  return createKey(input, read);
}

export function describePolicy(policy: AuthPolicy): string {
  if (policy.kind === 'required') {
    return "auth: key required, except this machine's browser and the owner's tailnet devices";
  }
  return 'auth: DISABLED by UNLEASHD_AUTH_DISABLED=1 — every reachable host has full access';
}
