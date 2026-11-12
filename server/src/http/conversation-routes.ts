import type {
  ConfigResolution,
  ConversationBranch,
  ConversationDetail,
  ConversationKind,
  Message,
  Provider,
  ProviderTurnUsage,
  TurnAttemptSnapshot,
} from '@unleashd/shared';
import type { Express, Request, RequestHandler, Response } from 'express';
import { BUDDY_BUILDER_BRIEFING } from '../buddies/builder';
import { toolManifest } from '../buddies/mcp';
import { type ContextWindow, resolveContextWindow } from '../conversations/context-window';
import {
  MESSAGE_PAGE_DEFAULT_LIMIT,
  MESSAGE_PAGE_MAX_LIMIT,
  type MessageSource,
} from '../conversations/messages';
import { type SessionContextReading, lookupSessionContext } from '../conversations/session-context';
import type { IngestAccessor, IngestSlot } from '../ingest/instance';
import { type SessionProviderUsage, lookupProviderUsageForSession } from './usage-routes';

/** What the context meter reads about a conversation. */
export interface ContextSubject {
  readonly id: string;
  readonly sessionId: string;
  readonly provider: Provider;
  readonly kind: ConversationKind;
  /** Provider-reported model of the latest turn. */
  readonly observedModel: string | null;
  readonly providerUsage: ProviderTurnUsage | null;
  readonly resumedFromConversationId: string | null;
}

/** The conversation as these routes see it. */
export interface RoutedConversation extends ContextSubject {
  readonly configResolution: ConfigResolution;
  toDetail(): ConversationDetail;
  getMemorySnapshot?: () => { briefing: string; generation: string } | null;
}

export interface ContextBreakdownSection {
  chars: number;
  /** chars/4, not provider tokenization. */
  tokensEst: number;
  /** Rescaled to fit a smaller measured context; else `tokensEst`. */
  tokensScaled: number;
}

/** `measured`: the provider's count for the latest request; `estimated`: chars/4. */
export type ContextReadingSource = 'measured' | 'estimated';

export interface ContextBreakdownResponse {
  conversationId: string;
  sessionId: string;
  provider: Provider;
  modelName: string | null;
  contextWindow: ContextWindow;
  /** Alias of `contextWindow.tokens`, kept so older clients keep rendering. */
  budgetTokens: number;
  /** Which of `totalTokens` / `totalTokensEst` the meter is actually showing. */
  readingSource: ContextReadingSource;
  /** The headline: measured context when available, else the estimate. */
  totalTokens: number;
  /** Unmodelled harness overhead (docs/context-meter.md#bands); 0 for an estimate. */
  residualTokens: number;
  /** The provider dropped history we hold (docs/context-meter.md#bands). */
  compaction: {
    detected: boolean;
    /** The harness's own marker, or our ratio inference; never blended. */
    source: 'marker' | 'inferred';
    historyTokensEst: number;
    measuredTokens: number;
    /** Boundaries crossed. Null on an inferred detection — we cannot count them. */
    count: number | null;
    preTokens: number | null;
    postTokens: number | null;
    trigger: string | null;
  } | null;
  sections: {
    history: ContextBreakdownSection;
    briefing: ContextBreakdownSection;
    memory: ContextBreakdownSection;
    mcp: ContextBreakdownSection;
    handoff: ContextBreakdownSection;
  };
  totalChars: number;
  totalTokensEst: number;
  pctOfBudget: number;
  providerUsage: {
    sessionId: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    /** Provider-priced cumulative input (re-read across turns). Billing truth. */
    cumulativeInputTokens: number;
    ourSentChars: number;
    deltaTokens: number;
    deltaMultiple: number;
  } | null;
  expansion: { message: string; project: string };
  observedAt: string;
}

