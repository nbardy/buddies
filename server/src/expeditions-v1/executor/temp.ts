import { randomBytes } from 'node:crypto';
import { lstat, mkdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

// Pattern: fix-guards (docs/patterns.md#fix-guards)
// The Codex leader stopped on a heredoc when /tmp was excluded (2026-11-11).
// Keep scratch outside cwd/read grants and clean it with worktrees, including adoption.
// Guards: agent-restarts and real leader/checkout probes.
export async function privateTemp(): Promise<string> {
  return path.join(await realpath('/var/tmp'), `x${randomBytes(8).toString('base64url')}`);
}

/** Called AFTER persisting capabilities, before posting. Replay reuses the same private dir. */
export async function startTemp(dir: string): Promise<void> {
  await mkdir(dir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const info = await lstat(dir);
  if (!info.isDirectory() || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid?.())
    throw new Error(`turn temp is not an owned private directory: ${dir}`);
}

/** The same durable settle/close path as worktrees, including a restart's adoption. */
export const endTemp = (dir: string): Promise<void> => rm(dir, { recursive: true, force: true });
