import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runUploadsGc, runUploadsGcInChild, startUploadsGc } from '../src/uploads/gc';

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse('2026-09-25T12:00:00Z');

function makeEntry(uploads: string, name: string, ageDays: number): void {
  const dir = path.join(uploads, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '1700000000000_shot.png');
  fs.writeFileSync(file, 'x'.repeat(100));
  const at = new Date(NOW - ageDays * DAY);
  fs.utimesSync(file, at, at);
  fs.utimesSync(dir, at, at);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uploads-gc-'));
  const uploads = path.join(root, 'app', 'uploads');
  const transcripts = path.join(root, 'transcripts');
  fs.mkdirSync(transcripts, { recursive: true });
  for (const name of [
    'referenced-plain',
    'referenced-json-escaped',
    'referenced-url-encoded',
    'referenced-across-chunk',
    'live-conversation',
    'orphan-old',
    'channels',
  ])
    makeEntry(uploads, name, 90);
  makeEntry(uploads, 'orphan-recent', 2);
  fs.writeFileSync(
    path.join(transcripts, 'a.jsonl'),
    `{"content":"[Attached files]\\n${uploads}/referenced-plain/1700000000000_shot.png"}\n` +
      `{"content":"${uploads.replaceAll('/', '\\/')}\\/referenced-json-escaped\\/x.png"}\n` +
      `![shot](/api/files?path=${encodeURIComponent(`${uploads}/referenced-url-encoded/x.png`)})\n`
  );
  // The reference straddles the scanner's 1 MiB chunk boundary.
  const needle = `${uploads}/referenced-across-chunk/x.png`;
  const pad = (1 << 20) - Math.floor(needle.length / 2);
  fs.writeFileSync(path.join(transcripts, 'big.jsonl'), `${' '.repeat(pad)}${needle}\n`);
  return { root, uploads, transcripts };
}

const survivors = (uploads: string) => fs.readdirSync(uploads).sort();

test('uploads GC deletes only old entries nothing references', async () => {
  const { root, uploads, transcripts } = fixture();
  try {
    const report = await runUploadsGcInChild({
      uploadsDir: uploads,
      // The app data directory is a root too: the scan must skip the uploads dir inside it,
      // or every upload would reference itself by its own path.
      referenceRoots: [transcripts, path.join(root, 'app'), path.join(root, 'absent-provider')],
      protectedNames: ['live-conversation'],
      maxAgeMs: 30 * DAY,
      nowMs: NOW,
    });
    assert.deepEqual(
      report.deleted.map((entry) => entry.name),
      ['orphan-old']
    );
    assert.deepEqual(survivors(uploads), [
      'channels',
      'live-conversation',
      'orphan-recent',
      'referenced-across-chunk',
      'referenced-json-escaped',
      'referenced-plain',
      'referenced-url-encoded',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('uploads GC deletes nothing when a reference root cannot be read', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignores directory permissions');
  const { root, uploads, transcripts } = fixture();
  const locked = path.join(root, 'locked');
  fs.mkdirSync(locked);
  fs.writeFileSync(path.join(locked, 'b.jsonl'), '');
  fs.chmodSync(locked, 0o000);
  try {
    const before = survivors(uploads);
    await assert.rejects(
      runUploadsGc({
        uploadsDir: uploads,
        referenceRoots: [transcripts, locked],
        protectedNames: [],
        maxAgeMs: 30 * DAY,
        nowMs: NOW,
      })
    );
    assert.deepEqual(survivors(uploads), before);
  } finally {
    fs.chmodSync(locked, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Regression (2026-10-06): the GC ran at EVERY backend start. Stale entries are mostly kept (still
// referenced), so each restart re-read ~10 GB of transcripts for nothing: 8+ minutes at ~100% CPU
// while the UI said "Buddies is loading slowly". The schedule is now a day after the last SUCCESS.
test('restart: no pass within a day of the last success, a pass once it is due', async () => {
  const { root, uploads, transcripts } = fixture();
  const stateFile = path.join(root, 'uploads-gc.json');
  const inputs = async () => ({
    uploadsDir: uploads,
    referenceRoots: [transcripts, path.join(root, 'app')],
    protectedNames: [],
    maxAgeMs: 30 * DAY,
  });
  const recent = Date.now() - 60 * 60_000;
  fs.writeFileSync(stateFile, JSON.stringify({ lastSuccessMs: recent }));
  let stop = startUploadsGc(inputs, { stateFile, firstDelayMs: 0 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.ok(survivors(uploads).includes('orphan-old'), 'ran a pass an hour after the last one');
    assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).lastSuccessMs, recent);
    stop();

    fs.writeFileSync(stateFile, JSON.stringify({ lastSuccessMs: Date.now() - 25 * 60 * 60_000 }));
    stop = startUploadsGc(inputs, { stateFile, firstDelayMs: 0 });
    const deadline = Date.now() + 30_000;
    while (survivors(uploads).includes('orphan-old') && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(!survivors(uploads).includes('orphan-old'), 'no pass ran once it was due');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(JSON.parse(fs.readFileSync(stateFile, 'utf8')).lastSuccessMs > recent);
  } finally {
    stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ingest.sqlite is a derived copy and is not scanned; any other store still is', async () => {
  const { root, uploads, transcripts } = fixture();
  const app = path.join(root, 'app');
  makeEntry(uploads, 'only-in-ingest-copy', 90);
  makeEntry(uploads, 'only-in-other-store', 90);
  fs.writeFileSync(path.join(app, 'ingest.sqlite'), `${uploads}/only-in-ingest-copy/x.png`);
  fs.writeFileSync(path.join(app, 'records.sqlite'), `${uploads}/only-in-other-store/x.png`);
  try {
    const report = await runUploadsGc({
      uploadsDir: uploads,
      referenceRoots: [transcripts, app],
      protectedNames: [],
      maxAgeMs: 30 * DAY,
      nowMs: NOW,
    });
    const deleted = report.deleted.map((entry) => entry.name);
    assert.ok(deleted.includes('only-in-ingest-copy'));
    assert.ok(!deleted.includes('only-in-other-store'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
