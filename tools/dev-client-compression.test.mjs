import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { WebSocket } from 'ws';

const requireClient = createRequire(new URL('../client/package.json', import.meta.url));
const { createServer } = await import(pathToFileURL(requireClient.resolve('vite')).href);

function get(port, url, headers = {}) {
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: '127.0.0.1', port, path: url, headers }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
        );
        res.on('error', reject);
      })
      .on('error', reject);
  });
}

test('dev client compresses modules without weakening auth or buffering proxied streams', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'unleashd-dev-compression-'));
  const previousData = process.env.UNLEASHD_DATA_DIR;
  process.env.UNLEASHD_DATA_DIR = temporary;
  globalThis[Symbol.for('unleashd.dev.browserOpened')] = true;
  let server;
  try {
    server = await createServer({
      root: path.resolve('client'),
      configFile: path.resolve('client/vite.config.ts'),
      cacheDir: path.join(temporary, 'vite'),
      server: { host: '127.0.0.1', port: 0, watch: null, preTransformRequests: false },
      optimizeDeps: { noDiscovery: true, include: [] },
      plugins: [
        {
          name: 'stream-probe',
          configureServer(vite) {
            vite.middlewares.use('/api/compression-probe', (_req, res) => {
              res.setHeader('Content-Type', 'text/event-stream');
              res.write('data: first\n\n');
              setTimeout(() => res.end('data: last\n\n'), 500);
            });
          },
        },
      ],
    });
    await server.listen();
    const { port } = server.httpServer.address();
    const plain = await get(port, '/@vite/client', { 'Accept-Encoding': 'identity' });
    const compressed = await get(port, '/@vite/client', { 'Accept-Encoding': 'gzip' });
    assert.equal(plain.status, 200);
    assert.equal(compressed.status, 200);
    assert.equal(compressed.headers['content-encoding'], 'gzip');
    assert.deepEqual(gunzipSync(compressed.body), plain.body);
    assert.ok(compressed.body.length < plain.body.length / 2);
    const denied = await get(port, '/@vite/client', {
      Host: 'foreign.ts.net',
      'Accept-Encoding': 'gzip',
    });
    assert.equal(denied.status, 401);
    assert.equal(denied.headers['content-encoding'], undefined, 'auth runs before compression');
    await new Promise((resolve, reject) => {
      const started = Date.now();
      http
        .get(
          {
            hostname: '127.0.0.1',
            port,
            path: '/api/compression-probe',
            headers: { 'Accept-Encoding': 'gzip' },
          },
          (res) => {
            assert.equal(res.headers['content-encoding'], undefined);
            res.once('data', () => {
              try {
                assert.ok(
                  Date.now() - started < 400,
                  'first stream event arrives before the response ends'
                );
              } catch (error) {
                reject(error);
              }
            });
            res.on('end', resolve);
            res.on('error', reject);
          }
        )
        .on('error', reject);
    });
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/`, 'vite-hmr');
      socket.on('message', (data) => {
        if (JSON.parse(data.toString()).type === 'connected') {
          socket.close();
          resolve();
        }
      });
      socket.on('error', reject);
    });
  } finally {
    await server?.close();
    if (previousData === undefined) Reflect.deleteProperty(process.env, 'UNLEASHD_DATA_DIR');
    else process.env.UNLEASHD_DATA_DIR = previousData;
    await rm(temporary, { recursive: true, force: true });
  }
});
