import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import express from 'express';
import { registerStaticClient } from '../src/lifecycle/static-client';

/**
 * Serves a fake Vite build through the real static mount over real HTTP.
 * The failure modes are both silent: an immutable index.html pins every phone
 * to a stale shell after a deploy, and a missing hashed chunk answered with
 * index.html (200, text/html) surfaces only as a MIME-type error in the
 * browser console of whoever still had the old page open.
 */

let directory = '';
let server: ReturnType<ReturnType<typeof express>['listen']> | null = null;
let base = '';

describe('static client caching', () => {
  before(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'unleashd-static-'));
    fs.mkdirSync(path.join(directory, 'assets'));
    fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html><title>app</title>');
    fs.writeFileSync(path.join(directory, 'assets', 'index-3f9a1c.js'), 'console.log(1);');
    fs.writeFileSync(path.join(directory, 'manifest.webmanifest'), '{}');
    const app = express();
    registerStaticClient(app, directory);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    base = `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;
  });

  after(() => {
    server?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test('hashed assets are immutable for a year', async () => {
    const response = await fetch(`${base}/assets/index-3f9a1c.js`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  });

  test('the app shell always revalidates, whichever route serves it', async () => {
    for (const route of ['/', '/index.html', '/chat/abc', '/manifest.webmanifest']) {
      const response = await fetch(`${base}${route}`);
      assert.equal(response.status, 200, route);
      assert.equal(response.headers.get('cache-control'), 'no-cache', route);
    }
  });

  test('a chunk from a previous build is a 404, not the SPA shell', async () => {
    const response = await fetch(`${base}/assets/index-0ld0ld.js`);
    assert.equal(response.status, 404);
    assert.doesNotMatch(await response.text(), /<title>app<\/title>/);
  });
});

describe('static client before the first build', () => {
  test('no build yet answers 503 with a retry hint, never the 500 handler', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'unleashd-static-empty-'));
    const app = express();
    registerStaticClient(app, empty);
    const listener = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
      const started = app.listen(0, '127.0.0.1', () => resolve(started));
    });
    try {
      const response = await fetch(
        `http://127.0.0.1:${(listener.address() as AddressInfo).port}/chat/abc`
      );
      assert.equal(response.status, 503);
      assert.equal(response.headers.get('retry-after'), '5');
      assert.match(await response.text(), /Client building/);
    } finally {
      listener.close();
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
