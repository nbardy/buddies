import os from 'node:os';
import path from 'node:path';
import { systemClock } from '../../src/expedition-kernel/clock';
import { type KernelDeps, launch } from '../../src/expedition-kernel/kernel';
import { HostExecutor } from '../../src/expeditions-v1/executor';
import { ScriptedLeader, ScriptedOwner, Signal, reported } from './expedition-ports';

// A kernel over the REAL host executor (commands and checks run as processes on a real repo), with
// the leader and the owner scripted: no agent runs exist yet. Run as a script it is a host process
// a test can SIGKILL: `node --import tsx expedition-host.ts <root> <plan folder> <base sha>`
// launches, prints `{"dir": ...}` and stays up until killed.

const SERVER = path.resolve(__dirname, '..', '..');
/** No Buddies in this host: an agent or review call settles `errored` with this reason. */
export const NO_CALLS = { t: 'none', why: 'this host runs no Buddy calls' } as const;

export type Host = { readonly deps: KernelDeps; readonly leader: ScriptedLeader };

export function hostDeps(root: string): Host {
  const leader = new ScriptedLeader(new Signal(), () => ({
    act: { t: 'stop', why: 'the scripted leader stops' },
    spent: reported(0),
  }));
  return {
    leader,
    deps: {
      executor: new HostExecutor({ root, home: os.homedir(), clock: systemClock, calls: NO_CALLS }),
      leader,
      owner: new ScriptedOwner(() => false),
      clock: systemClock,
      providerOf: (who) => ({
        t: 'unknown',
        why: `no agents in this host (${JSON.stringify(who)})`,
      }),
      gates: {
        zodEntry: path.join(SERVER, 'node_modules', 'zod'),
        tscBin: path.join(SERVER, 'node_modules', '.bin', 'tsc'),
      },
      limits: {
        leaderWake: { usd: 0.01, minutes: 1 },
        doneReview: { usd: 0.01, minutes: 1 },
      },
    },
  };
}

async function main(): Promise<void> {
  const [root, folder, baseSha] = process.argv.slice(2);
  if (!root || !folder || !baseSha) throw new Error('usage: <root> <plan folder> <base sha>');
  const r = await launch(hostDeps(root).deps, root, folder, baseSha, { t: 'none' });
  if (r.t !== 'launched') throw new Error(`launch rejected at ${r.gate}: ${r.issues.join('; ')}`);
  process.stdout.write(`${JSON.stringify({ dir: r.expedition.dir })}\n`);
  setInterval(() => {}, 60_000);
}

// Run as a script, not imported (tsx may load the entry through its ESM hooks: no require.main).
if (path.resolve(process.argv[1] ?? '') === __filename)
  main().catch((e: unknown) => {
    process.stderr.write(`${(e as Error).stack ?? String(e)}\n`);
    process.exit(1);
  });
