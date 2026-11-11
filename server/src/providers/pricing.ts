import type { UsageGroup } from '@unleashd/ingest';
import type { Provider as ProviderName } from '@unleashd/shared';

// What provider-counted tokens cost, in one place: the usage panel (http/usage-routes.ts) and an
// expedition call's charge (expeditions-v1/executor/usage.ts) both read it.
//
// Two different questions, two functions:
// - `estimateUsd`: the usage panel's ESTIMATE, one approximate row per provider. Unchanged from
//   what /api/usage always showed (every Claude model at the Sonnet-class rate, so Opus and Fable
//   are under-counted there). It answers "roughly how much", never a budget.
// - `priceUsd`: a PRICE an expedition budget may trust. A provider-recorded cost (OpenCode), or a
//   model whose list rates are known. Anything else is `unpriced`, said as such, and the caller
//   reports the call `unreported` (the kernel then charges its whole reservation, D5). Never a
//   provider-wide guess: an Opus call charged at a Sonnet rate would let a budget overrun.
//
// The provider catalog (vendor/agent-cli-tool/catalog.jsonc) carries no prices, so the per-model
// table is here. Claude rates: Anthropic's first-party list prices (claude-api skill table, cached
// 2026-11-03), input/output per 1M tokens; cache read where the table states it, otherwise 0.1x
// input; cache write (5-minute) 1.25x input. Haiku 5.5 is at its <=100K-prompt tier (longer prompts
// bill 5x and are under-counted).
// Codex rates: OpenAI's published API pricing, https://developers.openai.com/api/docs/pricing
// (fetched 2026-11-11), Standard tier, short context (<=272K input tokens), per 1M tokens. Longer
// prompts bill at a higher tier and are under-counted here. OpenAI has no cache-write charge. A
// Codex model absent from the table (gpt-5.3-codex-spark: not on that page) stays `unpriced`, and
// its call `unreported` (the kernel then charges the whole reservation).

export interface Rates {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** Tokens of one usage group: `input` is the UNCACHED part (the crate splits cached input out). */
export type Tokens = Pick<UsageGroup, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>;

const usdOf = (t: Tokens, r: Rates): number =>
  (t.input * r.input +
    t.output * r.output +
    t.cacheRead * r.cacheRead +
    t.cacheWrite * r.cacheWrite) /
  1_000_000;

// ---- the panel's estimate ----

// Approximate list prices per 1M tokens (early 2026). OpenAI bills cached input at a tenth of the
// input rate. Gemini/Cursor/Muse record no usage; they carry the OpenAI-like row.
const OPENAI_LIKE: Rates = { input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 0 };
const PROVIDER_ESTIMATE: Record<ProviderName, Rates> = {
  claude: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  codex: OPENAI_LIKE,
  opencode: OPENAI_LIKE,
  gemini: OPENAI_LIKE,
  cursor: OPENAI_LIKE,
  muse: OPENAI_LIKE,
  pi: OPENAI_LIKE,
};

/** The usage panel's number: a provider-recorded cost wins over the estimate (`reportedCostUsd`
 * is 0 when none was recorded). */
export function estimateUsd(
  provider: ProviderName,
  g: Tokens & { reportedCostUsd: number }
): number {
  if (g.reportedCostUsd > 0) return g.reportedCostUsd;
  return usdOf(g, PROVIDER_ESTIMATE[provider]);
}

// ---- a price a budget may trust ----

const claude = (input: number, output: number, cacheRead = input / 10): Rates => ({
  input,
  output,
  cacheRead,
  cacheWrite: input * 1.25,
});
const openai = (input: number, cacheRead: number, output: number): Rates => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
});
const CODEX_RATES: Readonly<Record<string, Rates>> = {
  'gpt-6.1-sol': openai(2, 0.1, 10),
  'gpt-6-sol': openai(2, 0.2, 10),
  'gpt-6-luna': openai(0.1, 0.01, 0.5),
  'gpt-6-astra': openai(10, 1, 50),
  'gpt-5.6-sol': openai(4, 0.4, 20),
  'gpt-5.6-terra': openai(2, 0.2, 12),
  'gpt-5.6-luna': openai(0.2, 0.02, 1.2),
  'gpt-5.5': openai(5, 0.5, 30),
  'gpt-5.4': openai(2.5, 0.25, 15),
  'gpt-5.4-mini': openai(0.75, 0.075, 4.5),
};

/** By model id as a transcript records it (a dated suffix `-YYYYMMDD` is accepted). */
const MODEL_RATES: Readonly<Partial<Record<ProviderName, Readonly<Record<string, Rates>>>>> = {
  claude: {
    'claude-fable-5-2': claude(8, 40, 0.2),
    'claude-fable-5-1': claude(10, 50),
    'claude-fable-5': claude(10, 50),
    'claude-opus-5-5': claude(4, 20, 0.2),
    'claude-opus-5': claude(5, 25),
    'claude-opus-4-8': claude(5, 25),
    'claude-opus-4-7': claude(5, 25),
    'claude-opus-4-6': claude(5, 25),
    'claude-sonnet-5-5': claude(2, 10, 0.1),
    'claude-sonnet-5': claude(2, 10),
    'claude-sonnet-4-6': claude(3, 15),
    'claude-haiku-5-5': claude(0.1, 0.5),
    'claude-haiku-4-5': claude(1, 5),
  },
  codex: CODEX_RATES,
};

export type Priced =
  | { readonly t: 'priced'; readonly usd: number }
  | { readonly t: 'unpriced'; readonly why: string };

const DATED = /-\d{8}$/;
function ratesOf(provider: ProviderName, model: string): Rates | undefined {
  const table = MODEL_RATES[provider];
  return table?.[model] ?? table?.[model.replace(DATED, '')];
}

/** What one session's (or model's) tokens cost, when that is known. */
export function priceUsd(
  provider: ProviderName,
  model: string | undefined,
  g: Tokens & { reportedCostUsd: number }
): Priced {
  if (g.reportedCostUsd > 0) return { t: 'priced', usd: g.reportedCostUsd };
  if (model === undefined) return { t: 'unpriced', why: `a ${provider} transcript named no model` };
  const rates = ratesOf(provider, model);
  return rates
    ? { t: 'priced', usd: usdOf(g, rates) }
    : { t: 'unpriced', why: `no list price for ${provider} model ${model}` };
}
