import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { PROTOCOL_MISMATCH_CLOSE_CODE, PROTOCOL_VERSION, WS_PATH } from '@unleashd/shared';
import { WebSocket, WebSocketServer } from 'ws';
import { createShutdownController } from '../src/lifecycle/shutdown';
import { registerConversationWebSocket } from '../src/transport/conversation-websocket';
import { superviseLiveness } from '../src/transport/websocket';

const CONVERSATION_ID = '00000000-0000-4000-8000-0000000000aa';

async function listen(wss: WebSocketServer): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer();
  server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (client) => wss.emit('connection', client, request));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: (server.address() as AddressInfo).port };
}

function nextMessageOfType(client: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const onMessage = (raw: Buffer) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.type !== type) return;
      client.off('message', onMessage);
      resolve(message);
    };
    client.on('message', onMessage);
  });
}

// Regression: until 2026-09-25 the WS handler awaited the startup barrier
// BEFORE taking a command slot, so the shutdown coordinator could not see the
// parked command. A dev reload requested while `starting` then exited the
// backend inside completeStartup(), and the parked queue_message woke up to
// `server_draining` — the user's message was dropped by a save during boot.
test(
  'a command parked on the startup barrier runs before a reload queued during startup',
  { timeout: 10_000 },
  async () => {
    const order: string[] = [];
    const controller = createShutdownController(
      { forceExitGraceMs: 60_000, flushGraceMs: 60_000 },
      {
        conversations: () => [],
        activeSchedulerRuns: () => 0,
        pauseScheduler: () => undefined,
        resumeScheduler: () => undefined,
        stopScheduler: () => undefined,
        flushState: () => undefined,
        exit: () => order.push('exit'),
      }
    );
    let finishStartup!: () => void;
    const initialLoadComplete = new Promise<void>((resolve) => {
      finishStartup = resolve;
    });
    const conversation = {
      id: CONVERSATION_ID,
      kind: { kind: 'general' },
      enqueueMessage: (content: string) => order.push(`enqueue:${content}`),
      toJSON: () => ({ id: CONVERSATION_ID }),
    };
    const wss = new WebSocketServer({ noServer: true });
    // Registered before the command handler, so when this resolves the handler
    // has already run synchronously up to its await on the startup barrier.
    let commandReceived!: () => void;
    const received = new Promise<void>((resolve) => {
      commandReceived = resolve;
    });
    wss.on('connection', (socket) => socket.on('message', () => commandReceived()));
    registerConversationWebSocket(wss, {
      listedRows: () => [],
      materialize: async () => undefined,
      forgetListed: () => undefined,
      registry: {
        get: (id: string) => (id === CONVERSATION_ID ? conversation : undefined),
        set: () => undefined,
        delete: () => false,
        // `hello` lists nothing: the stub has no messages to summarize, and a
        // summarize failure would be swallowed by the silenced logger and leave
        // the test waiting for a `hello` that never comes.
        values: () => [][Symbol.iterator](),
        keys: () => [CONVERSATION_ID][Symbol.iterator](),
      },
      sessions: {
        markDeleted: () => undefined,
        aliasEntries: () => [][Symbol.iterator](),
        unregisterConversationAliases: () => undefined,
      },
      externalActivity: { clear: () => undefined, has: () => false },
      completionSuppression: { clear: () => undefined },
      initialLoadComplete,
      isInitialLoadComplete: () => controller.state === 'idle',
      beginCommand: () => controller.beginMutation({ allowDuringStartup: true }),
      configService: { getRecord: async () => ({ status: 'active' }) },
      getDefaultWorkingDirectory: () => '/tmp',
      resolveWorkingDirectory: (directory: string) => directory,
      createConversationLink: async () => undefined,
      broadcast: () => undefined,
      broadcastExcept: () => undefined,
      logger: { log: () => undefined, error: () => undefined },
    } as never);
    const { server, port } = await listen(wss);
    const client = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`);
    try {
      await nextMessageOfType(client, 'hello');

      controller.handleReload();
      const reply = nextMessageOfType(client, 'ack');
      client.send(
        JSON.stringify({
          type: 'queue_message',
          commandId: 'typed-during-boot',
          conversationId: CONVERSATION_ID,
          content: 'hello',
        })
      );
      await received;

      // What server.ts markReady does: complete startup, then open the barrier.
      assert.equal(controller.completeStartup(), true, 'the parked command must hold the backend');
      finishStartup();

      const outcome = await reply;
      assert.deepEqual(outcome.result, { t: 'accepted' }, JSON.stringify(outcome));
      for (let attempt = 0; attempt < 50 && !order.includes('exit'); attempt++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      assert.deepEqual(order, ['enqueue:hello', 'exit']);
      assert.equal(controller.state, 'exiting');
    } finally {
      controller.dispose();
      client.terminate();
      wss.close();
      server.close();
    }
  }
);

// Regression (lean-scope final review, "Open"): a tab built before protocol v3
// kept its list after the swap and silently stopped updating, because every v3
// frame failed its schema. Its socket names no protocol (it connects to plain
// `/ws`, see f6cc2ca App.tsx), so the server must close it with the typed code;
// that tab then shows "disconnected" instead of a list that looks live.
test('a socket from a pre-v3 client is closed with the protocol mismatch code', async () => {
  const wss = new WebSocketServer({ noServer: true });
  registerConversationWebSocket(wss, {} as never);
  const { server, port } = await listen(wss);
  const oldClient = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  try {
    const [code, reason] = (await once(oldClient, 'close')) as [number, Buffer];
    assert.equal(code, PROTOCOL_MISMATCH_CLOSE_CODE);
    assert.equal(reason.toString(), `protocol ${PROTOCOL_VERSION}`);
  } finally {
    wss.close();
    server.close();
  }
});

// Message frames changed from `content` to `body` in v4. A v3 tab must get the
// close reason its existing mismatch handler turns into the reload banner.
test('a protocol v3 socket is closed with the v4 reload reason', async () => {
  const wss = new WebSocketServer({ noServer: true });
  registerConversationWebSocket(wss, {} as never);
  const { server, port } = await listen(wss);
  const oldClient = new WebSocket(`ws://127.0.0.1:${port}/ws?protocol=3`);
  try {
    const [code, reason] = (await once(oldClient, 'close')) as [number, Buffer];
    assert.equal(code, PROTOCOL_MISMATCH_CLOSE_CODE);
    assert.equal(reason.toString(), 'protocol 4');
  } finally {
    wss.close();
    server.close();
  }
});

