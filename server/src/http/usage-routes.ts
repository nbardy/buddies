import type { UsageGroup, UsageQuery } from '@unleashd/ingest';
import type { Provider as ProviderName } from '@unleashd/shared';
import type { Express } from 'express';
import { z } from 'zod';
import type { IngestAccessor, IngestReads } from '../ingest/instance';

// GET /api/usage?days=N (default 30). Pattern: one-write-path (docs/patterns.md#one-write-path)
// A read model of the ingest store's per-request `usage_turn` rows: ~10 ms, where re-parsing
// transcripts took 16.5 s (T13a). Windows count requests by their own time (UTC days), not a
// session's mtime ($10,234 vs $8,570, 2026-09-25). Guard: usage-context-async-parity.test.ts.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

interface RateLimit {
  label: string;
  usedPercent: number;
  windowMinutes: number;
  resetsAt: number | null;
  tokenCount?: number;
}

interface SessionUsage {
  sessionId: string;
  provider: ProviderName;
  /** The model the transcript names; null when it names none. */
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  /** UTC day of the session's latest request in the window. */
  date: string;
}

interface DailyUsage {
  date: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  sessions: number;
}

export interface UsageResponse {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalSessions: number;
  days: number;
  daily: DailyUsage[];
  topSessions: SessionUsage[];
  rateLimits: Record<ProviderName, RateLimit[]>;
}

// Approximate list prices per 1M tokens (early 2026). OpenAI bills cached input at a tenth of the
// input rate; `input` is already the UNCACHED part for every provider (the crate splits Codex's
// cached subset out). Gemini/Cursor/Muse record no usage; they carry the OpenAI-like row.
interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
const OPENAI_LIKE: Rates = { input: 2.5, output: 10, cacheRead: 0.25, cacheWrite: 0 };
const RATES: Record<ProviderName, Rates> = {
  claude: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  codex: OPENAI_LIKE,
  opencode: OPENAI_LIKE,
  gemini: OPENAI_LIKE,
  cursor: OPENAI_LIKE,
  muse: OPENAI_LIKE,
  pi: OPENAI_LIKE,
};

/** A provider-recorded cost (OpenCode) wins over the estimate; `reportedCostUsd` is 0 when none. */
function costUsd(provider: ProviderName, g: UsageGroup): number {
  if (g.reportedCostUsd > 0) return g.reportedCostUsd;
  const r = RATES[provider];
  return (
    (g.input * r.input +
      g.output * r.output +
      g.cacheRead * r.cacheRead +
      g.cacheWrite * r.cacheWrite) /
    1_000_000
  );
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

async function sessionsIn(ingest: IngestReads, query: Omit<UsageQuery, 'groupBy'>) {
  const report = await ingest.usage({ ...query, groupBy: 'session' });
  const sessions: SessionUsage[] = report.groups.flatMap((g) =>
    g.key.t === 'session'
      ? [
          {
            sessionId: g.key.sessionId,
            provider: g.key.provider,
            model: g.key.model ?? null,
            inputTokens: g.input,
            outputTokens: g.output,
            cacheReadTokens: g.cacheRead,
            cacheWriteTokens: g.cacheWrite,
            costUsd: costUsd(g.key.provider, g),
            date: utcDay(g.lastAt),
          },
        ]
      : []
  );
  return { sessions, codexRateLimits: report.codexRateLimits };
}

/** Claude publishes no limits; the panel shows the tokens (input + output) of the window. */
async function claudeTokensSince(ingest: IngestReads, since: number): Promise<number> {
  const report = await ingest.usage({ since, groupBy: 'model' });
  let tokens = 0;
  for (const g of report.groups) {
    if (g.key.t === 'model' && g.key.provider === 'claude') tokens += g.input + g.output;
  }
  return tokens;
}

const CodexWindowSchema = z.object({
  used_percent: z.number(),
  window_minutes: z.number(),
  resets_at: z.number().nullish(),
});
const CodexRateLimitsSchema = z.object({
  primary: CodexWindowSchema.nullish(),
  secondary: CodexWindowSchema.nullish(),
});

/**
 * The crate keeps Codex's latest `rate_limits` payload verbatim. A shape Codex changed is logged
 * and shown as no limits, rather than failing the whole usage panel.
 */
function codexLimits(raw: string | undefined): RateLimit[] {
  if (raw === undefined) return [];
  const parsed = CodexRateLimitsSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    console.warn('[usage] unrecognized Codex rate_limits payload:', parsed.error.message);
    return [];
  }
  // The slot name says nothing about duration (weekly can be `primary`): label by minutes.
  const { primary, secondary } = parsed.data;
  return [primary, secondary]
    .filter((w): w is z.infer<typeof CodexWindowSchema> => w != null)
    .map((w) => ({
      label: `${rateWindowLabel(w.window_minutes)} limit`,
      usedPercent: w.used_percent,
      windowMinutes: w.window_minutes,
      resetsAt: w.resets_at ?? null,
    }));
}

