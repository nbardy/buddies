# Auth — shared secret

unleashd is a single-user personal tool, so auth is one shared secret rather
than accounts. This doc covers what that does and does not buy you, because the
answer depends entirely on which network path you reach the app over.

## What it protects

Everything. The gate is mounted before every route (`registerAuthRoutes` at the
top of the Express Routes section in `server/src/server.ts`) and before the
WebSocket upgrade, so an unauthenticated caller cannot read conversations, list
providers, browse the filesystem via `/api/filesystem`, upload files, drive an
agent, or even discover which endpoints exist. The static app shell is behind
the same gate.

The WebSocket matters most: it carries the whole command surface (create
conversation, queue message, run an agent in any working directory). That is
why the server uses `new WebSocketServer({ noServer: true })` plus an explicit
`server.on('upgrade')` handler. `new WebSocketServer({ server })` accepts every
upgrade before any application code runs — restoring it silently republishes
the command channel.

## Who needs the key (`classifyRequest` in `server/src/auth/gate.ts`)

The owner never types the key on their own devices. Each request is classified
from what a web page cannot forge, and only `remote` needs a credential:

| Source | Admitted without the key when |
|---|---|
| `local` — this machine's browser | the TCP peer is loopback, every `X-Forwarded-For` hop is loopback, the `Host` is a loopback name (`localhost`, `*.localhost`, `127.x`, `[::1]`), and any `Origin` is the request's own |
| `tailnet` — forwarded by `tailscale serve` | the peer is loopback, `Tailscale-User-Login` names this machine's owner (read from `tailscale status`, refreshed every minute), and any `Origin` is the request's own |
| `remote` — LAN, Funnel, tagged devices, another tailnet user, any foreign `Origin` | never; key, cookie or pairing code |

Why each check exists:

- **Origin.** Browsers do not block cross-site WebSockets. Without this check any
  site the owner visits could open `ws://localhost:7489/ws` and run agents; it
  was open exactly that way whenever no key was configured (the fresh-install
  default before 2026-10-05). `Origin: null` counts as foreign.
- **Host.** A DNS-rebinding page (`evil.example` re-resolved to 127.0.0.1) is
  same-origin to itself, so its Origin matches; its `Host` is still `evil.example`.
- **Peer for `tailnet`.** Serve connects from loopback. Vite listens on every
  interface once a key exists, so a LAN host can send a `Tailscale-User-Login`
  header straight to it; a non-loopback peer is therefore always `remote`.
- **Owner login, not any login.** A device someone shares into the tailnet
  arrives with their own login and still needs the key.

Serve overwrites a client-sent `Tailscale-User-Login` and `X-Forwarded-For`
(verified against tailscale 1.102.2 on 2026-10-05 with forged values: the owner's
login and the real `100.x` address arrived instead). Funnel requests carry
`Tailscale-Funnel-Request` and no login.

Trade-off, accepted deliberately: any process on this machine can call the API
without the key, agent turns included. They could already read the key file as
the same user; the key was never a boundary against local processes.

### Buddy turn callbacks are not public-route exceptions

An admitted Buddy turn sometimes needs its owning server to create another
conversation (delegation/review). Those callbacks use a separate ephemeral
loopback listener with a rotating conversation capability; they do **not** add
an allowlist, loopback exception, or hidden bearer to this public Express gate.
The owner process revalidates conversation liveness, Buddy scope, allowed
operation, and—during automation work—the exact private run claim token. The
listener closes with that server after its admitted turns drain.

This is an execution-lifetime boundary, not a second product API. Alternatives
and the reason public HTTP was rejected are recorded in
`agent_notes/2026-08-24_automation-execution-ownership-design.md` §8.

## Configuring the secret

In precedence order:

1. `UNLEASHD_AUTH_TOKEN` — env var.
2. `UNLEASHD_AUTH_TOKEN_FILE` — path to a file holding the token. A named file
   that cannot be read is a startup error, never a fallback to no auth.
3. `<UNLEASHD_DATA_DIR>/auth-token` — the conventional default, normally
   `~/.agent-viewer/auth-token`. This is the recommended option, and the server
   **creates it on first run** (64 hex characters, mode 0600) when none of the
   three exists. `pnpm dev` starts the backend and Vite at once; the file is
   created exclusively (`wx`), so whichever is first writes it and the other
   reads it.