export interface ContextBreakdownDeps {
  getBranch?: (
    conversationId: string
  ) => Promise<ConversationBranch | null | undefined> | ConversationBranch | null | undefined;
  /** The ingest store's session usage and latest context (server/src/ingest/instance.ts). */
  ingest: IngestAccessor;
  latestAttempt?: (conversationId: string) => Promise<TurnAttemptSnapshot | null>;
}

interface ProviderReadings {
  usage: SessionProviderUsage | null;
  context: SessionContextReading | null;
}

/** While the store is starting the meter shows its estimates only, as for an unknown session. */
async function providerReadings(slot: IngestSlot, sessionId: string): Promise<ProviderReadings> {
  switch (slot.t) {
    case 'starting':
      return { usage: null, context: null };
    case 'ready': {
      const [usage, context] = await Promise.all([
        lookupProviderUsageForSession(slot.ingest, sessionId),
        lookupSessionContext(slot.ingest, sessionId),
      ]);
      return { usage, context };
    }
  }
}

/** Measured under this share of the estimate = compaction, not drift (docs/context-meter.md#bands). */
const COMPACTION_RATIO = 0.9;

/** Heuristic estimate: ceil(chars/4). Labeled estimate everywhere it surfaces. */
export function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

function sectionOf(chars: number): ContextBreakdownSection {
  const normalized = Math.max(0, Math.floor(chars));
  const tokensEst = estimateTokens(normalized);
  return { chars: normalized, tokensEst, tokensScaled: tokensEst };
}

type Sections = Record<(typeof SECTION_KEYS)[number], ContextBreakdownSection>;
const SECTION_KEYS = ['history', 'briefing', 'memory', 'mcp', 'handoff'] as const;

function sumOf(sections: Sections, field: 'chars' | 'tokensEst'): number {
  return SECTION_KEYS.reduce((sum, key) => sum + sections[key][field], 0);
}

function scaled(sections: Sections, factor: number): Sections {
  const out = { ...sections };
  for (const key of SECTION_KEYS) {
    out[key] = { ...sections[key], tokensScaled: Math.round(sections[key].tokensEst * factor) };
  }
  return out;
}

// The Buddy briefing (buddies/briefing.ts) joins prefix + middle + suffix.
// The middle's memory/work/activity tail is the "memory" segment; the head
// (prefix, role brief, relationships, skills, suffix) is the "briefing" segment.
const MEMORY_TAIL_MARKER = 'BUDDY MEMORY (descriptive data';

export function splitBriefing(briefing: string): { briefing: string; memory: string } {
  const index = briefing.indexOf(MEMORY_TAIL_MARKER);
  if (index < 0) return { briefing, memory: '' };
  return { briefing: briefing.slice(0, index), memory: briefing.slice(index) };
}

/** Approximate the history actually sent to a provider, including typed tool payloads. */
function historyBodyChars(body: Message['body']): number {
  if (body.t === 'text') return body.text.length;
  return body.parts.reduce(
    (sum, part) => sum + (part.t === 'text' ? part.text.length : JSON.stringify(part).length),
    0
  );
}

// The tool definitions a turn's provider loads from the one Buddy endpoint (mcp.ts).
function mcpSpecJson(conversation: ContextSubject): string {
  switch (conversation.kind.t) {
    case 'builder':
      return toolManifest('builder');
    case 'buddy':
      return toolManifest('worker');
    case 'chat':
    case 'worker':
      return '';
  }
}

