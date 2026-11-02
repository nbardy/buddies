import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { gitBytes } from './git';
import type { CheckOutcome, PinCheck, SourcePin, ValidationReport } from './ledger';

// Validator source pins (design.md R11, ported from oompa's `oompa.task-validation/v1`): the
// SHA-256 of every repository file a check's argv names. Two guards:
// - Declared trust: a candidate validation trusts a validator file's bytes as they were on the
//   expedition branch when the manager declared the question's acceptance (`trustedSha`,
//   ledger.ts DeclaredAcceptance). A candidate whose bytes differ is refused before it runs, so a
//   worker cannot loosen the oracle that accepts its own work by committing `exit 0` to it.
//   (2026-11-01 review: pins taken at the candidate sha only recorded the cheat's own hash.) A
//   file the trusted commit does not have (a validator the candidate itself adds) is pinned at the
//   candidate: the manager trusted it by naming a file that did not exist yet. Re-declaring the
//   acceptance moves the trust to the head of that moment.
// - Run integrity: the pinned bytes are re-read from the tree after the run; a check that
//   rewrites its own validator while it runs cannot pass (its outcome becomes an `error`).
// The pins are recorded with every check result (the typed report below).

/** An argv element that may name a repository file: relative, inside the tree, not a flag. */
const fileLike = (arg: string) =>
  arg !== '' &&
  !arg.startsWith('-') &&
  !path.isAbsolute(arg) &&
  !path.normalize(arg).split(path.sep).includes('..') &&
  !/\s/.test(arg);

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** A path in a commit: a regular file (or symlink) with its bytes, or nothing there. */
type Blob = { t: 'file'; bytes: Buffer } | { t: 'none' };

/** What `<sha>:<file>` is. A git failure (a timeout, an oversized blob, a broken repository)
 * throws: the check job then ends `validation_failed` with the reason, never runs unpinned.
 * 2026-11-01 review: a catch-all here counted every failure as "not a file" and skipped the pin. */
async function blobAt(tree: string, sha: string, file: string): Promise<Blob> {
  const listed = (
    await gitBytes(tree, ['ls-tree', '-z', sha, '--', path.normalize(file)])
  ).toString();
  const [meta] = listed.split('\t');
  const [, type, oid] = (meta ?? '').split(' ');
  if (type !== 'blob' || !oid) return { t: 'none' };
  return { t: 'file', bytes: await gitBytes(tree, ['cat-file', 'blob', oid]) };
}

/** Before the run: the pins, or why the candidate may not run. */
export type Pinned = { t: 'pinned'; pins: SourcePin[] } | { t: 'mismatch'; reason: string };

export async function pinSources(
  tree: string,
  sha: string,
  trustedSha: string,
  argv: string[]
): Promise<Pinned> {
  const files = [...new Set(argv.filter(fileLike).map((a) => path.normalize(a)))];
  const pins: SourcePin[] = [];
  for (const file of files) {
    const blob = await blobAt(tree, sha, file);
    const trusted = await blobAt(tree, trustedSha, file);
    if (trusted.t === 'file' && (blob.t === 'none' || sha256(blob.bytes) !== sha256(trusted.bytes)))
      return {
        t: 'mismatch',
        reason: `the candidate changed the validator ${file} (trusted as committed at ${trustedSha.slice(0, 10)} when the acceptance was declared): re-declare the acceptance to trust new bytes`,
      };
    if (blob.t === 'none') continue; // not a file of the commit: a word, a module name, a URL
    const disk = await fsp.readFile(path.join(tree, file)).catch(() => undefined);
    const pin = { path: file, sha256: sha256(blob.bytes) };
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
