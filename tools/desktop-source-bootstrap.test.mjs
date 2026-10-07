// Opt-in real first-run integration: requires a staged DMG payload (bundled Node + npm).
// Run BUDDIES_TEST_BUNDLE=<payload> node --test tools/desktop-source-bootstrap.test.mjs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareSource, selectedRuntime } from './desktop-source.mjs';

test(
  'a fresh managed clone builds its dependencies before typecheck and publishes a real runtime',
  {
    skip: !process.env.BUDDIES_TEST_BUNDLE,
  },
  async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'Buddies source bootstrap '));
    const bundle = path.join(home, 'bundle');
    const repository =
      process.env.BUDDIES_TEST_SOURCE_REPO || path.resolve(import.meta.dirname, '..');
    try {
      fs.mkdirSync(bundle);
      fs.symlinkSync(path.join(process.env.BUDDIES_TEST_BUNDLE, 'node'), path.join(bundle, 'node'));
      const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repository,
        encoding: 'utf8',
      }).trim();
      fs.writeFileSync(path.join(bundle, 'source.json'), JSON.stringify({ repository, revision }));
      assert.equal(selectedRuntime(home, bundle).source, null);
      await prepareSource({ home, bundle });
      const active = selectedRuntime(home, bundle);
      assert.equal(active.revision, revision);
      assert.equal(active.source, path.join(home, 'source'));
      assert.notEqual(active.runtime, bundle);
      assert.ok(fs.existsSync(path.join(active.runtime, 'server', 'dist', 'server.js')));
      assert.equal(
        execFileSync('git', ['status', '--porcelain'], { cwd: active.source, encoding: 'utf8' }),
        ''
      );
      assert.ok(!fs.existsSync(path.join(home, 'agent-viewer')));
      assert.ok(!fs.existsSync(path.join(home, 'buddies')));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
);
