import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { createConversationApplicationContext } from '../src/application/context';

/**
 * Regression (2026-10-08 audit): every broadcast went to every tab and `send` never looked at the
 * backlog, so one frozen tab (or a phone on a slow link) grew the server's heap without bound.
 * A tab that stops reading must be dropped, not buffered for.
 */
test('a client that stops reading is terminated once its backlog passes the cap', async () => {
  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer();
  server.on('upgrade', (request, socket, head) =>
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request))
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const context = createConversationApplicationContext({
    webSocketServer: wss,
    completionSuppressionMs: 0,
  });

  const client = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
  await once(client, 'open');
  // The tab freezes: it stops draining its socket, so the kernel buffers fill and `send` queues.
  (client as unknown as { _socket: { pause(): void } })._socket.pause();
  const [serverSide] = [...wss.clients];
  assert.ok(serverSide);

  try {
    const chunk = {
      type: 'chunk',
      conversationId: 'c1',
      text: 'x'.repeat(2 * 1024 * 1024),
    } as never;
    for (let i = 0; i < 40 && serverSide.readyState === WebSocket.OPEN; i += 1) {
      context.broadcast(chunk);
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.notEqual(serverSide.readyState, WebSocket.OPEN, 'a stalled client is dropped');
  } finally {
    client.terminate();
    for (const open of wss.clients) open.terminate();
    server.close();
  }
});
