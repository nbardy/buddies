import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { keyed } from '@unleashd/shared';
import { type CallTurn, grantsOf } from './access';
import { parseCommand } from './argv';
import { briefPath, missingBriefIssue } from './brief';
import { type ProviderOf, canonicalise, providerFor } from './canonical';
import type { Authored } from './protocol';
import { AUTHORING_ENTRY } from './runner';

// The first two rewrite gates (DESIGN.md §5): the plan typechecks against the authoring API, and
// the calls a dry run collected are consistent with the contract and the folder.

/** The server's @types: the authoring library itself runs on Node (its session talks IPC), so the
 * plan is checked with the library's own source and the Node types that source needs. */
const NODE_TYPES = path.resolve(__dirname, '..', '..', 'node_modules', '@types');

export type TypecheckResult = { t: 'ok' } | { t: 'failed'; errors: string[] };
/** `access`: per turn the calls (and the contract's leader and done reviews) would run, which of
 * its limits its harness enforces and which are only advisory (`turnAccessOf`). */
export type StaticResult =
  | { t: 'ok'; access: keyed.TurnAccess[] }
  | { t: 'failed'; issues: string[] };

export const TSC_TIMEOUT_MS = 120_000;

export async function typecheckGate(
  folder: string,
  opts: { zodEntry: string; tscBin: string }
): Promise<TypecheckResult> {
  // The generated tsconfig lives in a temp dir: the plan folder is the leader's, never written here.
  const dir = await mkdtemp(path.join(tmpdir(), 'expedition-typecheck-'));
  try {
    const config = path.join(dir, 'tsconfig.json');
    await writeFile(
      config,
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          target: 'ES2022',
          module: 'commonjs',
          // TypeScript 7 removed `node` (node10, error TS5108); bundler keeps CommonJS output and
          // reads package exports.
          moduleResolution: 'bundler',
          lib: ['ES2022'],
          skipLibCheck: true,
          noUncheckedIndexedAccess: true,
          typeRoots: [NODE_TYPES],
          types: ['node'],
          paths: { expedition: [AUTHORING_ENTRY], zod: [opts.zodEntry] },
        },
        files: [path.join(folder, 'plan.ts')],
      })
    );
    const out = await runTsc(opts.tscBin, config);
    return out.t === 'ok'
      ? out
      : { t: 'failed', errors: out.errors.map((e) => e.split(dir).join(folder)) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runTsc(tscBin: string, config: string): Promise<TypecheckResult> {
  return new Promise((resolve) => {
    execFile(
      tscBin,
      ['-p', config, '--pretty', 'false'],
      { timeout: TSC_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err === null) return resolve({ t: 'ok' });
        if (err.killed)
          return resolve({ t: 'failed', errors: [`tsc timed out after ${TSC_TIMEOUT_MS} ms`] });
        // tsc exits non-zero (5.x: 2, 7.0: 1) with diagnostics on stdout; ENOENT or a signal has none.
        const lines = `${stdout}${stderr}`
          .split(/\r?\n(?=\S)/)
          .map((l) => l.trim())
          .filter((l) => l !== '');
        resolve({
          t: 'failed',
          errors: lines.length > 0 ? lines : [`tsc failed to run: ${err.message}`],
        });
      }
    );
  });
}

/** Every command line a call will have the host run, rendered (slots filled). */
const COMMANDS_OF: {
  [K in keyed.Call['t']]: (c: Extract<keyed.Call, { t: K }>) => readonly string[];
} = {
  agent: (c) => (c.judge.t === 'check' ? [c.judge.command] : []),
  command: (c) => [c.command],
  ask: () => [],
  verdict: (c) => (c.verdict.t === 'check' ? [c.verdict.command] : []),
  leader: () => [],
};
/** Commands run without a shell (argv.ts): `a && b`, a pipe or a glob would not mean what its
 * author read, so the plan is refused here, naming the string, rather than failing at run time. */
