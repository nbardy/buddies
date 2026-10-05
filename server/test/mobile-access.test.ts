import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MobileAccessSchema } from '@unleashd/shared';
import { readMobileAccess } from '../src/auth/mobile-access';
import { digestToken } from '../src/auth/policy';
import { readTailnetOwner } from '../src/auth/tailnet-owner';

// A fake `tailscale` CLI replaying the JSON shapes captured from a real node on
// 2026-10-05 (`status --json --peers=false`, `serve status --json`).
async function fakeTailscale(status: object, serve: object, statusExit = 0) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-access-'));
  await fs.writeFile(path.join(dir, 'status.json'), JSON.stringify(status));
  await fs.writeFile(path.join(dir, 'serve.json'), JSON.stringify(serve));
  const bin = path.join(dir, 'tailscale');
  await fs.writeFile(
    bin,
    `#!/bin/sh\ncase "$1" in\n  status) cat "${dir}/status.json"; exit ${statusExit};;\n  serve) cat "${dir}/serve.json";;\nesac\n`,
    { mode: 0o755 }
  );
  return bin;
}

const HOST = 'nicholass-macbook-air-2.tail58a146.ts.net';
const RUNNING = { BackendState: 'Running', Self: { DNSName: `${HOST}.` } };
const required = {
  kind: 'required',
  digest: digestToken('k'.repeat(32)),
  token: 'k'.repeat(32),
} as const;
const key = { kind: 'file', path: '/home/me/.agent-viewer/auth-token' } as const;
const web = (entries: Record<string, string>) => ({
  Web: Object.fromEntries(
    Object.entries(entries).map(([hostPort, proxy]) => [
      hostPort,
      { Handlers: { '/': { Proxy: proxy } } },
    ])
  ),
});

test('only a Serve handler on the current name, proxying to the UI port, yields a URL', async () => {
  const probe = async (serve: object, uiPort = 7489) =>
    MobileAccessSchema.parse(
      await readMobileAccess({
        tailscale: [await fakeTailscale(RUNNING, serve)],
        uiPort,
        auth: required,
        key,
      })
    );

  // 2026-09-09: Serve still answered for the node's OLD MagicDNS name, so the
  // phone was handed a dead URL. A stale-name entry must not count.
  const stale = await probe(
    web({ 'nicholass-macbook-air.tail58a146.ts.net:443': 'http://127.0.0.1:7489' })
  );
  assert.equal(stale.kind, 'serve_missing');
  assert.match(stale.kind === 'serve_missing' ? stale.command : '', /http:\/\/127\.0\.0\.1:7489$/);

  // docs/auth.md once pointed Serve at 7499: the dev API, which serves no client.
  assert.equal(
    (await probe(web({ [`${HOST}:443`]: 'http://127.0.0.1:7499' }))).kind,
    'serve_missing'
  );

  const ready = await probe(web({ [`${HOST}:443`]: 'http://127.0.0.1:7489' }));
  assert.deepEqual(ready, { kind: 'ready', url: `https://${HOST}/`, funnel: false, key });

  // A built app on a custom PORT is served from that port, not 7489.
  const custom = await probe(web({ [`${HOST}:443`]: 'http://localhost:8123' }), 8123);
  assert.equal(custom.kind, 'ready');

  const funnel = await probe({
    ...web({ [`${HOST}:443`]: 'http://127.0.0.1:7489' }),
    AllowFunnel: { [`${HOST}:443`]: true },
  });
  assert.equal(funnel.kind === 'ready' && funnel.funnel, true);
});

test('missing CLI, logged-out node and open auth are actionable states, never a URL', async () => {
  const missing = await readMobileAccess({
    tailscale: [path.join(os.tmpdir(), 'no-such-tailscale-binary')],
    uiPort: 7489,
    auth: required,
    key,
  });
  assert.deepEqual(missing, { kind: 'tailscale_missing' });

  // Logged out: `status` exits 1 but still prints JSON with the backend state.
  const loggedOut = await readMobileAccess({
    tailscale: [await fakeTailscale({ BackendState: 'NeedsLogin', Self: {} }, {}, 1)],
    uiPort: 7489,
    auth: required,
    key,
  });
  assert.deepEqual(loggedOut, { kind: 'tailscale_stopped', state: 'NeedsLogin' });

  // Serve forwards from 127.0.0.1, so with sign-in disabled the tailnet would
  // get the app with no sign-in. Report it, flag the exposure.
  const open = await readMobileAccess({
    tailscale: [await fakeTailscale(RUNNING, web({ [`${HOST}:443`]: 'http://127.0.0.1:7489' }))],
    uiPort: 7489,
    auth: { kind: 'open', reason: 'explicitly-disabled' },
    key,
  });
  assert.deepEqual(open, {
    kind: 'access_key_missing',
    command: 'unset UNLEASHD_AUTH_DISABLED',
    exposed: true,
  });
});

test('a CLI that prints prose instead of JSON is a failed state, not a server crash', async () => {
  // 2026-10-05: the app-bundled CLI, started without the GUI, printed this and
  // exited 0. Parsing it inside execFile's callback threw past every handler.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-access-'));
  const bin = path.join(dir, 'Tailscale');
  await fs.writeFile(bin, '#!/bin/sh\necho "The Tailscale GUI failed to start."\n', {
    mode: 0o755,
  });
  const result = await readMobileAccess({ tailscale: [bin], uiPort: 7489, auth: required, key });
  assert.equal(result.kind, 'failed');
  assert.match(result.kind === 'failed' ? result.message : '', /GUI failed to start/);
});

test("the tailnet owner is the login of the node's own user; a tagged node has none", async () => {
  // Shapes from `tailscale status --json --peers=false` on 2026-10-05: UserID is
  // a number, the User map is keyed by its decimal string. Mixing those up
  // silently makes every phone fall back to the key.
  const owned = await fakeTailscale(
    {
      ...RUNNING,
      Self: { DNSName: `${HOST}.`, UserID: 5950312854658095 },
      User: { '5950312854658095': { LoginName: 'owner@example.com' } },
    },
    {}
  );
  assert.deepEqual(await readTailnetOwner([owned]), { kind: 'known', login: 'owner@example.com' });

  // A tagged node is owned by its tags, not a user: no login may be trusted.
  const tagged = await fakeTailscale({ ...RUNNING, Self: { DNSName: `${HOST}.` }, User: {} }, {});
  assert.deepEqual(await readTailnetOwner([tagged]), { kind: 'unknown' });
  assert.deepEqual(await readTailnetOwner([path.join(os.tmpdir(), 'no-such-tailscale')]), {
    kind: 'unknown',
  });
});

test('an unreadable CLI is an error, never "no owner"', async () => {
  // watchTailnetOwner keeps the last owner when a read fails. If this mapped to
  // `unknown` instead, one slow `tailscale status` would sign the owner's phone
  // out for a minute (seen as a 1-in-6 auth test flake, 2026-10-05).
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-access-'));
  const bin = path.join(dir, 'Tailscale');
  await fs.writeFile(bin, '#!/bin/sh\necho "The Tailscale GUI failed to start."\n', {
    mode: 0o755,
  });
  await assert.rejects(readTailnetOwner([bin]), /GUI failed to start/);
});
