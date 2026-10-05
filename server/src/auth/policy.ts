import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
 */

const MINIMUM_TOKEN_LENGTH = 16;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);

/** D = required ⊕ open. There is no "maybe authenticated" state. */
export type AuthPolicy =
  | { readonly kind: 'required'; readonly digest: Buffer }
  | {
      readonly kind: 'open';
      readonly reason: 'loopback-without-token' | 'explicitly-disabled';
    };

export type PolicyResolution =
  | { readonly ok: true; readonly policy: AuthPolicy }
  | { readonly ok: false; readonly error: string };

export interface PolicyInput {
  readonly env: NodeJS.ProcessEnv;
  readonly listenHost: string;
  readonly dataDirectory: string;
  /** Injected so tests exercise resolution without touching the real disk. */
  readonly readFile?: (filePath: string) => string;
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

export function digestToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

function defaultReadFile(filePath: string): string {
  return readFileSync(filePath, 'utf8');
}

/**
 * κ: environment → AuthPolicy. Precedence is explicit-env, explicit-file,
 * conventional file. A token file is preferred over the env var because the
 * server spawns agent CLIs as children, and children inherit the environment —
 * a secret in `UNLEASHD_AUTH_TOKEN` is readable by every agent it launches.
 */
function readConfiguredToken(input: PolicyInput): string | undefined {
  const read = input.readFile ?? defaultReadFile;
  const inline = input.env.UNLEASHD_AUTH_TOKEN?.trim();
  if (inline) return inline;

  const explicitPath = input.env.UNLEASHD_AUTH_TOKEN_FILE?.trim();
  if (explicitPath) {
    // An explicitly named file that cannot be read is a configuration error,
    // not an invitation to run without auth — let the throw reach the caller.
    return read(explicitPath).trim();
  }

  const conventionalPath = path.join(input.dataDirectory, 'auth-token');
  try {
    return read(conventionalPath).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Where the owner's key lives, so Setup can say where to find it. Same precedence as above. */
export type KeyLocation =
  | { readonly kind: 'env' }
  | { readonly kind: 'file'; readonly path: string };

export function keyLocation(env: NodeJS.ProcessEnv, dataDirectory: string): KeyLocation {
  if (env.UNLEASHD_AUTH_TOKEN?.trim()) return { kind: 'env' };
  const explicitPath = env.UNLEASHD_AUTH_TOKEN_FILE?.trim();
  return { kind: 'file', path: explicitPath || path.join(dataDirectory, 'auth-token') };
}

export function resolveAuthPolicy(input: PolicyInput): PolicyResolution {
  let token: string | undefined;
  try {
    token = readConfiguredToken(input);
  } catch (error) {
    return {
      ok: false,
      error: `UNLEASHD_AUTH_TOKEN_FILE could not be read: ${(error as Error).message}`,
    };
  }

  if (token) {
    if (token.length < MINIMUM_TOKEN_LENGTH) {
      return {
        ok: false,
        error: `Auth token is ${token.length} characters; at least ${MINIMUM_TOKEN_LENGTH} are required. Generate one with: openssl rand -hex 32`,
      };
    }
    return { ok: true, policy: { kind: 'required', digest: digestToken(token) } };
  }

  if (input.env.UNLEASHD_AUTH_DISABLED === '1') {
    return { ok: true, policy: { kind: 'open', reason: 'explicitly-disabled' } };
  }

  if (isLoopbackHost(input.listenHost)) {
    return { ok: true, policy: { kind: 'open', reason: 'loopback-without-token' } };
  }

  // Refusing to start is the point: binding a non-loopback interface without a
  // token is how "anyone who can reach the port has full access" happens.
  return {
    ok: false,
    error: [
      `Refusing to listen on ${input.listenHost} without authentication.`,
      `  Set a token:   openssl rand -hex 32 > ${path.join(input.dataDirectory, 'auth-token')}`,
      '  Or opt out:    UNLEASHD_AUTH_DISABLED=1 (every reachable host gets full access)',
    ].join('\n'),
  };
}

export function describePolicy(policy: AuthPolicy): string {
  if (policy.kind === 'required') return 'auth: shared-secret required on every request';
  if (policy.reason === 'explicitly-disabled') {
    return 'auth: DISABLED by UNLEASHD_AUTH_DISABLED=1 — every reachable host has full access';
  }
  return 'auth: none (loopback-only bind; set an auth token before exposing this host)';
}
