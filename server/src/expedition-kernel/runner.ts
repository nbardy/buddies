import { type ChildProcess, spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { keyed } from '@unleashd/shared';
import { labelled } from '../observability/event-loop-stall';
import { type Authored, type CastRow, FromPlan, type ToPlan } from './protocol';

// The plan runner (docs/expeditions/keyed/v1/DESIGN.md §2, §5): runs one expedition file in
// a child process and relays its calls. The child holds nothing that matters; the host answers
// every call (from its log or by running it), and may kill the child and start a fresh one at any
// time. A dry run is the same run where the host answers only what it already knows.

/** The authoring library a plan imports as `expedition`: the runner loads it, and the typecheck
 * gate checks plans against it (gates.ts). There is no second copy of the API to drift. */
export const AUTHORING_ENTRY = path.join(__dirname, 'authoring', 'index.ts');
const CHILD = path.join(__dirname, 'runner-child.mjs');
const TSX_LOADER = require.resolve('tsx');
/** The child's `exit` event says its leader is gone, not its whole process group: SIGKILL is
 * delivered asynchronously, so a tsx worker can outlive the leader by a few milliseconds. Under
 * load `kill()` resolved while the group still answered signal 0 (1 run in about 8 on 2026-11-10;
 * guard: expedition-kernel-runner "kill leaves no child"). Wait, bounded, until the group is gone. */
async function groupGone(pid: number): Promise<void> {
  for (let tries = 0; tries < 400; tries++) {
    try {
      process.kill(-pid, 0);
    } catch {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(labelled('timer expedition-plan-group-gone', resolve), 5);
    });
  }
}

/** After the child reports its end it exits by itself; past this it is killed. */
const EXIT_GRACE_MS = 2_000;
const STDERR_TAIL = 8_192;

export type PlanEnd =
  | { readonly t: 'candidate'; readonly ref: keyed.RefId }
  | { readonly t: 'gap'; readonly why: string; readonly evidence: readonly keyed.Input[] }
  | { readonly t: 'threw'; readonly message: string }
  /** `kill()` ended it. */
  | { readonly t: 'killed' }
  /** It exited without reporting an end. */
  | { readonly t: 'crashed'; readonly exit: Exit; readonly stderr: string };
export type Exit =
  | { readonly t: 'code'; readonly code: number }
  | { readonly t: 'signal'; readonly signal: string };

export type PlanEvents = {
  /** The plain owner contract; the first message. */
  onContract(value: unknown): void;
  /** The plan's cast table (each table once, before its first call). */
  onCast(rows: readonly CastRow[]): void;
  onCall(seq: number, call: Authored): void;
  onReview(seq: number, question: string): void;
  onPhase(name: string, edge: 'open' | 'close'): void;
  /** The plan has nothing to do but wait on these seqs. Sent again whenever that changes. */
  onWaiting(seqs: readonly number[]): void;
  /** Exactly once, after the child has exited. */
  onEnd(end: PlanEnd): void;
};
export type RunPlanOptions = { readonly file: string } & PlanEvents;

export interface PlanHandle {
  readonly pid: number;
  /** Answer an outstanding call. After the run has ended this is a no-op: the process is gone. */
  answer(seq: number, outcome: keyed.Outcome): void;
  /** The leader chose `continue` at an outstanding review. A no-op after the end, like `answer`. */
  reviewed(seq: number): void;
  /** Kill the child and wait until it has exited. Resolves at once if it already has. */
  kill(): Promise<void>;
  /** The end, once the child has exited (the value `onEnd` received). */
  readonly ended: Promise<PlanEnd>;
}

type Outstanding = 'call' | 'review';

/** Sandbox: Node's permission model. The child may read its plan file, the library and the
 * library's dependencies, and nothing else; it may not write, spawn or load addons. tsx needs two
 * allowances: worker threads (its loader hooks run in one; workers inherit these permissions) and
 * its transform cache off (it writes to the temp dir). Node walks up from each module looking for
 * package.json; those exact ancestor files are readable so the walk ends normally instead of
 * throwing ERR_ACCESS_DENIED. tsx uses the library's explicit config; no owner tsconfig is read.
 * Node 24 has no network permission (`--allow-net` arrives in Node 25): sockets are NOT blocked. */