export function buildContextBreakdown(
  conversation: ContextSubject,
  history: readonly Message[],
  snapshotBriefing: string | null,
  branch: ConversationBranch | null | undefined,
  usage: SessionProviderUsage | null,
  contextWindow: ContextWindow,
  sessionContext: SessionContextReading | null = null
): ContextBreakdownResponse {
  const historyChars = history.reduce((sum, message) => sum + historyBodyChars(message.body), 0);

  let briefingText = '';
  let memoryText = '';
  if (conversation.kind.t === 'builder') {
    briefingText = BUDDY_BUILDER_BRIEFING;
  } else if (conversation.kind.t === 'buddy') {
    const split = splitBriefing(snapshotBriefing ?? '');
    briefingText = split.briefing;
    memoryText = split.memory;
  }

  const mcpText = mcpSpecJson(conversation);

  const handoffParts: string[] = [];
  if (branch?.handoff) handoffParts.push(branch.handoff);
  if (conversation.resumedFromConversationId) {
    handoffParts.push(
      `Soft handoff: resumed from /chat/${conversation.resumedFromConversationId} (fork lineage; original kept).`
    );
  }
  const handoffText = handoffParts.join('\n');

  const sections: Sections = {
    history: sectionOf(historyChars),
    briefing: sectionOf(briefingText.length),
    memory: sectionOf(memoryText.length),
    mcp: sectionOf(mcpText.length),
    handoff: sectionOf(handoffText.length),
  };
  const totalChars = sumOf(sections, 'chars');
  const totalTokensEst = sumOf(sections, 'tokensEst');

  // Live usage beats the session log, unless it exceeds a known window: then it is a
  // cumulative aggregate (2026-09-22, codex 16M on 258k) (docs/context-meter.md#measured).
  const liveTokens = conversation.providerUsage?.contextTokens ?? null;
  const livePlausible =
    liveTokens === null ||
    contextWindow.source === 'operator' ||
    contextWindow.source === 'unknown' ||
    liveTokens <= contextWindow.tokens;
  const measuredTokens =
    (livePlausible ? liveTokens : null) ?? sessionContext?.contextTokens ?? null;
  const budgetTokens = contextWindow.tokens;

  // Estimated, or measured: residual band when the model fits, scaled bands when it does not.
  const reading = ((): {
    source: ContextReadingSource;
    total: number;
    sections: Sections;
    residual: number;
    compaction: ContextBreakdownResponse['compaction'];
  } => {
    if (measuredTokens === null) {
      return {
        source: 'estimated',
        total: totalTokensEst,
        sections,
        residual: 0,
        compaction: null,
      };
    }

    // Dropped history and fitting bands are separate questions; the marker wins over the ratio.
    const marker = sessionContext?.compaction ?? null;
    const detected = {
      detected: true,
      historyTokensEst: sections.history.tokensEst,
      measuredTokens,
    };
    const compaction: ContextBreakdownResponse['compaction'] = marker
      ? { ...detected, source: 'marker', ...marker }
      : measuredTokens < totalTokensEst * COMPACTION_RATIO
        ? {
            ...detected,
            source: 'inferred',
            count: null,
            preTokens: null,
            postTokens: null,
            trigger: null,
          }
        : null;

    if (measuredTokens >= totalTokensEst) {
      return {
        source: 'measured',
        total: measuredTokens,
        sections,
        residual: measuredTokens - totalTokensEst,
        compaction,
      };
    }
    const factor = totalTokensEst > 0 ? measuredTokens / totalTokensEst : 0;
    return {
      source: 'measured',
      total: measuredTokens,
      sections: scaled(sections, factor),
      residual: 0,
      compaction,
    };
  })();

  return {
    conversationId: conversation.id,
    // Empty before the first turn starts a provider session; the provider
    // join then yields null usage and the meter shows estimates only.
    sessionId: conversation.sessionId ?? '',
    provider: conversation.provider,
    modelName: conversation.observedModel,
    contextWindow,
    budgetTokens,
    readingSource: reading.source,
    totalTokens: reading.total,
    residualTokens: reading.residual,
    compaction: reading.compaction,
    sections: reading.sections,
    totalChars,
    totalTokensEst,
    pctOfBudget: budgetTokens > 0 ? (reading.total / budgetTokens) * 100 : 0,
    providerUsage: usage
      ? {
          sessionId: usage.sessionId,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          cumulativeInputTokens: usage.cumulativeInputTokens,
          ourSentChars: totalChars,
          deltaTokens: usage.cumulativeInputTokens - totalTokensEst,
          deltaMultiple: usage.cumulativeInputTokens / Math.max(1, totalTokensEst),
        }
      : null,
    expansion: { message: 'get_message({messageId})', project: 'get_current_work({projectId})' },
    observedAt: new Date().toISOString(),
  };
}

