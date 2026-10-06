import { execFileSync } from 'node:child_process';

/**
 * A port the OS says is free right now. Fixed test ports (7531, 7541) made concurrent runs of
 * execution-adoption / ctrl-c-adoption die with EADDRINUSE, which made the 2026-10-05 outage
 * verification untrustworthy. These tests are CommonJS (no top-level await), so the probe is a
 * synchronous child: bind port 0, print it, exit. Guard: run two copies of each file at once.
 */
export function freePortSync(): number {
  const out = execFileSync(
    process.execPath,
    [
      '-e',
      "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})",
    ],
    { encoding: 'utf8' }
  );
  return Number(out.trim());
}
