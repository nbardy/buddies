import { timingSafeEqual } from 'node:crypto';
import { type AuthPolicy, digestToken } from './policy';
import type { TailnetOwner } from './tailnet-owner';

/**
 * Framework-agnostic auth decisions — single decideAuth used by Express,
 * the Vite dev server, and the WebSocket upgrade (one clean path, three thin
 * adapters).
 *
 * Two-gate design: Vite devAuthPlugin (client/vite.config.ts:devAuthPlugin)
 * is the LAN-facing gate before this backend gate. Both enforce the same
 * secret (resolveAuthPolicy in policy.ts) — the backend is not the only check.
 * See docs/auth.md and policy.ts header.
 */

export const SESSION_COOKIE = 'unleashd_auth';
/** Login/logout must answer without a credential, or the form cannot be reached. */
export const AUTH_PATH_PREFIX = '/__auth';
export const LOGIN_PATH = '/__auth/login';
export const LOGOUT_PATH = '/__auth/logout';
/** The Connect-mobile QR target: ?code=<one-time pairing code>. */
export const PAIR_PATH = '/__auth/pair';
/** Query parameter for bookmarkable links: /?token=… sets the cookie once. */
export const TOKEN_QUERY_PARAM = 'token';

/**
 * A year, and deliberately not a session cookie: on a phone this is the
 * difference between signing in once and signing in every time Safari evicts
 * the tab or the home-screen app is backgrounded. Because the cookie is set by
 * a `Set-Cookie` header rather than `document.cookie`, it is not subject to
 * WebKit ITP's 7-day cap on script-writable storage. Chrome clamps any cookie
 * to 400 days, so keep this under that.
 */
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/**
 * Lax, not Strict. Strict withholds the cookie on cross-site navigations, which
 * includes tapping a link to unleashd from Messages, Mail, or Slack — the user
 * is still signed in but gets the login page anyway, which is exactly the
 * re-entry this cookie exists to prevent. Lax costs nothing here: it still
 * withholds the cookie from cross-site subresources (fetch, XHR, the WebSocket
 * handshake) and from cross-site POSTs, and every mutating route in this app is
 * a POST or a WS command — the GET surface is read-only by construction
 * (see the mutation gate in server.ts, which exempts GET/HEAD/OPTIONS).
 */
const COOKIE_SAME_SITE = 'Lax';

export interface GateRequest {
  readonly method: string;
  /** Origin-form target, e.g. "/api/models?provider=claude". */
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** The TCP peer (`socket.remoteAddress`); '' when the socket has none. */
  readonly peer: string;
}

/** Where a credential came from. Absence is a named case, not `undefined`. */
export type Credential =
  | { readonly source: 'header'; readonly token: string }
  | { readonly source: 'cookie'; readonly token: string }
  | { readonly source: 'query'; readonly token: string }
  | { readonly source: 'none' };

export type AuthDecision =
  | { readonly kind: 'allow' }
  /** Valid ?token= on a navigation: store it as a cookie and strip the query. */
  | { readonly kind: 'establish'; readonly token: string; readonly location: string }
  | { readonly kind: 'challenge'; readonly wants: 'html' | 'json' };

function headerValue(request: GateRequest, name: string): string | undefined {
  const raw = request.headers[name];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const jar: Record<string, string> = {};
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    if (!name || name in jar) continue;
    jar[name] = decodeURIComponent(part.slice(separator + 1).trim());
  }
  return jar;
}

function requestUrl(request: GateRequest): URL {
  // The origin is a placeholder: only pathname/search are ever read back out.
  return new URL(request.url, 'http://unleashd.invalid');
}

export function readCredential(request: GateRequest): Credential {
  const authorization = headerValue(request, 'authorization');
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer) return { source: 'header', token: bearer };

  const cookie = parseCookies(headerValue(request, 'cookie'))[SESSION_COOKIE];
  if (cookie) return { source: 'cookie', token: cookie };

  const query = requestUrl(request).searchParams.get(TOKEN_QUERY_PARAM)?.trim();
  if (query) return { source: 'query', token: query };

  return { source: 'none' };
}

/**
 * Constant-time comparison. Both sides are SHA-256 digests so the lengths
 * always match — `timingSafeEqual` neither throws nor leaks the token length.
 */
export function tokenMatches(presented: string, expected: Buffer): boolean {
  return timingSafeEqual(digestToken(presented), expected);
}

function wantsHtml(request: GateRequest): 'html' | 'json' {
  const accept = headerValue(request, 'accept') ?? '';
  const navigation = request.method === 'GET' || request.method === 'HEAD';
  return navigation && accept.includes('text/html') ? 'html' : 'json';
}

function locationWithoutToken(request: GateRequest): string {
  const url = requestUrl(request);
  url.searchParams.delete(TOKEN_QUERY_PARAM);
  return `${url.pathname}${url.search}`;
}

