// Review evidence only: real temporary crate + HTTP MCP + runtime; provider process is fake.
// Generate beside the original fixture so imports resolve, then remove the generated file.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = dirname(fileURLToPath(import.meta.url));
const repo = resolve(out, '../..');
const base = 'f1011d0b4a954a8bee82292ea212768565baa4b3';
const fixture = execFileSync('git', ['show', `${base}:server/test/buddies-v2.test.ts`], { cwd: repo, encoding: 'utf8' });
const helpers = fixture.slice(0, fixture.indexOf('// Rewritten for owner decision A'));
const fragment = readFileSync(resolve(out, 'cases.tsfrag'), 'utf8');
const generated = resolve(repo, `server/test/.delivery-review-${process.pid}.test.ts`);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const paths = ['server/src/buddies/mcp.ts', 'crates/unleashd-buddies/src/deliveries.rs', 'crates/unleashd-buddies/src/posts.rs', 'crates/unleashd-buddies/src/runs.rs'];
const hashes = () => Object.fromEntries(paths.map(path => [path, sha(readFileSync(resolve(repo, path)))]));
const before = hashes();
writeFileSync(generated, helpers + fragment);
try {
  const result = spawnSync('pnpm', ['exec', 'tsx', '--test', generated], { cwd: repo, encoding: 'utf8', env: process.env });
  writeFileSync(resolve(out, 'reproduction.log'), result.stdout + result.stderr);
  writeFileSync(resolve(out, 'reproduction.json'), JSON.stringify({ base, fixtureSha256: sha(fixture), before, after: hashes(), exitCode: result.status, error: result.error?.message, clock: new Date().toISOString(), scope: 'temporary stores; real crate/MCP/runtime; fake provider; no live CLI inference' }, null, 2) + '\n');
  process.stdout.write(result.stdout + result.stderr);
  process.exitCode = result.status ?? 1;
} finally {
  unlinkSync(generated);
}
