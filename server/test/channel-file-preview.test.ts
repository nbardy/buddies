import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';
import { registerFilesystemRoutes } from '../src/http/filesystem-routes';

// PDF preview is an explicit exception to upload downloads, never an HTML/SVG bypass.
test('file viewer: only PDFs opt into inline delivery, other uploads remain downloads', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-viewer-'));
  const app = express();
  registerFilesystemRoutes(app, { uploadsDirectory: root, isUnderKnownProject: () => false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const name of ['report.PDF', 'active.html', 'active.svg', 'notes.md', 'archive.zip']) {
      const file = path.join(root, name);
      fs.writeFileSync(file, `contents of ${name}`);
      const url = `${base}/api/files?path=${encodeURIComponent(file)}`;
      for (const preview of ['', '&preview=1']) {
        const response = await fetch(url + preview);
        assert.equal(response.status, 200);
        assert.equal(await response.text(), `contents of ${name}`);
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        if (name === 'report.PDF' && preview) {
          assert.equal(response.headers.get('content-disposition'), null);
          assert.equal(response.headers.get('content-type'), 'application/pdf');
        } else {
          assert.match(response.headers.get('content-disposition') ?? '', /^attachment;/);
        }
      }
    }
    const outside = await fetch(
      `${base}/api/files?path=${encodeURIComponent('/etc/hosts')}&preview=1`
    );
    assert.equal(outside.status, 403);
    await outside.text();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