function sandboxFlags(file: string): string[] {
  const kernel = realpathSync(__dirname);
  const server = path.resolve(kernel, '..', '..');
  const store = pnpmStore(realpathSync(TSX_LOADER));
  // The wire schemas (protocol.ts) are built from the canonical types in @unleashd/shared, so the
  // child loads that package's build. Its link resolves outside server/node_modules.
  const shared = realpathSync(path.join(server, 'node_modules', '@unleashd', 'shared'));
  const readable = [
    path.dirname(file),
    invertCase(path.dirname(file)),
    kernel,
    realpathSync(path.resolve(kernel, '../../../vendor/agent-cli-tool/dist')),
    invertCase(kernel),
    path.join(server, 'node_modules'),
    store,
    path.join(shared, 'dist'),
    path.join(shared, 'node_modules'),
    ...ancestorPackages(path.dirname(file)),
    ...ancestorPackages(kernel),
    ...ancestorPackages(path.join(shared, 'dist')),
  ];
  return [
    '--permission',
    '--allow-worker',
    ...[...new Set(readable)].map((p) => `--allow-fs-read=${p}`),
    '--disable-warning=SecurityWarning',
  ];
}
function ancestorPackages(dir: string): string[] {
  const parent = path.dirname(dir);
  if (parent === dir) return [];
  return [path.join(parent, 'package.json'), ...ancestorPackages(parent)];
}
function invertCase(text: string): string {
  return [...text].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join('');
}
/** The pnpm store holding tsx, zod and their dependencies (they link to each other inside it). */
function pnpmStore(file: string): string {
  const parts = file.split(path.sep);
  const at = parts.lastIndexOf('.pnpm');
  if (at < 0)
    throw new Error(
      `tsx is not installed in a pnpm store (${file}); the plan sandbox cannot be scoped.`
    );
  return parts.slice(0, at + 1).join(path.sep);
}

export function runPlan(opts: RunPlanOptions): PlanHandle {
  // tsx probes directory case sensitivity. Give it a private directory containing ONLY the
  // source, never the owner's adjacent files. Guard: expedition-kernel-runner sandbox test.
  const sandbox = realpathSync(mkdtempSync(path.join(tmpdir(), 'expedition-process-')));
  const file = path.join(sandbox, 'plan.expedition.ts');
  copyFileSync(realpathSync(opts.file), file);
  const child: ChildProcess = spawn(
    process.execPath,
    [
      ...sandboxFlags(file),
      '--import',
      pathToFileURL(TSX_LOADER).href,
      CHILD,
      file,
      AUTHORING_ENTRY,
      opts.file, // Keep the durable source path in process listings for operational inspection.
    ],
    {
      cwd: path.dirname(file),
      // No inherited environment: a plan needs none, and the host's may hold secrets.
      env: {
        TSX_DISABLE_CACHE: '1',
        TSX_TSCONFIG_PATH: path.join(__dirname, 'plan-tsconfig.json'),
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      // Its own process group, so kill() takes anything it started with it.
      detached: true,
      serialization: 'json',
    }
  );
  const pid = child.pid;
  if (pid === undefined) throw new Error(`Could not start the plan process for ${file}.`);

  const outstanding = new Map<number, Outstanding>();
  let decided: PlanEnd | 'running' = 'running';
  let stderr = '';
  let exited = false;
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL);
  });

  const killGroup = (): void => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // ESRCH: the group is already gone.
    }
  };
  const decide = (end: PlanEnd): void => {
    if (decided !== 'running') return;
    decided = end;
    if (!exited)
      setTimeout(labelled('timer expedition-plan-exit-grace', killGroup), EXIT_GRACE_MS).unref();
  };

  const handlers: { [T in FromPlan['t']]: (message: Extract<FromPlan, { t: T }>) => void } = {
    contract: (m) => opts.onContract(m.value),
    cast: (m) => opts.onCast(m.rows),
    call: (m) => {
      outstanding.set(m.seq, 'call');
      opts.onCall(m.seq, m.call);
    },
    review: (m) => {
      outstanding.set(m.seq, 'review');
      opts.onReview(m.seq, m.question);
    },
    phase: (m) => opts.onPhase(m.name, m.edge),
    waiting: (m) => opts.onWaiting(m.on),
    candidate: (m) => decide({ t: 'candidate', ref: m.ref }),
    gap: (m) => decide({ t: 'gap', why: m.why, evidence: m.evidence }),
    threw: (m) => decide({ t: 'threw', message: m.message }),
  };
  let receivedContract = false;
  child.on('message', (raw: unknown) => {
    if (decided !== 'running') return;
    const parsed = FromPlan.safeParse(raw);
    if (!parsed.success) {
      decide({ t: 'threw', message: `Unparseable message from the plan: ${parsed.error.message}` });
      killGroup();
      return;
    }
    const message = parsed.data;
    // Guard: expedition-kernel-runner. No plan work can precede or replace its owner contract.
    if (message.t === 'contract') {
      if (receivedContract) {
        decide({ t: 'threw', message: 'Duplicate plan contract.' });
        killGroup();
        return;
      }
      receivedContract = true;
    } else if (!receivedContract && message.t !== 'threw') {
      decide({ t: 'threw', message: 'The contract must be the first plan message.' });
      killGroup();
      return;
    }
    try {
      (handlers[message.t] as (m: FromPlan) => void)(message);
    } catch (error) {
      decide({ t: 'threw', message: (error as Error).message });
      killGroup();
    }
  });

  const ended = new Promise<PlanEnd>((resolve) => {
    child.on('close', (code, signal) => {
      exited = true;
      // Anything it left in its group goes with it.
      killGroup();
      const end: PlanEnd =
        decided !== 'running'
          ? decided
          : {
              t: 'crashed',
              exit: signal ? { t: 'signal', signal } : { t: 'code', code: code ?? -1 },
              stderr,
            };
      rmSync(sandbox, { recursive: true, force: true });
      opts.onEnd(end);
      resolve(end);
    });
  });

  const reply = (seq: number, kind: Outstanding, message: ToPlan): void => {
    if (exited || !child.connected) return;
    const waiting = outstanding.get(seq);
    if (waiting !== kind)
      throw new Error(`Seq ${seq} is not an outstanding ${kind} (it is ${waiting ?? 'unknown'}).`);
    outstanding.delete(seq);
    child.send(message);
  };

  return {
    pid,
    answer: (seq, outcome) => reply(seq, 'call', { t: 'outcome', seq, outcome }),
    reviewed: (seq) => reply(seq, 'review', { t: 'reviewed', seq }),
    kill: async () => {
      if (!exited) {
        decide({ t: 'killed' });
        killGroup();
      }
      await ended;
      await groupGone(pid);
    },
    ended,
  };
}

