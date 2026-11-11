import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ContractInput } from '../../src/expedition-kernel/contract';

/** Test builders emit exactly the file the production gates consume. */
export function planSource(
  contract: ContractInput,
  source: string,
  prompts: Record<string, string> = {}
): string {
  return `const CONTRACT: import('expedition').ContractInput = ${JSON.stringify(contract)};\nconst PROMPTS = ${JSON.stringify(prompts)};\n${source}`;
}
export function writePlan(
  file: string,
  contract: ContractInput,
  source: string,
  prompts: Record<string, string> = {}
): string {
  writeFileSync(file, planSource(contract, source, prompts));
  return file;
}
/** A scripted leader preserves the owner literal and replaces just the plan code. */
export function rewriteSource(
  expDir: string,
  source: string,
  prompts: Record<string, string> = {}
): string {
  const current = readFileSync(path.join(expDir, 'plans/v0.expedition.ts'), 'utf8');
  const lines = current.split('\n');
  const contract = JSON.parse(
    lines[0]!.slice("const CONTRACT: import('expedition').ContractInput = ".length, -1)
  ) as ContractInput;
  const original = JSON.parse(lines[1]!.slice('const PROMPTS = '.length, -1)) as Record<
    string,
    string
  >;
  return planSource(contract, source, { ...original, ...prompts });
}
