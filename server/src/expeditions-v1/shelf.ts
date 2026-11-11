import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { keyed } from '@unleashd/shared';
import { type State, fold, liveCalls } from '../expedition-kernel/core';
import { type Tail, readLog } from '../expedition-kernel/log-store';
import type { ExpeditionView } from '../expedition-kernel/ports';

// The expeditions on disk, read without opening anything for write (CONNECT_PLAN §3, step 6): the
// read-only mode's whole source, and the live mode's source for expeditions it has not opened (a
// finished one). Reading a log never truncates a torn last line (`LogStore.open` does: a reader
// must not race a writer); the torn line is left out and reported as a fault. Nothing here creates
// a directory: a missing root is an empty shelf.

/** An expedition id is a directory name the kernel made (`launch.ts`): never a path. */
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
export const isExpeditionId = (id: string): boolean => ID.test(id);
/** The shape `launch.ts` gives an id (`20261111T120000-ab12cd`); the old host's ids are
 * `<slug>-<hex>`, so a tool told only an id can tell the two hosts apart. */
export const isKeyedId = (id: string): boolean => /^\d{8}T\d{6}-[0-9a-f]{6}$/.test(id);

export type Shelved =
  | { readonly t: 'readable'; readonly view: ExpeditionView }
  | { readonly t: 'unreadable'; readonly id: string; readonly why: string };

/** Every expedition directory under `root`, newest first (ids start with their launch time). */
export async function shelfIds(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return [];
    throw e;
  });
  return entries
    .filter((d) => d.isDirectory() && isExpeditionId(d.name))
    .map((d) => d.name)
    .sort()
    .reverse();
}

/** One expedition as its log says, read-only. */
export async function shelved(root: string, id: string): Promise<Shelved> {
  const dir = path.join(root, id);
  try {
    const { entries, tail } = await readLog(dir);
    const faults = (TAIL_FAULTS[tail.t] as (t: Tail) => keyed.Fault[])(tail);
    return {
      t: 'readable',
      view: {
        id,
        dir,
        state: fold(entries),
        timeline: keyed.timelineOf(entries),
        faults,
        entries,
      },
    };
  } catch (e) {
    return { t: 'unreadable', id, why: (e as Error).message };
  }
}

const TAIL_FAULTS: { readonly [K in Tail['t']]: (t: Extract<Tail, { t: K }>) => keyed.Fault[] } = {
  clean: () => [],
  'torn-last-line': (t) => [
    {
      at: new Date().toISOString(),
      what: `log: the last line is incomplete (${t.bytes} bytes), left out`,
    },
  ],
};

/** Whether boot must open it: its plan may still run, or a call it started has not settled
 * (after `finished`, judges, verdicts and asks still wind down, kernel.ts `finish`). */
export const needsOpening = (s: State): boolean =>
  s.progress.t === 'open' || liveCalls(s).length > 0;

// ---- Which expedition a proposal became ----

/** The file beside an expedition's log that names the proposal digest it was launched from. */
const PROPOSAL_FILE = 'proposal.json';
export async function recordProposal(root: string, id: string, digest: string): Promise<void> {
  await writeFile(path.join(root, id, PROPOSAL_FILE), JSON.stringify({ digest }), 'utf8');
}
export type LaunchedFrom = { readonly t: 'no' } | { readonly t: 'yes'; readonly id: string };
/** The expedition launched from `digest` (a card's launch), if any. An expedition without the
 * file (direct HTTP, or a crash between its launch and the write) was not launched from a card. */
export async function launchedFrom(root: string, digest: string): Promise<LaunchedFrom> {
  for (const id of await shelfIds(root)) {
    const text = await readFile(path.join(root, id, PROPOSAL_FILE), 'utf8').catch(
      (e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
    );
    if (text !== null && (JSON.parse(text) as { digest: string }).digest === digest)
      return { t: 'yes', id };
  }
  return { t: 'no' };
}