An explicitly named file that is empty is also a startup error: a key is only
ever invented at the conventional path.

Prefer the file over the env var. The server spawns agent CLIs as child
processes and children inherit the environment, so a secret in
`UNLEASHD_AUTH_TOKEN` is readable by every agent the server launches.

Do **not** put the token in `~/.agent-viewer/settings.json` — that file is
served verbatim by `GET /api/settings`.

Tokens shorter than 16 characters are rejected at startup.

## Startup policy (`server/src/auth/policy.ts`)

`resolveAuthPolicy` is the single place the decision is made:

| Key | Result |
|---|---|
| configured | required (except `local` / owner `tailnet`, above) |
| none | one is created, then as above |
| none, `UNLEASHD_AUTH_DISABLED=1` | open, explicitly; nothing is created |

Until 2026-10-05 a missing key meant "open on loopback, refuse to start
anywhere else". Creating the key removed both the open state (and with it the
cross-site WebSocket hole) and the `openssl` step from mobile setup.

The Vite dev server binds `127.0.0.1` only when auth is disabled; a key is what
earns `host: true`. Since the key now always exists, `pnpm dev` listens on every
interface by default, and a LAN caller gets the login page.
Before this, `pnpm dev` bound every interface and proxied `/api` and `/ws`
straight to the backend, so anyone on the same wifi had the full API at
`http://<lan-ip>:7489` — the backend's own loopback bind did nothing to stop it.

## Presenting the secret

- `Authorization: Bearer <token>` — scripts, curl, anything non-browser.
- `unleashd_auth` cookie — set by the login form or a magic link. This is what
  authorizes the WebSocket: browsers cannot attach an Authorization header to
  `new WebSocket()`. Attributes, and why each one is what it is:

  | Attribute | Value | Reason |
  |---|---|---|
  | `Max-Age` | `31536000` (365 days) | Persistent, **not** a session cookie — otherwise the phone re-prompts every time Safari evicts the tab. Kept under Chrome's 400-day clamp. |
  | `HttpOnly` | always | Keeps the secret out of `document.cookie`, and out of ITP's 7-day cap on script-writable storage. |
  | `Secure` | only over https | A `Secure` cookie is dropped outright over http, so the loopback/LAN dev path would never stay signed in. Driven by `X-Forwarded-Proto`, which `tailscale serve` sets. |
  | `SameSite` | `Lax` | `Strict` withholds the cookie on cross-site navigations — opening unleashd from a link in Messages or Mail would show the login page despite a valid session. |
  | `Path` | `/` | One scope for the app, the API, and `/ws`. |

  `Lax` is safe here: it still withholds the cookie from cross-site
  subresources (fetch, XHR, the WebSocket handshake) and cross-site POSTs, and
  every mutating route is a POST or a WS command — the GET surface is read-only
  by construction, which the mutation gate in `server.ts` already assumes. The
  one GET with an effect is `/__auth/logout`, so a hostile page could navigate
  you to it and sign you out; an annoyance, not a disclosure.
- `?token=<token>` on a GET navigation — sets the cookie and immediately
  redirects to the same URL without the parameter. Convenient for bookmarking
  on a phone; note the token does pass through browser history and any proxy
  access log on the way.

Because the cookie is same-origin, `fetch()` and `new WebSocket()` send it
automatically — no client call sites needed changing.

`GET /__auth/logout` clears the cookie and returns to the login page.

## The login page

`server/src/auth/login-page.ts` renders a standalone, server-rendered document.
It cannot be a React route: the gate blocks the app bundle itself, so the page
has to render before any of the client's JS is reachable. That also means it
cannot consume `client/src/index.css`, so it repeats the Solarized `--theme-*`
values literally — keep the two in sync.

Routes:

| Route | Behaviour |
|---|---|
| `GET /__auth/login` | 200 + the form. Honours `?redirectTo=` and `?error=`. |
| `POST /__auth/login` | Content-negotiated: JSON for the enhanced form, 302/HTML for a plain form POST. |
| `GET /__auth/logout` | Clears the cookie, redirects to `?error=signed-out`. |
| `GET /__auth/pair?code=` | The pairing QR's target. Redeems the one-time code for the same year-long cookie, redirects to `/`; a used or expired code redirects to `?error=pairing-expired`. |