/** A rate-limit window's duration as a short label: 300 → "5h", 10080 → "7d", 90 → "90m". */
export function rateWindowLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function totalsOf(sessions: readonly SessionUsage[]): Omit<DailyUsage, 'date'> {
  const sum = (field: 'inputTokens' | 'outputTokens' | 'costUsd') =>
    sessions.reduce((n, s) => n + s[field], 0);
  return {
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    costUsd: sum('costUsd'),
    sessions: sessions.length,
  };
}

export async function usageResponse(
  ingest: IngestReads,
  providerNames: readonly ProviderName[],
  days: number,
  now: number
): Promise<UsageResponse> {
  const since = now - days * DAY_MS;
  const window = await sessionsIn(ingest, { since });

  // One range query per UTC day that has usage (the `day` grouping names them).
  const dayReport = await ingest.usage({ since, groupBy: 'day' });
  const daily = await Promise.all(
    dayReport.groups
      .flatMap((g) => (g.key.t === 'day' ? [g.key.day] : []))
      .map(async (date) => {
        const start = Date.parse(`${date}T00:00:00Z`);
        const { sessions } = await sessionsIn(ingest, {
          since: Math.max(start, since),
          until: start + DAY_MS,
        });
        return { date, ...totalsOf(sessions) };
      })
  );
  daily.sort((a, b) => b.date.localeCompare(a.date));

  // Top 20 by cost, plus each provider's top session so every provider tab has a row.
  const byCost = [...window.sessions].sort((a, b) => b.costUsd - a.costUsd);
  const topSessions = byCost.slice(0, 20);
  for (const provider of providerNames) {
    const top = byCost.find((s) => s.provider === provider);
    if (top && !topSessions.includes(top)) topSessions.push(top);
  }
  topSessions.sort((a, b) => b.costUsd - a.costUsd);

  const rateLimits = Object.fromEntries(providerNames.map((p) => [p, [] as RateLimit[]])) as Record<
    ProviderName,
    RateLimit[]
  >;
  rateLimits.codex = codexLimits(window.codexRateLimits);
  const [claude5h, claudeWeek] = await Promise.all([
    claudeTokensSince(ingest, now - 5 * HOUR_MS),
    claudeTokensSince(ingest, now - 7 * DAY_MS),
  ]);
  if (claude5h + claudeWeek > 0) {
    const tokenWindow = (label: string, windowMinutes: number, tokenCount: number) => ({
      label,
      usedPercent: 0,
      windowMinutes,
      resetsAt: null,
      tokenCount,
    });
    rateLimits.claude = [
      tokenWindow('5h window', 300, claude5h),
      tokenWindow('Weekly', 10080, claudeWeek),
    ];
  }

  const totals = totalsOf(window.sessions);
  return {
    totalCostUsd: totals.costUsd,
    totalInputTokens: totals.inputTokens,
    totalOutputTokens: totals.outputTokens,
    totalSessions: totals.sessions,
    days,
    daily,
    topSessions,
    rateLimits,
  };
}

/** Cumulative provider usage of one CLI session, for the context-breakdown meter. */
export interface SessionProviderUsage {
  sessionId: string;
  provider: ProviderName;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Provider-priced cumulative input (re-read across turns, not one turn's stack). */
  cumulativeInputTokens: number;
}

/** null: the store has no transcript of that id, or the harness records no usage. */
export async function lookupProviderUsageForSession(
  ingest: IngestReads,
  sessionId: string
): Promise<SessionProviderUsage | null> {
  const row = await ingest.session(sessionId);
  if (!row?.usage) return null;
  const u = row.usage;
  return {
    sessionId,
    provider: row.provider,
    model: row.observedModel ?? null,
    inputTokens: u.input,
    outputTokens: u.output,
    cacheReadTokens: u.cacheRead,
    cacheWriteTokens: u.cacheWrite,
    cumulativeInputTokens: u.input + u.cacheRead + u.cacheWrite,
  };
}

export function registerUsageRoutes(
  app: Express,
  providerNames: readonly ProviderName[],
  ingest: IngestAccessor
): void {
  app.get('/api/usage', async (request, response) => {
    const days = Math.min(Math.max(Number.parseInt(String(request.query.days)) || 30, 1), 365);
    const slot = ingest();
    switch (slot.t) {
      case 'starting':
        response.status(503).json({ error: 'The transcript store is still starting' });
        return;
      case 'ready':
        response.json(await usageResponse(slot.ingest, providerNames, days, Date.now()));
        return;
    }
  });
}