/** Express 4 does not catch a rejected async handler: route the error to the error handler. */
function handled(handler: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return (request, response, next) => {
    handler(request, response).catch(next);
  };
}

export function registerConversationRoutes(
  app: Express,
  /** The conversation's runtime, built from its record on first use; undefined = none. */
  getConversation: (id: string) => Promise<RoutedConversation | undefined>,
  messages: MessageSource,
  deps: ContextBreakdownDeps
): void {
  app.get(
    '/api/conversations/:conversationId/context-breakdown',
    handled(async (request, response) => {
      const conversation = await getConversation(request.params.conversationId);
      if (!conversation) {
        response.status(404).json({ error: 'Conversation not found' });
        return;
      }
      const data = conversation;
      let branch: ConversationBranch | null | undefined;
      try {
        branch = (await deps.getBranch?.(data.id)) ?? null;
      } catch {
        branch = null;
      }
      // The harness's session log via ingest: retroactive (docs/context-meter.md#measured).
      let readings: ProviderReadings = { usage: null, context: null };
      try {
        readings = data.sessionId
          ? await providerReadings(deps.ingest(), data.sessionId)
          : readings;
      } catch (error) {
        console.warn('[context-breakdown] ingest read failed:', error);
      }
      const { usage, context: sessionContext } = readings;
      const snapshot = (() => {
        try {
          return conversation.getMemorySnapshot?.()?.briefing ?? null;
        } catch {
          return null;
        }
      })();
      const resolved =
        data.configResolution.status === 'resolved'
          ? data.configResolution.value
          : data.configResolution.lastResolved;
      const contextWindow = resolveContextWindow({
        modelId: resolved?.modelId ?? null,
        reportedModelName: data.observedModel,
        // codex reports its window with its usage, so the file can supply it too.
        reportedWindow: data.providerUsage?.contextWindow ?? sessionContext?.contextWindow ?? null,
      });
      const history =
        (await messages(data.id, { afterSeq: -1, limit: Number.MAX_SAFE_INTEGER }))?.messages ?? [];
      response.json(
        buildContextBreakdown(data, history, snapshot, branch, usage, contextWindow, sessionContext)
      );
    })
  );

  // Detail: config, queue, sub-agents, latest turn. No message bodies.
  app.get(
    '/api/conversations/:conversationId',
    handled(async (request, response) => {
      const conversation = await getConversation(request.params.conversationId);
      if (!conversation) {
        response.status(404).json({ error: 'Conversation not found' });
        return;
      }
      response.json({
        ...conversation.toDetail(),
        latestAttempt: (await deps.latestAttempt?.(conversation.id)) ?? null,
      });
    })
  );

  // Bodies, paged: messages with seq > afterSeq, at most `limit` of them.
  app.get(
    '/api/conversations/:conversationId/messages',
    handled(async (request, response) => {
      const afterSeq = integerParam(request.query.afterSeq, -1);
      const limit = integerParam(request.query.limit, MESSAGE_PAGE_DEFAULT_LIMIT);
      if (afterSeq === null || afterSeq < -1 || limit === null || limit < 1) {
        response.status(400).json({ error: 'afterSeq must be an integer >= -1, limit >= 1' });
        return;
      }
      const page = await messages(request.params.conversationId, {
        afterSeq,
        limit: Math.min(limit, MESSAGE_PAGE_MAX_LIMIT),
      });
      if (!page) {
        response.status(404).json({ error: 'Conversation not found' });
        return;
      }
      response.json(page);
    })
  );
}

/** An absent param takes the default; anything but an integer is null (a 400). */
function integerParam(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return null;
  return Number(value);
}
