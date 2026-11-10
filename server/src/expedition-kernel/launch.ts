import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { keyed } from '@unleashd/shared';
import { checkPlan } from './change';
import { parseContract } from './contract';
import { diffOf } from './core';
import { Expedition, type KernelDeps } from './kernel';
import { LogStore, type Repair } from './log-store';

// Starting an expedition, and opening one that exists.

export type LaunchResult =
  | { readonly t: 'launched'; readonly expedition: Expedition }
  | { readonly t: 'rejected'; readonly gate: string; readonly issues: readonly string[] };

/** Gates (contract, typecheck, dry run + static), then the directory, `launched`, plan v0 and
 * the plan process. A failed gate writes nothing anywhere. `baseSha` is the repo commit the
 * calls' `{ t: 'launch' }` base names; the caller resolves it. `workspace` is the Buddy workspace
 * its agent calls run in (the executor's seat Buddy lives there). */
export async function launch(
  deps: KernelDeps,
  root: string,
  folder: string,
  baseSha: string,
  workspace: keyed.LaunchWorkspace
): Promise<LaunchResult> {
  const markdown = await readFile(path.join(folder, 'contract.md'), 'utf8');
  const contract = parseContract(markdown);
  if (contract.t === 'invalid') return { t: 'rejected', gate: 'contract', issues: contract.issues };
  const checked = await checkPlan(deps, folder, contract.contract, () => undefined);
  if (checked.t === 'failed') return { t: 'rejected', gate: checked.gate, issues: checked.issues };
  const now = deps.clock.now();
  const id = `${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}-${randomBytes(3).toString('hex')}`;
  const store = await LogStore.create(path.join(root, id), markdown);
  await store.copyPlan(folder, 0);
  const launched = keyed.Entry.parse({
    t: 'launched',
    at: now.toISOString(),
    id,
    contract: contract.contract,
    baseSha,
    workspace,
  });
  await store.append(launched);
  const e = Expedition.over(deps, store, [launched]);
  // The core requires the launch plan before any declaration.
  await e.serial(() =>
    e.append({
      t: 'plan',
      version: 0,
      by: contract.contract.leader,
      why: 'launch',
      diff: diffOf(e.state(), checked.asked),
      dropped: {},
    })
  );
  await e.boot();
  return { t: 'launched', expedition: e };
}

/** Boot: fold the log, recover every started call (R1), start the plan process. */
export async function open(
  deps: KernelDeps,
  dir: string
): Promise<{ expedition: Expedition; repair: Repair }> {
  const { store, entries, repair } = await LogStore.open(dir);
  const e = Expedition.over(deps, store, entries);
  if (repair.t !== 'clean') e.fault(`log: truncated a torn last line (${repair.bytes} bytes)`);
  await e.boot();
  return { expedition: e, repair };
}
