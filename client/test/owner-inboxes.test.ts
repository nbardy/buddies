import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { ownerInboxesResource } from '../src/components/buddies/channel-data';

test('background inbox reads leave connections for the visible page and preserve every workspace', async () => {
  let active = 0;
  let peak = 0;
  const seen: string[] = [];
  const server = createServer((req, res) => {
    active += 1;
    peak = Math.max(peak, active);
    seen.push(req.url ?? '');
    setTimeout(() => {
      active -= 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ requests: [], waitingOn: [], channels: [], unreadThreads: 0 }));
    }, 10);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const fetch = globalThis.fetch;
  // Resolve the app's relative URLs against a real HTTP server, retaining fetch's abort behavior.
  globalThis.fetch = (input, init) =>
    fetch(new URL(String(input), `http://127.0.0.1:${address.port}`), init);
  try {
    const ids = Array.from({ length: 18 }, (_, i) => `workspace_${i}`);
    const result = await ownerInboxesResource(ids).load(new AbortController().signal);
    assert.deepEqual(Object.keys(result).sort(), [...ids].sort());
    assert.equal(seen.length, ids.length);
    assert.equal(peak, 2, 'the unread badge must not occupy all six HTTP/1 connections');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(ownerInboxesResource(ids).load(controller.signal), { name: 'AbortError' });
    assert.equal(seen.length, ids.length, 'an aborted refresh starts no more workspace reads');
  } finally {
    globalThis.fetch = fetch;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
