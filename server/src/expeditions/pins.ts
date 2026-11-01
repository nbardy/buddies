import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gitEnv } from './git';
import type { CheckOutcome, PinCheck, SourcePin, ValidationReport } from './ledger';

// Validator source pins (design.md R11, ported from oompa's `oompa.task-validation/v1`): the
// SHA-256 of every repository file a check's argv names, read at the candidate commit before the
// run and re-read from the tree after it. A check that rewrites its own validator while it runs
// (a test runner patching the test, a verifier editing verify.py) cannot pass: its outcome becomes
// an `error` naming the changed files. Oompa incident: validator bytes were pinned so a candidate
// could not loosen the oracle that accepts it; here the pins are recorded with every check result
// (the typed report below) so the ledger says exactly which bytes were run.

const exec = promisify(execFile);

/** An argv element that may name a repository file: relative, inside the tree, not a flag. */
const fileLike = (arg: string) =>
  arg !== '' &&
  !arg.startsWith('-') &&
  !path.isAbsolute(arg) &&
  !path.normalize(arg).split(path.sep).includes('..') &&
  !/\s/.test(arg);

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** The blob at `<sha>:<file>`, or nothing when the commit has no such file. */
async function blobAt(tree: string, sha: string, file: string): Promise<Buffer | undefined> {
  try {
    const { stdout } = await exec('git', ['cat-file', 'blob', `${sha}:${path.normalize(file)}`], {
      cwd: tree,
      env: gitEnv(),
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return undefined;
  }
}

/** Before the run: the pins, or why the tree is not the commit it claims to be. */
export type Pinned = { t: 'pinned'; pins: SourcePin[] } | { t: 'mismatch'; reason: string };

export async function pinSources(tree: string, sha: string, argv: string[]): Promise<Pinned> {
  const files = [...new Set(argv.filter(fileLike).map((a) => path.normalize(a)))];
  const pins: SourcePin[] = [];
  for (const file of files) {
    const blob = await blobAt(tree, sha, file);
    if (!blob) continue; // not a file of the commit: a word, a module name, a URL
    const disk = await fsp.readFile(path.join(tree, file)).catch(() => undefined);
    const pin = { path: file, sha256: sha256(blob) };
    if (!disk || sha256(disk) !== pin.sha256)
      return {
        t: 'mismatch',
        reason: `${file} in the validation tree is not the bytes committed at ${sha}`,
      };
    pins.push(pin);
  }
  return { t: 'pinned', pins };
}

/** After the run: each pinned file re-read from the tree. */
export async function verifyPins(tree: string, pins: SourcePin[]): Promise<PinCheck> {
  const changed: string[] = [];
  for (const pin of pins) {
    const disk = await fsp.readFile(path.join(tree, pin.path)).catch(() => undefined);
    if (!disk || sha256(disk) !== pin.sha256) changed.push(pin.path);
  }
  return changed.length === 0 ? { t: 'held' } : { t: 'changed', paths: changed };
}

/** The check's outcome as recorded: a changed validator never passes, whatever it exited. */
export function pinnedOutcome(outcome: CheckOutcome, check: PinCheck): CheckOutcome {
  switch (check.t) {
    case 'held':
    case 'unpinned':
      return outcome;
    case 'changed':
      return {
        t: 'error',
        message: `the check changed its own validator source during the run: ${check.paths.join(', ')}`,
      };
  }
}

export const report = (
  targetSha: string,
  pins: SourcePin[],
  pinCheck: PinCheck
): ValidationReport => ({ t: 'expedition.validation/v1', targetSha, pins, pinCheck });
