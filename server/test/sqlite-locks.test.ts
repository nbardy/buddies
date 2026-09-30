import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Regression (2026-09-30, two live SIGBUS deaths in buddies-core.node): the uploads GC read every
// file under the app data and Buddies directories — the SQLite stores included — from a worker
// thread of the backend. POSIX locks belong to the process, so each close() released the stores'
// locks; the next outside opener then believed it was alone, reset the -shm the backend had
// mapped (SIGBUS) and, on close, checkpointed and deleted the backend's WAL. This boots the real
// backend on temp stores, lets a GC pass that scans the stores run, then opens every store from
// this (second) process: with the locks held, that opener must leave the WAL and -shm alone.

const SERVER_DIR = path.resolve(__dirname, '..');
// node:sqlite postdates the pinned @types/node (20), so it is typed here.
const { DatabaseSync } = createRequire(__filename)('node:sqlite') as {
  DatabaseSync: new (file: string) => { prepare(sql: string): { get(): unknown }; close(): void };
};
const DAY_MS = 24 * 60 * 60_000;

async function freePort(): Promise<number> {
  const server = net.createServer().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const size = (file: string) => (fs.existsSync(file) ? fs.statSync(file).size : 'absent');

test('the live backend keeps its SQLite locks through an uploads GC pass', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-locks-'));
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  const buddies = path.join(root, 'buddies');
  // PATH holds node alone: no agent CLI can launch and upstream's `git fetch` cannot run.
  const bin = path.join(root, 'bin');
  for (const dir of [home, data, buddies, bin]) fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  // A stale upload entry makes the GC pass scan its reference roots, which hold the stores.
  const stale = path.join(data, 'uploads', 'stale-entry');
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, 'shot.png'), 'x');
  const old = new Date(Date.now() - 90 * DAY_MS);
  fs.utimesSync(path.join(stale, 'shot.png'), old, old);
  fs.utimesSync(stale, old, old);

  const backend = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: SERVER_DIR,
    env: {
      HOME: home,
      PATH: `${bin}:/usr/bin:/bin`,
      UNLEASHD_DATA_DIR: data,
      BUDDIES_HOME: buddies,
      UNLEASHD_BUDDIES_DB: path.join(buddies, 'buddies-v3.sqlite'),
      UNLEASHD_HOST: '127.0.0.1',
      PORT: String(await freePort()),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    backend.kill('SIGKILL');
    if (backend.exitCode === null && backend.signalCode === null)
      await new Promise((resolve) => backend.once('exit', resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });

  let log = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`backend never finished a GC pass:\n${log}`)),
      60_000
    );
    const onData = (chunk: Buffer) => {
      log += chunk.toString();
      if (/\[uploads-gc\] deleted 1 entries/.test(log) && log.includes('Initial load complete')) {
        clearTimeout(timer);
        resolve();
      }
    };
    backend.stdout.on('data', onData);
    backend.stderr.on('data', onData);
    backend.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`backend exited (${code ?? signal}) before the GC pass:\n${log}`));
    });
  });

  const stores = [
    path.join(data, 'ingest.sqlite'),
    path.join(data, 'conversation-records.sqlite'),
    path.join(data, 'observability', 'turn-attempts.sqlite'),
    path.join(buddies, 'buddies-v3.sqlite'),
  ];
  for (const store of stores) {
    const before = { wal: size(`${store}-wal`), shm: size(`${store}-shm`) };
    assert.notEqual(before.wal, 'absent', `${store}: backend has no WAL open`);
    // A read-write outside connection, like the sqlite3 CLI. Were it the only lock holder it would
    // re-initialise -shm on open and checkpoint + delete the WAL on close.
    const outside = new DatabaseSync(store);
    outside.prepare('SELECT count(*) FROM sqlite_master').get();
    outside.close();
    // The backend may append meanwhile, so "kept" is: still present and no smaller.
    const after = { wal: size(`${store}-wal`), shm: size(`${store}-shm`) };
    const kept = (a: number | string, b: number | string) =>
      typeof a === 'number' && typeof b === 'number' && a >= b;
    assert.ok(
      kept(after.wal, before.wal) && kept(after.shm, before.shm),
      `${store}: an outside opener found no lock held by the backend (before ${JSON.stringify(before)}, after ${JSON.stringify(after)})`
    );
  }
  assert.equal(backend.exitCode, null, 'backend died');
});
