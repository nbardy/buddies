import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { briefPath, missingBriefIssue } from './brief';
import { type ProviderOf, canonicalise, providerFor } from './canonical';
import type { Authored } from './protocol';
import type { Contract } from './types';

// The first two rewrite gates (DESIGN.md §5): the plan typechecks against the authoring API, and
// the calls a dry run collected are consistent with the contract and the folder.

export type TypecheckResult = { t: 'ok' } | { t: 'failed'; errors: string[] };
export type StaticResult = { t: 'ok' } | { t: 'failed'; issues: string[] };

export const TSC_TIMEOUT_MS = 120_000;

export async function typecheckGate(
  folder: string,
  opts: { authoringEntry: string; zodEntry: string; tscBin: string }
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
          moduleResolution: 'node',
          lib: ['ES2022'],
          skipLibCheck: true,
          noUncheckedIndexedAccess: true,
          paths: { expedition: [opts.authoringEntry], zod: [opts.zodEntry] },
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
        // tsc exits 2 with diagnostics on stdout; anything else (ENOENT, signal) has none.
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

export function staticGate(input: {
  contract: Contract;
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
  }

  for (const c of contract.done) {
    if (c.t === 'review' && !hasBrief(c.rubric))
      issues.push(`contract done: rubric ${missingBriefIssue(c.rubric)}`);
  }
  const unique = [...new Set(issues)];
  return unique.length === 0 ? { t: 'ok' } : { t: 'failed', issues: unique };
}