const unrunnable =
  (where: string) =>
  (command: string): string[] => {
    const parsed = parseCommand(command);
    return parsed.t === 'refused' ? [`${where}: ${parsed.why}`] : [];
  };

export function staticGate(input: {
  contract: keyed.Contract;
  folder: string;
  calls: readonly Authored[];
  providerOf: ProviderOf;
}): StaticResult {
  const { contract, folder, calls, providerOf } = input;
  const issues: string[] = [];
  const hasBrief = (name: string) => {
    const located = briefPath(folder, name);
    return located.t === 'ok' && existsSync(located.file);
  };

  const seen = new Set<string>();
  const canonical: keyed.Call[] = [];
  for (const call of calls) {
    if (seen.has(call.key)) issues.push(`${call.key}: key appears more than once`);
    seen.add(call.key);

    if (call.t === 'ask') continue;
    const pools = [...call.needs];
    if (call.t === 'agent') {
      if (!hasBrief(call.step)) issues.push(`${call.key}: ${missingBriefIssue(call.step)}`);
      const producer = providerFor(call.by, providerOf);
      if (producer.t === 'known') pools.unshift(producer.provider);
      if (call.judge.t === 'review') {
        const rubric = call.judge.rubric;
        if (!hasBrief(rubric)) issues.push(`${call.key}: rubric ${missingBriefIssue(rubric)}`);
        const reviewer = providerFor(call.judge.by, providerOf);
        if (producer.t === 'unknown')
          issues.push(
            `${call.key}: producer provider unknown (${producer.why}); cannot check the reviewer is independent`
          );
        else if (reviewer.t === 'unknown')
          issues.push(`${call.key}: reviewer provider unknown (${reviewer.why})`);
        else if (reviewer.provider === producer.provider) {
          issues.push(`${call.key}: reviewer is on the producer's provider (${producer.provider})`);
        }
      }
    }
    for (const pool of pools) {
      if (!Object.hasOwn(contract.pools, pool))
        issues.push(`${call.key}: pool '${pool}' is not in the contract's pools`);
    }
    const canon = canonicalise(call, { contract, folder, providerOf });
    if (canon.t === 'invalid') issues.push(...canon.issues.map((i) => `${call.key}: ${i}`));
    else {
      canonical.push(canon.call);
      issues.push(...COMMANDS_OF[canon.call.t](canon.call as never).flatMap(unrunnable(call.key)));
    }
  }

  for (const c of contract.done) {
    if (c.t === 'review' && !hasBrief(c.rubric))
      issues.push(`contract done: rubric ${missingBriefIssue(c.rubric)}`);
    if (c.t === 'check') issues.push(...unrunnable('contract done')(c.command));
  }
  const unique = [...new Set(issues)];
  return unique.length === 0
    ? { t: 'ok', access: turnAccessOf(contract, canonical, providerOf) }
    : { t: 'failed', issues: unique };
}

// ---- what each turn may do, on its harness (expedition-kernel/access.ts) ----

/** Placeholder paths: what a harness enforces depends on a set's shape, never its paths. */
const AT = {
  work: '<run>/work',
  tree: '<run>/tree',
  refs: '<expedition>/refs',
  exp: '<expedition>',
  git: '<repo>/.git/worktrees/<tree>',
};
const AGENT_TURN: {
  readonly [K in keyed.AgentCall['tree']]: (c: keyed.AgentCall) => CallTurn;
} = {
  none: (c) => ({ t: 'call', work: AT.work, reads: [AT.refs, ...c.grant.reads], web: c.grant.web }),
  checkout: (c) => ({
    t: 'checkout',
    tree: AT.tree,
    reads: [AT.refs, ...c.grant.reads],
    web: c.grant.web,
    git: { t: 'worktree', dirs: [AT.git] },
  }),
};
const JUDGE_TURN: CallTurn = { t: 'judge', reads: [AT.refs] };
const LEADER_TURN: CallTurn = { t: 'leader', expDir: AT.exp, draft: `${AT.exp}/drafts/1` };

