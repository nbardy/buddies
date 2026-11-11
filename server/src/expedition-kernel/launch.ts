import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { keyed } from '@unleashd/shared';
import { checkPlan } from './change';
import { type Asked, diffOf, reservationOf, usd } from './core';
import { Expedition, type KernelDeps } from './kernel';
import { LogStore, type Repair } from './log-store';

// Starting an expedition, and opening one that exists. A launch is its preview (the gates, which
// write nothing anywhere) followed by the writes; the owner's `POST /preview` runs the first half
// alone (expeditions-v1/routes.ts).

export type Rejected = {
  readonly t: 'rejected';
  readonly gate: string;
  readonly issues: readonly string[];
};
/** A file that passed every gate: what launching it would write and start first. */
export type Clean = {
  readonly t: 'clean';
  readonly file: string;
  readonly contract: keyed.Contract;
  readonly defaults: keyed.PreviewDefaults;
  /** The calls a dry run asked for before it waited on an answer (canonical, hashed). */
  readonly asked: readonly Asked[];
  /** What each turn may do on its harness (every cast-table step, those first-wave calls, the
   * leader's wakes and the done reviews): the static gate's report, enforced or advisory. */
  readonly access: readonly keyed.TurnAccess[];
};
export type Previewed = Clean | Rejected;

export type LaunchResult = { readonly t: 'launched'; readonly expedition: Expedition } | Rejected;

/** Gates: the contract, then typecheck, dry run and the static checks. Writes nothing. */
export async function preview(deps: KernelDeps, file: string): Promise<Previewed> {
  const checked = await checkPlan(deps, file, () => undefined);
  if (checked.t === 'failed') return { t: 'rejected', gate: checked.gate, issues: checked.issues };
  return {
    t: 'clean',
    file,
    contract: checked.contract,
    defaults: checked.defaults,
    asked: checked.asked,
    access: checked.access,
  };
}

/** The wire's preview: the first wave and what it may spend, or the gate that refused it. */
export const previewView = (p: Previewed): keyed.KeyedPreview => PREVIEW_VIEW[p.t](p as never);
const PREVIEW_VIEW: {
  readonly [K in Previewed['t']]: (p: Extract<Previewed, { t: K }>) => keyed.KeyedPreview;
} = {
  rejected: (p) => ({ t: 'rejected', gate: p.gate, issues: [...p.issues] }),
  clean: (p) => {
    const firstWave = p.asked.map(
      (a): keyed.PreviewCall => ({
        key: a.call.key,
        kind: a.call.t,
        reservedUsd: reservationOf(a.call).usd,
      })
    );
    return {
      t: 'clean',
      defaults: p.defaults,
      goal: p.contract.goal,
      leader: p.contract.leader,
      repo: p.contract.repo,
      budget: { ...p.contract.budget },
      firstWave,
      costUsd: firstWave.reduce((sum, c) => usd(sum + c.reservedUsd), 0),
      access: [...p.access],
    };
  },
};

/** Gates (contract, typecheck, dry run + static), then the directory, `launched`, plan v0 and
 * the plan process. A failed gate writes nothing anywhere. `baseSha` is the repo commit the
 * calls' `{ t: 'launch' }` base names; the caller resolves it. `workspace` is the Buddy workspace
 * its agent calls run in (the executor's seat Buddy lives there). */
export async function launch(
  deps: KernelDeps,
  root: string,
  file: string,
  baseSha: string,
  workspace: keyed.LaunchWorkspace
): Promise<LaunchResult> {
  const p = await preview(deps, file);
  return p.t === 'rejected' ? p : launchClean(deps, root, p, baseSha, workspace);
}

/** The writes of a launch, for a file `preview` passed. */
export async function launchClean(
  deps: KernelDeps,
  root: string,
  clean: Clean,
  baseSha: string,
  workspace: keyed.LaunchWorkspace
): Promise<LaunchResult> {
  const now = deps.clock.now();
  const id = `${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}-${randomBytes(3).toString('hex')}`;
  const store = await LogStore.create(path.join(root, id));
  await store.copyPlan(clean.file, 0);
  const launched = keyed.Entry.parse({
    t: 'launched',
    at: now.toISOString(),
    id,
    contract: clean.contract,
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
      by: clean.contract.leader,
      why: 'launch',
      diff: diffOf(e.state(), clean.asked),
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
