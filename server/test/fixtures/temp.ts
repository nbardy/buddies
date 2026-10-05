import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Every dir handed out here is removed when the test process exits, whether or not the caller
// remembered to clean up. `unleashd-test-executions-*` alone reached 3,991 dirs in $TMPDIR
// (2026-10-05) because its creator dropped the path.
const owned = new Set<string>();
process.once('exit', () => {
  for (const dir of owned) rmSync(dir, { recursive: true, force: true });
});

/** A fresh temp directory, removed at process exit. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  owned.add(dir);
  return dir;
}
