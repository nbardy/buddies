import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExpeditionProposal, ExpeditionResult } from '@unleashd/shared';
import { z } from 'zod';
import type { Call } from './author';
import { AUTHOR, runPlan } from './child';

const cap = z
  .object({ usd: z.number().positive(), minutes: z.number().positive().max(35791) })
  .strict();
export const Contract = z
  .object({
    goal: z.string().min(1),
    leader: z.string().regex(/^buddy:.+/),
    repo: z.string().min(1),
    budget: z.object({ usd: z.number().positive(), hours: z.number().positive() }).strict(),
    rules: z.array(z.string()),
    done: z.array(
      z.union([
        z.object({ check: z.string().min(1) }).strict(),
        z.object({ review: z.string(), by: z.string() }).strict(),
        z.object({ owner: z.string() }).strict(),
      ])
    ),
    pools: z.record(z.number().int().positive()).default({ claude: 1, codex: 1 }),
    autoApply: z.object({ usd: z.number().nonnegative() }).default({ usd: 0 }),
    call: cap.partial().default({ usd: 1, minutes: 20 }),
    leaderWake: cap.optional(),
    doneReview: cap.optional(),
  })
  .strict();
export type Contract = z.infer<typeof Contract>;
export const defaultCap = (c: Contract) => ({
  usd: Math.min(c.budget.usd, Math.min(1, Math.max(0.25, c.budget.usd * 0.1))),
  minutes: Math.min(c.budget.hours * 60, Math.min(20, Math.max(5, c.budget.hours * 6))),
});
export async function gates(
  file: string,
  known: (c: Call) => ExpeditionResult | undefined = () => undefined
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expedition-types-'));
  const config = path.join(dir, 'tsconfig.json');
  fs.writeFileSync(
    config,
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: 'ES2022',
        module: 'commonjs',
        moduleResolution: 'bundler',
        skipLibCheck: true,
        types: ['node'],
        typeRoots: [path.resolve(__dirname, '../../node_modules/@types')],
        paths: {
          expedition: [AUTHOR],
          zod: [path.join(path.dirname(require.resolve('zod/package.json')), 'index.d.ts')],
        },
      },
      files: [file],
    })
  );
  try {
    await new Promise<void>((resolve, reject) =>
      execFile(
        path.resolve(__dirname, '../../node_modules/.bin/tsc'),
        ['-p', config, '--pretty', 'false'],
        { timeout: 120_000 },
        (e, out, err) => (e ? reject(new Error(out + err)) : resolve())
      )
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  let contract: Contract | undefined;
  const calls: Call[] = [],
    defaults: string[] = [];
  await new Promise<void>((resolve, reject) => {
    const child = runPlan(file, (m, reply) => {
      try {
        switch (m.t) {
          case 'contract':
            contract = Contract.parse(m.contract);
            defaults.push(...m.defaults);
            break;
          case 'call': {
            const result = known(m.call);
            if (result) reply(result);
            else calls.push(m.call);
            break;
          }
          case 'waiting':
            if (calls.length) {
              void child.kill().then(resolve);
            }
            break;
          case 'end':
            resolve();
            break;
          case 'error':
            reject(new Error(m.why));
            break;
        }
      } catch (e) {
        void child.kill();
        reject(e);
      }
    });
  });
  if (!contract) throw new Error('The plan supplied no contract');
  const preview: ExpeditionProposal['preview'] = {
    ...contract,
    costUsd: calls.reduce((sum, c) => sum + c.usd, 0),
    firstWave: calls.map((c) => ({ key: c.key, who: c.t === 'agent' ? c.by : c.t, usd: c.usd })),
    defaults: [
      ...defaults,
      `pools = ${JSON.stringify(contract.pools)}`,
      `autoApply = $${contract.autoApply.usd}`,
      `leaderWake = ${JSON.stringify(contract.leaderWake ?? defaultCap(contract))}`,
      `doneReview = ${JSON.stringify(contract.doneReview ?? defaultCap(contract))}`,
    ],
  };
  return { contract, preview, calls };
}
