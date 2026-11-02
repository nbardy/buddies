import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { gitBytes } from './git';
import type { CheckOutcome, PinCheck, SourcePin, ValidationReport } from './ledger';

// Validator source pins (R11, from oompa's task-validation/v1): SHA-256 of each file a check's argv
// names. Trust: bytes must equal those at `trustedSha`, so a worker cannot commit `exit 0` to its
// own oracle (2026-11-01 review); a file absent there is pinned at the candidate. Integrity: the
// pins are re-read after the run, so a check that rewrites its validator cannot pass.

/** An argv element that may name a repository file: relative, inside the tree, not a flag. */
const fileLike = (arg: string) =>
  arg !== '' &&
  !arg.startsWith('-') &&
  !path.isAbsolute(arg) &&
  !path.normalize(arg).split(path.sep).includes('..') &&
  !/\s/.test(arg);

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

type Blob = { t: 'file'; bytes: Buffer } | { t: 'none' };

/** A git failure throws, so the job ends `validation_failed`, never runs unpinned (2026-11-01
 * review: a catch-all counted every failure as "not a file"). */
async function blobAt(tree: string, sha: string, file: string): Promise<Blob> {
  const listed = String(await gitBytes(tree, ['ls-tree', '-z', sha, '--', path.normalize(file)]));
  const [, type, oid] = (listed.split('\t')[0] ?? '').split(' ');
  if (type !== 'blob' || !oid) return { t: 'none' };
  return { t: 'file', bytes: await gitBytes(tree, ['cat-file', 'blob', oid]) };
}

const diskHolds = async (tree: string, pin: SourcePin) => {
  const disk = await fsp.readFile(path.join(tree, pin.path)).catch(() => undefined);
  return disk !== undefined && sha256(disk) === pin.sha256;
};

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
    const pin = { path: file, sha256: sha256(blob.bytes) };
    if (!(await diskHolds(tree, pin)))
      return {
        t: 'mismatch',
        reason: `${file} in the validation tree is not the bytes committed at ${sha}`,
      };
    pins.push(pin);
  }
  return { t: 'pinned', pins };
}

export async function verifyPins(tree: string, pins: SourcePin[]): Promise<PinCheck> {
  const changed: string[] = [];
  for (const pin of pins) if (!(await diskHolds(tree, pin))) changed.push(pin.path);
  return changed.length === 0 ? { t: 'held' } : { t: 'changed', paths: changed };
}

/** A changed validator never passes, whatever it exited. */
export const pinnedOutcome = (outcome: CheckOutcome, check: PinCheck): CheckOutcome =>
  check.t === 'changed'
    ? {
        t: 'error',
        message: `the check changed its own validator source during the run: ${check.paths.join(', ')}`,
      }
    : outcome;

export const report = (
  targetSha: string,
  pins: SourcePin[],
  pinCheck: PinCheck
): ValidationReport => ({ t: 'expedition.validation/v1', targetSha, pins, pinCheck });
