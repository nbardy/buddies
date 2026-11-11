import { parseModelString } from '@nbardy/agent-cli';
import type { keyed } from '@unleashd/shared';
import { z } from 'zod';

export const Agent = z.union([
  z.string().min(1),
  z
    .object({
      use: z.string().min(1),
      usd: z.number().positive().optional(),
      minutes: z.number().positive().optional(),
    })
    .strict(),
]);
export type Agent = z.infer<typeof Agent>;
export type Agents = Record<string, Agent>;
export type WhoName<A> = (keyof A & string) | `${string}:${string}`;

/** Pattern: parse-dont-validate (docs/patterns.md#parse-dont-validate) */
export function specOf(name: string, agents: Agents, at: string): string {
  if (name.includes(':')) return name;
  const agent = Object.hasOwn(agents, name) ? agents[name] : undefined;
  if (agent === undefined) throw new TypeError(`${at}: unknown agent name "${name}".`);
  return typeof agent === 'string' ? agent : agent.use;
}
const BUDDY = 'buddy:';
export function whoOf(spec: string, at: string): keyed.Who {
  // A Buddy is this server's kind of worker, so its prefix is read here; agent-cli's parser
  // knows harnesses and models only.
  if (spec.startsWith(BUDDY)) {
    const id = spec.slice(BUDDY.length);
    if (!id) throw new TypeError(`${at}: Expected buddy:<id>. (${spec})`);
    return { t: 'buddy', id };
  }
  const parsed = parseModelString(spec);
  switch (parsed.t) {
    case 'invalid':
      throw new TypeError(`${at}: ${parsed.why} (${spec})`);
    case 'seat':
      // A non-reasoning model has no effort to send. Empty means absent at the executor boundary,
      // never an invented provider value. Guard: expedition-kernel-authoring model-string cases.
      return {
        t: 'seat',
        provider: parsed.provider,
        model: parsed.model,
        effort: parsed.effort.t === 'none' ? '' : parsed.effort.value,
      };
  }
}
