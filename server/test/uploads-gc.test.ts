import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runUploadsGc, runUploadsGcInChild } from '../src/uploads/gc';

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