`GET /__auth/login` redirects straight to `redirectTo` when the caller is already
admitted (local, owner tailnet device, valid cookie), so a stale tab never shows
a form asking for a key nobody needs.

Error states are a named sum (`LoginNotice`), not a boolean, so "wrong key" and
"signed out" cannot collapse into one message:

- **Wrong key** → `Invalid access key, try again.` The form submits with
  `Accept: application/json` specifically so it can render this inline instead
  of reloading; a 302/HTML-only response would make the two indistinguishable.
- **Server unreachable** → `Cannot reach the server…`, from the `fetch` rejection
  path. A plain form POST cannot report this at all, which is why the page
  enhances the submit rather than relying on the browser's default.
- **No JS** → the plain `<form method="post">` still works and gets the HTML 401
  with the same message.

Mobile specifics that are load-bearing, not cosmetic: the input is explicitly
`font-size: 16px` (anything smaller makes iOS Safari zoom on focus), the page
uses `100svh` and `env(safe-area-inset-*)`, and the Paste button is created only
when `window.isSecureContext && navigator.clipboard?.readText` — outside a
secure context `navigator.clipboard` is undefined, the same trap gates G4/G5
guard against in `tools/check-client-invariants.sh`.

### Recovering an expired session

`client/src/auth/session.ts` wraps `window.fetch` once at boot: a 401 from any
same-origin request redirects to `/__auth/login?redirectTo=<current path>`.
There is no single API client to hook — roughly 45 call sites use `fetch`
directly — so the wrapper keeps the recovery in one place instead of spreading
an auth concern across every caller. `GET /__auth/login` is deliberately
ungated; if it 401'd, the redirect would loop.

The WebSocket hands no status code to its error handler, so a rejected upgrade
is indistinguishable from a dead server there. `useWebSocket` fires one cheap
`/api/settings` probe on disconnect: a 401 trips the wrapper and redirects,
anything else means the failure was not about auth and the reconnect loop owns
it.

## Is a shared secret enough?

It depends on the wire, not on the secret.

A shared key is a **bearer credential**: whoever presents it is you. It is only
ever as private as the channel carrying it. unleashd is served over plain http,
so:

- **Over Tailscale** — fine. The request is inside a WireGuard tunnel, so the
  key is encrypted end to end between your devices and cannot be sniffed by
  anything between them. Tailnet-only serve (no Funnel) means only your own
  devices can even open the connection; the key is the second layer.
- **Over the LAN** — weaker. Plain http means the key crosses the wire in
  cleartext, readable by anyone who can see your traffic (a shared or hostile
  wifi, an untrusted router). It is a real improvement over no auth — it stops
  casual and automated access from anything that merely reaches the port — but
  it is only as safe as the network you are on.

The honest summary: a shared key is proportionate for a single-user tool and it
closes the "anyone who can reach the port owns the machine" hole. It is not a
substitute for transport security on an untrusted network.

### Recommended hardening

Both are cheap and each removes the cleartext-on-the-wire caveat:

1. **Serve over https through Tailscale.** One command, real cert, no config
   change in this repo. Point it at the port that serves the **client**:

   ```bash
   tailscale serve --bg --https=443 http://127.0.0.1:7489
   ```

   | Mode | Client (serve this) | API |
   |---|---|---|
   | built app, `pnpm start` | `7489` (or `PORT`): UI, API and `/ws` on one port | same port |
   | development, `pnpm dev` | `7489`: Vite, which proxies `/api` and `/ws` | `7499`, never serve it |

   Serving `7499` in development gives the phone the API with no client to load.
   Setup → **Connect from mobile** (or **Connect mobile** at the bottom of the
   desktop sidebar) reads `tailscale status` and `tailscale serve status`, and
   only shows a URL when Serve answers on this node's *current* MagicDNS name and
   proxies to the client port (`server/src/auth/mobile-access.ts`). A renamed
   node keeps its old Serve entry, and the old name no longer resolves; that is
   how a phone was handed a dead URL on 2026-09-09. The owner's phone is
   admitted by its tailnet login and needs nothing more. **Show QR code**
   (`POST /api/mobile-access/pairing`, only reachable past the gate) mints a
   one-time pairing code (`server/src/auth/pairing.ts`: single use, 5 minutes,
   in memory, so a restart voids it) and returns
   `https://<host>/__auth/pair?code=…` with its QR as SVG. Scanning it sets the
   year-long cookie, which is what signs in a device that is not the owner's
   (another tailnet user, a tagged device). Neither the QR nor the copied URL
   ever carries the key itself, so it never lands in the phone's history, a
   proxy log or a screenshot. With auth disabled, Setup asks to turn it back on
   before Serve, since Serve connects from loopback.

   This also makes the page a *secure context*, which fixes the
   `crypto.randomUUID` / `navigator.clipboard` unavailability that gates G4 and
   G5 in `tools/check-client-invariants.sh` exist to work around.