// ---- dry run ----
export type DryRunEnd =
  | { readonly t: 'candidate'; readonly ref: keyed.RefId }
  | { readonly t: 'gap'; readonly why: string; readonly evidence: readonly keyed.Input[] }
  | { readonly t: 'threw'; readonly message: string }
  /** It stopped at calls or reviews the host has no answer for. Empty lists: it awaits something
   * that is not the host's (a promise that never settles). */
  | {
      readonly t: 'waiting';
      readonly calls: readonly keyed.Key[];
      readonly reviews: readonly string[];
    }
  | { readonly t: 'crashed'; readonly exit: Exit; readonly stderr: string };

export type DryRunResult = {
  /** The owner literal, before canonical validation. */
  readonly contract: unknown;
  /** Every step of the plan's cast table, called or not. */
  readonly cast: readonly CastRow[];
  /** Every call the plan authored, in the order it authored them. */
  readonly calls: readonly Authored[];
  readonly reviews: readonly string[];
  readonly phases: readonly { readonly name: string; readonly edge: 'open' | 'close' }[];
  readonly end: DryRunEnd;
};

export type DryRunOptions = {
  readonly file: string;
  /** The logged outcome for this call, or `undefined`: never answered in this run. */
  known(call: Authored): keyed.Outcome | undefined;
  /** `true`: the leader continues at this review; `false`: never answered in this run. */
  reviewed(question: string): boolean;
};

type Declined =
  | { readonly t: 'call'; readonly key: keyed.Key }
  | { readonly t: 'review'; readonly question: string };

/** Run the plan answering only what the host already knows; stop when it ends or waits on
 * nothing but unanswered seqs. */
export async function dryRun(opts: DryRunOptions): Promise<DryRunResult> {
  let contract: unknown;
  const cast: CastRow[] = [];
  const calls: Authored[] = [];
  const reviews: string[] = [];
  const phases: { name: string; edge: 'open' | 'close' }[] = [];
  const declined = new Map<number, Declined>();
  let stop: (end: DryRunEnd) => void = () => {};
  const quiet = new Promise<DryRunEnd>((resolve) => {
    stop = resolve;
  });

  const handle = runPlan({
    file: opts.file,
    onContract: (value) => {
      contract = value;
    },
    onCast: (rows) => cast.push(...rows),
    onCall: (seq, call) => {
      calls.push(call);
      const outcome = opts.known(call);
      if (outcome) handle.answer(seq, outcome);
      else declined.set(seq, { t: 'call', key: call.key });
    },
    onReview: (seq, question) => {
      reviews.push(question);
      if (opts.reviewed(question)) handle.reviewed(seq);
      else declined.set(seq, { t: 'review', question });
    },
    onPhase: (name, edge) => phases.push({ name, edge }),
    // A seq the host has answered may still be listed (the answer was in flight); the child then
    // reports `waiting` again once it has read the answer. Stop only when every one is declined.
    onWaiting: (seqs) => {
      const pending = seqs.map((seq) => declined.get(seq));
      if (pending.some((p) => p === undefined)) return;
      const held = pending as Declined[];
      stop({
        t: 'waiting',
        calls: held.flatMap((p) => (p.t === 'call' ? [p.key] : [])),
        reviews: held.flatMap((p) => (p.t === 'review' ? [p.question] : [])),
      });
    },
    onEnd: () => {},
  });

  const end = await Promise.race([quiet, handle.ended.then(dryEndOf)]);
  await handle.kill();
  return { contract, cast, calls, reviews, phases, end };
}

function dryEndOf(end: PlanEnd): DryRunEnd {
  switch (end.t) {
    case 'candidate':
    case 'gap':
    case 'threw':
    case 'crashed':
      return end;
    case 'killed':
      // dryRun kills only after it has its answer, so this race is never won by a kill.
      throw new Error('The dry run was killed before it settled.');
  }
}