// Pattern: sum-types (docs/patterns.md#sum-types)
/**
 * Where a request came from, judged from what a web page cannot forge. Only
 * the first two are admitted without the key.
 *
 * - local: this machine's browser. Peer is loopback, nothing forwarded it, the
 *   Host is a loopback name (a DNS-rebinding page arrives with its own domain
 *   as Host), and any Origin is the page's own (a cross-site page opening
 *   ws://localhost/ws sends its own Origin, and browsers do not block
 *   cross-site WebSockets).
 * - tailnet: forwarded by `tailscale serve`, which connects from loopback and
 *   stamps the sender's login (overwriting any the client sent). Funnel and
 *   tagged devices get no login, so they are remote.
 * - remote: everything else — LAN, Funnel, a forged header from a non-loopback
 *   peer, a cross-site Origin. Needs the key.
 */
export type RequestSource =
  | { readonly kind: 'local' }
  | { readonly kind: 'tailnet'; readonly login: string }
  | { readonly kind: 'remote' };

const REMOTE: RequestSource = { kind: 'remote' };

export function isLoopbackAddress(address: string): boolean {
  const bare = address
    .trim()
    .toLowerCase()
    .replace(/^::ffff:/, '');
  return bare === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

function hostnameOf(host: string): string {
  try {
    return new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '[::1]' ||
    isLoopbackAddress(hostname)
  );
}

/** No Origin (a navigation, curl) or the page's own origin. `Origin: null` is foreign. */
function originIsOwn(request: GateRequest): boolean {
  const origin = headerValue(request, 'origin');
  if (origin === undefined) return true;
  const host = headerValue(request, 'host')?.toLowerCase() ?? '';
  try {
    return new URL(origin).host.toLowerCase() === host;
  } catch {
    return false;
  }
}

/** Every hop a proxy recorded is this machine (a local reverse proxy, never Serve). */
function forwardedOnlyLocally(request: GateRequest): boolean {
  const chain = headerValue(request, 'x-forwarded-for');
  if (chain === undefined) return true;
  return chain.split(',').every((hop) => isLoopbackAddress(hop));
}

/** κ: request → source. Classification only; the policy decides what each may do. */
export function classifyRequest(request: GateRequest): RequestSource {
  // Serve connects from loopback, so a non-loopback peer carrying a Tailscale
  // header forged it (Vite binds every interface once a key exists).
  if (!isLoopbackAddress(request.peer) || !originIsOwn(request)) return REMOTE;
  const login = headerValue(request, 'tailscale-user-login')?.trim();
  if (login) return { kind: 'tailnet', login };
  if (headerValue(request, 'tailscale-funnel-request') !== undefined) return REMOTE;
  if (!forwardedOnlyLocally(request)) return REMOTE;
  return isLoopbackHostname(hostnameOf(headerValue(request, 'host') ?? ''))
    ? { kind: 'local' }
    : REMOTE;
}

/** δ: thin dispatcher on the source. */
function admittedWithoutKey(source: RequestSource, owner: TailnetOwner): boolean {
  switch (source.kind) {
    case 'local':
      return true;
    case 'tailnet':
      return owner.kind === 'known' && owner.login === source.login;
    case 'remote':
      return false;
  }
}

function decideForRequiredPolicy(
  request: GateRequest,
  digest: Buffer,
  owner: TailnetOwner
): AuthDecision {
  const credential = readCredential(request);
  if (credential.source !== 'none' && tokenMatches(credential.token, digest)) {
    if (credential.source === 'query' && (request.method === 'GET' || request.method === 'HEAD')) {
      return {
        kind: 'establish',
        token: credential.token,
        location: locationWithoutToken(request),
      };
    }
    return { kind: 'allow' };
  }
  if (admittedWithoutKey(classifyRequest(request), owner)) return { kind: 'allow' };
  return { kind: 'challenge', wants: wantsHtml(request) };
}

/** δ: thin dispatcher on the policy variant. */
export function decideAuth(
  policy: AuthPolicy,
  request: GateRequest,
  owner: TailnetOwner
): AuthDecision {
  if (policy.kind === 'open') return { kind: 'allow' };
  return decideForRequiredPolicy(request, policy.digest, owner);
}

/**
 * A WebSocket upgrade has no way to render a login page and browsers cannot
 * set an Authorization header on `new WebSocket()` — the cookie established by
 * the page load, or the page being local/tailnet, is what authorizes the socket.
 */
export function authorizeUpgrade(
  policy: AuthPolicy,
  request: GateRequest,
  owner: TailnetOwner
): boolean {
  const decision = decideAuth(policy, request, owner);
  return decision.kind === 'allow' || decision.kind === 'establish';
}

export function isAuthEndpoint(url: string): boolean {
  return requestUrl({ method: 'GET', url, headers: {}, peer: '' }).pathname.startsWith(
    AUTH_PATH_PREFIX
  );
}

export function isSecureRequest(request: GateRequest): boolean {
  const forwarded = headerValue(request, 'x-forwarded-proto');
  return forwarded?.split(',')[0]?.trim() === 'https';
}

export function buildSessionCookie(token: string, options: { secure: boolean }): string {
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${COOKIE_SAME_SITE}`,
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
  ];
  if (options.secure) attributes.push('Secure');
  return attributes.join('; ');
}

export function buildClearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=${COOKIE_SAME_SITE}; Max-Age=0`;
}

/**
 * Only same-origin paths are honoured after login, so a crafted `redirectTo`
 * cannot turn the login form into an open redirect.
 */
export function safeRedirectTarget(value: unknown): string {
  if (typeof value !== 'string') return '/';
  if (!value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}
