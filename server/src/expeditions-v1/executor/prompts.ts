import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { link, mkdir, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { keyed } from '@unleashd/shared';
import { runIdOf } from '../../expedition-kernel/core/tables';
import { runPaths } from './address';

// Every agent call's, judge's and leader wake's prompt, kept in the expedition directory (CONNECT_
// PLAN §10 F4). A closed run record drops the body it posted and the execution journals are
// deleted at settle, so until 2026-11-11 the only copy of a prompt was in a provider transcript.
// One file per run id beside its record (`runs/<name>.prompt.md`), written before the post and
// never rewritten. It holds the request body exactly as posted; the CLI receives it inside the
// Buddy runner's request line, after the Buddy's briefing.

/**
 * Keep `body` as the prompt of the run at `file`: created whole (tmp, fsync, link: a link never
 * replaces a file), never rewritten. A replayed start finds the same body there; a different one
 * is a bug (the body is a pure function of the run's spec), so it throws.
 */
export async function keepPrompt(file: string, body: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  const fh = await open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(body);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await link(tmp, file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    if ((await readFile(file, 'utf8')) !== body)
      throw new Error(
        `${file} holds a different prompt for the same run: prompts are never rewritten`
      );
  } finally {
    await rm(tmp, { force: true });
  }
}

const ROLES: readonly keyed.BarPrompt['role'][] = ['producer', 'judge'];

/** A view with each bar's kept prompts: the producer's, and its judge's, that exist on disk. */
export function withPrompts(root: string, view: keyed.KeyedView): keyed.KeyedView {
  const expDir = path.join(root, view.id);
  return {
    ...view,
    lanes: view.lanes.map((lane) => ({
      ...lane,
      bars: lane.bars.map((bar) => ({
        ...bar,
        prompts: ROLES.flatMap((role) => {
          const file = runPaths(
            expDir,
            runIdOf(view.id, bar.key, bar.hash, bar.attempt, role)
          ).prompt;
          // Two stats per bar on the owner's GET: not worth an async pass.
          return existsSync(file) ? [{ role, path: file }] : [];
        }),
      })),
    })),
  };
}
