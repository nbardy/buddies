import { keyed } from '@unleashd/shared';
import { renderBrief, renderCommand } from './brief';
import type { Authored } from './protocol';

// Authored -> Call: the host's canonicalisation (DESIGN.md §4). One handler per variant behind a
// thin table; each handler renders text, adds the provider's pool and hands the result to Call.

export type ProviderOf = (
  who: keyed.Who
) => { t: 'known'; provider: string } | { t: 'unknown'; why: string };
export type CanonCtx = { contract: keyed.Contract; folder: string; providerOf: ProviderOf };
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

type RenderedJudge = { t: 'ok'; judge: keyed.CallJudge } | { t: 'invalid'; issues: string[] };
type Item = Readonly<Record<string, unknown>>;
/** A check judge's command carries the same `{{slots}}` as the step's; a review's rubric is
 * rendered like a brief, so the call's hash covers the rubric's words. */
const JUDGE: {
  [K in keyed.Judge['t']]: (
    j: Extract<keyed.Judge, { t: K }>,
    item: Item,
    ctx: CanonCtx
  ) => RenderedJudge;
} = {
  none: () => ({ t: 'ok', judge: { t: 'none' } }),
  check: (j, item) => {
    const r = renderCommand(j.command, item);
    return r.t === 'ok'
      ? { t: 'ok', judge: { t: 'check', command: r.text } }
      : { t: 'invalid', issues: r.issues.map((i) => `judge ${i}`) };
  },
  review: (j, item, ctx) => {
    const r = renderBrief(ctx.folder, j.rubric, item, ctx.contract.rules);
    return r.t === 'ok'
      ? { t: 'ok', judge: { t: 'review', rubric: j.rubric, by: j.by, brief: r.text } }
      : { t: 'invalid', issues: r.issues.map((i) => `rubric ${i}`) };
  },
};
const renderJudge = (judge: keyed.Judge, item: Item, ctx: CanonCtx): RenderedJudge =>
  JUDGE[judge.t](judge as never, item, ctx);

const agent: Handler<'agent'> = (a, ctx) => {
  const issues: string[] = [];
  const brief = renderBrief(ctx.folder, a.step, a.item, ctx.contract.rules);
  if (brief.t === 'invalid') issues.push(...brief.issues);
  const provider = providerFor(a.by, ctx.providerOf);
  if (provider.t === 'unknown')
    issues.push(`cannot tell which provider runs ${JSON.stringify(a.by)}: ${provider.why}`);
  const judge = renderJudge(a.judge, a.item, ctx);
  if (judge.t === 'invalid') issues.push(...judge.issues);
  if (issues.length > 0 || brief.t !== 'ok' || provider.t !== 'known' || judge.t !== 'ok')
    return invalid(issues);
  return finish({
    t: 'agent',
    key: a.key,
    by: a.by,
    brief: brief.text,
    inputs: a.inputs,
    output: a.output,
    tree: a.tree,
    base: a.base,
    grant: a.grant,
    context: a.context,
    pools: unique([provider.provider, ...a.needs]),
    max: a.max,
    judge: judge.judge,
  });
};

const command: Handler<'command'> = (a, _ctx) => {
  const cmd = renderCommand(a.command, a.item);
  if (cmd.t === 'invalid') return invalid(cmd.issues);
  return finish({
    t: 'command',
    key: a.key,
    command: cmd.text,
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
