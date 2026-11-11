import { keyed } from '@unleashd/shared';
import type { Authored } from './protocol';

// Authored -> Call: the host's canonicalisation (DESIGN.md §4). One handler per variant behind a
// thin table; each handler renders text, adds the provider's pool and hands the result to Call.

export type ProviderOf = (
  who: keyed.Who
) => { t: 'known'; provider: string } | { t: 'unknown'; why: string };
export type CanonCtx = { contract: keyed.Contract; providerOf: ProviderOf };
export type Canonical = { t: 'ok'; call: keyed.Call } | { t: 'invalid'; issues: string[] };

type Provider = { t: 'known'; provider: string } | { t: 'unknown'; why: string };
/** A seat names its provider; only a Buddy needs the lookup. */
export const providerFor = (who: keyed.Who, providerOf: ProviderOf): Provider =>
  who.t === 'seat' ? { t: 'known', provider: who.provider } : providerOf(who);

type Handler<K extends Authored['t']> = (
  a: Extract<Authored, { t: K }>,
  ctx: CanonCtx
) => Canonical;

const invalid = (issues: string[]): Canonical => ({ t: 'invalid', issues });
const unique = (xs: readonly string[]): string[] => [...new Set(xs)];

function finish(raw: unknown): Canonical {
  const parsed = keyed.Call.safeParse(raw);
  return parsed.success
    ? { t: 'ok', call: parsed.data }
    : invalid(parsed.error.issues.map((i) => `${i.path.join('.') || 'call'}: ${i.message}`));
}

/** Rules are appended once at the host boundary; the hash covers all rendered text. */
export const withRules = (text: string, rules: readonly string[]): string =>
  `${text.trimEnd()}\n\n---\n\n## Rules from the contract\n\n${rules.map((r) => `- ${r}`).join('\n')}\n`;
function canonicalJudge(j: keyed.Judge, ctx: CanonCtx): keyed.CallJudge {
  return j.t === 'review' ? { ...j, brief: withRules(j.rubric, ctx.contract.rules) } : j;
}

const agent: Handler<'agent'> = (a, ctx) => {
  const issues: string[] = [];

  const provider = providerFor(a.by, ctx.providerOf);
  if (provider.t === 'unknown')
    issues.push(`cannot tell which provider runs ${JSON.stringify(a.by)}: ${provider.why}`);
  const judge = canonicalJudge(a.judge, ctx);
  if (issues.length > 0 || provider.t !== 'known') return invalid(issues);
  return finish({
    t: 'agent',
    key: a.key,
    by: a.by,
    brief: withRules(a.brief, ctx.contract.rules),
    inputs: a.inputs,
    output: a.output,
    tree: a.tree,
    base: a.base,
    grant: a.grant,
    context: a.context,
    pools: unique([provider.provider, ...a.needs]),
    max: a.max,
    judge,
  });
};

const command: Handler<'command'> = (a, _ctx) => {
  return finish({
    t: 'command',
    key: a.key,
    command: a.command,
    on: a.on,
    output: a.output,
    pools: unique(a.needs),
    maxMinutes: a.maxMinutes,
  });
};

const ask: Handler<'ask'> = (a) => finish(a);

const handlers: { [K in Authored['t']]: Handler<K> } = { agent, command, ask };

export function canonicalise(authored: Authored, ctx: CanonCtx): Canonical {
  const h = handlers[authored.t] as Handler<typeof authored.t>;
  return h(authored as never, ctx);
}