const accessRow = (
  label: string,
  turn: CallTurn,
  who: keyed.Who,
  providerOf: ProviderOf
): keyed.TurnAccess => {
  const p = providerFor(who, providerOf);
  return { label, turn: turn.t, harness: (HARNESS_OF[p.t] as HarnessOf)(p, turn) };
};
type Provided = ReturnType<typeof providerFor>;
type HarnessOf = (p: Provided, turn: CallTurn) => keyed.TurnAccess['harness'];
const HARNESS_OF: {
  readonly [K in Provided['t']]: (
    p: Extract<Provided, { t: K }>,
    turn: CallTurn
  ) => keyed.TurnAccess['harness'];
} = {
  known: (p, turn) => ({ t: 'known', provider: p.provider, grants: grantsOf(p.provider, turn) }),
  unknown: (p) => ({ t: 'unknown', why: p.why }),
};
/** A judge row for a review; a check is a host command, not a turn, and `none` judges nothing. */
const JUDGE_ROW: {
  readonly [K in keyed.CallJudge['t']]: (
    j: Extract<keyed.CallJudge, { t: K }>,
    label: string,
    providerOf: ProviderOf
  ) => keyed.TurnAccess[];
} = {
  none: () => [],
  check: () => [],
  review: (j, label, providerOf) => [accessRow(label, JUDGE_TURN, j.by, providerOf)],
};
const reviewRow = (
  label: string,
  judge: keyed.CallJudge | keyed.Verdict,
  providerOf: ProviderOf
): keyed.TurnAccess[] =>
  (JUDGE_ROW[judge.t] as (j: keyed.CallJudge, l: string, p: ProviderOf) => keyed.TurnAccess[])(
    judge,
    label,
    providerOf
  );
/** A done criterion's turn: a review is one (by its seat); a check and the owner's are not. */
const CRITERION_ROW: {
  readonly [K in keyed.Criterion['t']]: (
    c: Extract<keyed.Criterion, { t: K }>,
    label: string,
    providerOf: ProviderOf
  ) => keyed.TurnAccess[];
} = {
  check: () => [],
  owner: () => [],
  review: (c, label, providerOf) => [accessRow(label, JUDGE_TURN, c.by, providerOf)],
};
const ROWS: {
  readonly [K in keyed.Call['t']]: (
    c: Extract<keyed.Call, { t: K }>,
    providerOf: ProviderOf
  ) => keyed.TurnAccess[];
} = {
  agent: (c, providerOf) => [
    accessRow(c.key, AGENT_TURN[c.tree](c), c.by, providerOf),
    ...reviewRow(c.key, c.judge, providerOf),
  ],
  verdict: (c, providerOf) => reviewRow(c.key, c.verdict, providerOf),
  command: () => [],
  ask: () => [],
  leader: () => [],
};

/**
 * Per turn: the calls' producers and review judges, then the contract's leader (its wakes) and
 * its done reviews, each with the grants its harness enforces and the ones it can only state.
 */
export function turnAccessOf(
  contract: keyed.Contract,
  calls: readonly keyed.Call[],
  providerOf: ProviderOf
): keyed.TurnAccess[] {
  return [
    ...calls.flatMap((c) =>
      (ROWS[c.t] as (c: keyed.Call, p: ProviderOf) => keyed.TurnAccess[])(c, providerOf)
    ),
    accessRow('leader', LEADER_TURN, { t: 'buddy', id: contract.leader }, providerOf),
    ...contract.done.flatMap((d, i) =>
      (CRITERION_ROW[d.t] as (c: keyed.Criterion, l: string, p: ProviderOf) => keyed.TurnAccess[])(
        d,
        `done/${i}`,
        providerOf
      )
    ),
  ];
}
