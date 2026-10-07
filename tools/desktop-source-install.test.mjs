import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { readSourceStatus } from './desktop-source-status.mjs';
import { selectedRuntime } from './desktop-source.mjs';

// Installed app passed NODE_ENV=production: dev tools were skipped. Retry then
// silently skipped pnpm's non-TTY purge. Real install/build must recover both.
test('production desktop helper reinstalls dev tools without an interactive purge', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop production install '));
  const source = path.join(home, 'source');
  const bundle = path.join(home, 'bundle');
  const env = { ...process.env, NODE_ENV: 'production' };
  const run = (command, args, options = {}) =>
    execFileSync(command, args, { cwd: source, env, stdio: 'pipe', timeout: 60_000, ...options });
  try {
    fs.mkdirSync(path.join(source, 'dev-tool'), { recursive: true });
    fs.writeFileSync(
      path.join(source, 'dev-tool/package.json'),
      JSON.stringify({ name: 'desktop-build-fixture', version: '1.0.0', main: 'index.js' })
    );
    fs.writeFileSync(path.join(source, 'dev-tool/index.js'), "module.exports = 'compiled';");
    fs.mkdirSync(path.join(source, 'runtime-tool'));
    fs.writeFileSync(
      path.join(source, 'runtime-tool/package.json'),
      JSON.stringify({ name: 'desktop-runtime-fixture', version: '1.0.0' })
    );
    fs.writeFileSync(path.join(source, '.gitignore'), 'node_modules\ncompiled\n');
    fs.writeFileSync(path.join(source, 'pnpm-workspace.yaml'), 'packages:\n  - dev-tool\n');
    fs.writeFileSync(
      path.join(source, 'package.json'),
      JSON.stringify({
        name: 'desktop-install-fixture',
        version: '1.0.0',
        packageManager: 'pnpm@9.15.0',
        dependencies: { 'desktop-runtime-fixture': 'file:./runtime-tool' },
        devDependencies: { 'desktop-build-fixture': 'file:./dev-tool' },
        scripts: { build: 'node build.cjs', typecheck: 'node build.cjs' },
      })
    );
    fs.writeFileSync(
      path.join(source, 'build.cjs'),
      "require('node:assert/strict').equal(process.env.NODE_ENV, undefined);" +
        "require('node:fs').writeFileSync('compiled', require('desktop-build-fixture'));"
    );
    run('pnpm', ['install', '--lockfile-only']);
    run('pnpm', ['install', '--frozen-lockfile']);
    assert.ok(fs.existsSync(path.join(source, 'node_modules/desktop-runtime-fixture')));
    assert.ok(!fs.existsSync(path.join(source, 'node_modules/desktop-build-fixture')));
    run('git', ['init', '-q']);
    run('git', ['config', 'user.name', 'Fixture']);
    run('git', ['config', 'user.email', 'fixture@example.test']);
    run('git', ['add', '.']);
    run('git', ['commit', '-qm', 'production-only fixture']);
    fs.mkdirSync(path.join(bundle, 'node/bin'), { recursive: true });
    fs.symlinkSync(process.execPath, path.join(bundle, 'node/bin/node'));
    const pnpm = path.join(home, 'toolchain/node_modules/pnpm/bin/pnpm.cjs');
    fs.mkdirSync(path.dirname(pnpm), { recursive: true });
    fs.writeFileSync(pnpm, 'existing toolchain; pnpm executable comes from host PATH');
    const helper = pathToFileURL(path.join(import.meta.dirname, 'desktop-source.mjs')).href;
    const child = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import path from 'node:path';
      import { prepareSource } from ${JSON.stringify(helper)};
      await prepareSource({
        home: ${JSON.stringify(home)}, bundle: ${JSON.stringify(bundle)}, publishOnly: true,
        stage: async (source, target) => {
          fs.mkdirSync(path.join(target, 'server/dist'), { recursive: true });
          fs.copyFileSync(path.join(source, 'compiled'), path.join(target, 'server/dist/server.js'));
        },
        smoke: async target => assert.equal(fs.readFileSync(path.join(target, 'server/dist/server.js'), 'utf8'), 'compiled'),
      });
      assert.equal(process.env.NODE_ENV, 'production');
    `;
    run(process.execPath, ['--input-type=module', '-e', child]);
    assert.ok(fs.existsSync(path.join(source, 'node_modules/desktop-build-fixture')));
    assert.equal(readSourceStatus(home).kind, 'ready');
    assert.equal(
      fs.readFileSync(
        path.join(selectedRuntime(home, bundle).runtime, 'server/dist/server.js'),
        'utf8'
      ),
      'compiled'
    );
    assert.equal(run('git', ['status', '--porcelain'], { encoding: 'utf8' }), '');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