2. **Keep the backend bound to loopback** (the default) and let Tailscale be
   the only thing that reaches it. If you want the backend itself on the
   tailnet interface instead, set `UNLEASHD_HOST=100.64.36.46`. Requests then
   arrive from a tailnet peer, not from Serve on loopback, so every device needs
   the key or a pairing code.

Do not enable Tailscale Funnel unless you specifically want the app on the
public internet; with Funnel on, the shared key becomes the *only* thing
between the internet and full agent execution on this machine.

## Known gaps

- No rate limiting on the login form. On a tailnet-only deployment the attacker
  set is your own devices; on a Funnel deployment this would need to change.
- Local admission covers every account on the machine, not just the owner's:
  any user who can reach `localhost` gets in. Fine on a personal machine.

## Why both servers need an `upgrade` handler

Connect middleware — `server.middlewares.use()` in the Vite plugin, and Express
in the backend — only ever runs on the HTTP server's `request` event. A
WebSocket does not arrive as a `request`; it arrives as an `upgrade`. So a
middleware-only gate never sees a socket at all, and the socket is open to
anyone who can reach the port.

Both servers therefore carry an explicit upgrade handler, and both must keep
one:

- **Backend (`server.ts`)** — `new WebSocketServer({ noServer: true })` plus
  `server.on('upgrade')`. This protects `/ws`, the whole command channel.
- **Vite dev server (`client/vite.config.ts`)** — `prependListener('upgrade')`,
  which protects Vite's HMR socket. `prependListener`, not `on`: Vite attaches
  its own upgrade listener when the dev server is built, and ours has to reject
  the socket before that one completes the handshake.

This was a live hole until it was fixed: `wss://<host>/` with
`Sec-WebSocket-Protocol: vite-hmr` and no credentials upgraded successfully from
the LAN as well as the tailnet. Vite's own `?token=` guard does not cover it —
that only engages when an `Origin` header is present (its CVE-2025-24010
mitigation), so a non-browser client just omits `Origin`. What leaked was file
paths and edit activity, not conversation data.

Regression check, which should return `401` on every line:

```bash
node -e "const {WebSocket}=require('ws');
  for (const u of ['ws://127.0.0.1:7489/','ws://127.0.0.1:7489/ws'])
    new WebSocket(u,'vite-hmr').on('unexpected-response',(_q,r)=>console.log(u,r.statusCode));"
```

## Files

| File | Role |
|---|---|
| `server/src/auth/policy.ts` | κ: env/disk → `AuthPolicy`; creates the key on first run |
| `server/src/auth/gate.ts` | framework-agnostic decisions, request classification, cookies, credentials |
| `server/src/auth/tailnet-owner.ts` | reads the tailnet owner's login for the `tailnet` admission |
| `server/src/auth/pairing.ts` | one-time pairing codes for the Connect-mobile QR |
| `server/src/auth/login-page.ts` | the unauthenticated landing page + its error states |
| `server/src/auth/express.ts` | Express adapter + `/__auth/login`, `/__auth/logout`, `/__auth/pair` |
| `server/src/server.ts` | mounts the gate; gates the WebSocket upgrade |
| `client/vite.config.ts` | same gate for the dev server; loopback bind default |
| `client/src/auth/session.ts` | 401 → login page recovery for the running app |
| `server/test/auth.test.ts` | boots the real server and probes it over real sockets |