test(
  'liveness terminates a half-open peer and keeps a responsive one',
  { timeout: 10_000 },
  async () => {
    const wss = new WebSocketServer({ noServer: true });
    const serverSides: WebSocket[] = [];
    wss.on('connection', (socket) => {
      serverSides.push(socket);
      superviseLiveness(socket, 25);
    });
    const { server, port } = await listen(wss);
    // A real client answers pings at the protocol level, like a browser does.
    const responsive = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(responsive, 'open');
    // A peer that completed the handshake and then went silent: what a slept
    // laptop or a dead link behind the dev port proxy looks like to the server.
    const silent = net.connect(port, '127.0.0.1');
    await once(silent, 'connect');
    silent.write(
      'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'
    );
    try {
      while (serverSides.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
      const [, silentServerSide] = serverSides;
      await Promise.race([
        once(silentServerSide, 'close'),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('half-open socket was never terminated')), 2_000)
        ),
      ]);
      assert.equal(responsive.readyState, WebSocket.OPEN, 'a peer that pongs must stay connected');
    } finally {
      responsive.terminate();
      silent.destroy();
      wss.close();
      server.close();
    }
  }
);

// Regression (review of 4d2b990): an event-loop stall longer than the interval
// made the overdue tick run before the already-arrived pong was read, so the
// server terminated a healthy client. The backend has measured 9.8s stalls.
// The client lives in another process so its pong really arrives mid-stall.
test(
  'liveness does not terminate a responsive peer when the server loop stalls',
  { timeout: 15_000 },
  async () => {
    const wss = new WebSocketServer({ noServer: true });
    const serverSides: WebSocket[] = [];
    wss.on('connection', (socket) => {
      serverSides.push(socket);
      superviseLiveness(socket, 100);
    });
    const { server, port } = await listen(wss);
    const client = spawn(
      process.execPath,
      [
        '-e',
        `const W = require('ws'); new W('ws://127.0.0.1:${port}'); setInterval(() => {}, 1000);`,
      ],
      { cwd: path.join(__dirname, '..'), stdio: 'ignore' }
    );
    try {
      while (serverSides.length < 1) await new Promise((resolve) => setTimeout(resolve, 10));
      // Stall right after a ping goes out: the pong then lands mid-stall and is
      // still unread when the overdue tick runs.
      const side = serverSides[0];
      const ping = side.ping.bind(side);
      let pinged = () => {};
      side.ping = (...args: Parameters<WebSocket['ping']>) => {
        ping(...args);
        pinged();
      };
      for (let stall = 0; stall < 4; stall++) {
        const closed = once(side, 'close');
        await Promise.race([
          new Promise<void>((resolve) => {
            pinged = resolve;
          }),
          closed,
        ]);
        if (side.readyState !== WebSocket.OPEN) break;
        // Stall in the check phase: libuv's next iteration then runs the (now
        // overdue) timers before the poll phase reads the pong.
        await new Promise((resolve) => setImmediate(resolve));
        const until = Date.now() + 350;
        while (Date.now() < until) {}
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(
        serverSides[0].readyState,
        WebSocket.OPEN,
        'a peer that pongs must survive our own stall'
      );
    } finally {
      client.kill();
      wss.close();
      server.close();
    }
  }
);
