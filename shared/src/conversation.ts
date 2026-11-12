import { z } from 'zod';
import {
  BuddyContextSchema,
  BuddyVisibilitySchema,
  type ConversationConfigState,
  ConversationConfigStateSchema,
  ConversationIdSchema,
  type ConversationKind,
  ProviderTurnUsageSchema,
  WorkerRoleSchema,
  matchConversationKind,
} from './conversation-config.js';
import { ProviderSchema } from './provider-catalog.js';
import { TurnAttemptSnapshotSchema } from './turn-attempt.js';

// =============================================================================
// Conversation read models (protocol v3, T09 2026-09-25)
//
// One conversation has three projections, each loaded by whoever needs it:
//   ConversationRow    — list fields only; every client holds every row.
//   ConversationDetail — config, queue, sub-agents, latest turn; loaded per
//                        open conversation (GET /api/conversations/:id).
//   MessagePage        — transcript bodies, paged on demand
//                        (GET /api/conversations/:id/messages).
// Until T09 every row carried all three: `init` was 1.87 MB for 1,161
// conversations and marking a 1,099-message chat done re-sent 1.36 MB to every
// socket. Guards: server/test/wire-v3.test.ts.
// =============================================================================

import { MessageBodySchema } from './content-schema.js';
import { legacyBody, legacyToolInput } from './legacy-content.js';
import { toolContentPart } from './tool-content.js';

export type { AskUserQuestion, ContentPart, MessageBody } from './content-schema.js';
export { AskUserQuestionSchema, ContentPartSchema, MessageBodySchema } from './content-schema.js';

const CurrentMessageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  body: MessageBodySchema,
  timestamp: z.coerce.date(),
  completedAt: z.coerce.date().optional(),
  completionReason: z.enum(['success', 'error', 'out_of_tokens', 'killed']).optional(),
});
// An already-open tab can receive an old backend's HTTP page during the dev
// restart window. Upgrade that historical wire shape once, before rendering.
export const MessageSchema = z.preprocess((value) => {
  if (!value || typeof value !== 'object') return value;
  const message = value as Record<string, unknown>;
  if (message.body !== undefined || typeof message.content !== 'string') return value;
  const call = message.toolCall as { name?: unknown; input?: unknown } | undefined;
  const body =
    typeof call?.name === 'string'
      ? {
          t: 'parts' as const,
          parts: [
            toolContentPart(
              call.name,
              legacyToolInput(typeof call.input === 'string' ? call.input : undefined)
            ),
          ],
        }
      : message.role === 'assistant'
        ? legacyBody(message.content)
        : { t: 'text' as const, text: message.content };
  return { ...message, body };
}, CurrentMessageSchema);
export type Message = z.infer<typeof MessageSchema>;

export const SubAgentStatusSchema = z.enum(['pending', 'running', 'completed', 'error']);
export type SubAgentStatus = z.infer<typeof SubAgentStatusSchema>;

export const SubAgentStatusSourceSchema = z.enum([
  'native',
  'inferred_parent_completion',
  'recovered_from_disk',
]);

export const SubAgentSchema = z.object({
  id: z.string(),
  description: z.string(),
  status: SubAgentStatusSchema,
  toolUses: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  currentAction: z.string().optional(), // e.g., "Write: client/src/App.css"
  startedAt: z.coerce.date(),
  completedAt: z.coerce.date().optional(),
  providerThreadId: z.string().optional(),
  rawStatus: z.string().optional(),
  statusSource: SubAgentStatusSourceSchema.optional(),
});
export type SubAgent = z.infer<typeof SubAgentSchema>;

// Queue types (shared between server state and client display).
export const QueuedMessageSchema = z.object({
  id: z.string(),
  content: z.string(),
  queuedAt: z.coerce.date(),
  status: z.enum(['pending', 'sending']),
});
export type QueuedMessage = z.infer<typeof QueuedMessageSchema>;

// ── Row kind: the list projection of ConversationKind ───────────────────────
// Only the ids a list groups on. Buddy run data (delegation, allowed ops —
// 293 KB of the old init) stays on the server.
export const RowKindSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('chat') }),
  z.object({
    t: z.literal('buddy'),
    buddyId: z.string().min(1),
    workspaceId: z.string().min(1),
    visibility: BuddyVisibilitySchema,
  }),
  z.object({ t: z.literal('builder') }),
  z.object({
    t: z.literal('worker'),
    swarmId: z.string().nullable(),
    workerId: z.string().nullable(),
    role: WorkerRoleSchema.nullable(),
  }),
]);
export type RowKind = z.infer<typeof RowKindSchema>;

export function rowKind(kind: ConversationKind): RowKind {
  return matchConversationKind<RowKind>(kind, {
    chat: () => ({ t: 'chat' }),
    buddy: ({ context, visibility }) => ({
      t: 'buddy',
      buddyId: context.buddyId,
      workspaceId: context.workspaceId,
      visibility,
    }),
    builder: () => ({ t: 'builder' }),
    worker: ({ swarmId, workerId, role }) => ({ t: 'worker', swarmId, workerId, role }),
  });
}

/**
 * What a create command asks for. A fork inherits its source's kind on the
 * server (the client holds only the source's row); the other kinds are new.
 */
export const CreateKindSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('chat') }),
  z.object({ t: z.literal('buddy'), context: BuddyContextSchema }),
  z.object({ t: z.literal('fork'), from: ConversationIdSchema }),
]);
export type CreateKind = z.infer<typeof CreateKindSchema>;

/**
 * One turn-state field instead of isRunning + isStreaming (+ queue length for
 * the list's "queued" dot). `queued` = no process yet, work waiting.
 */
export const RunStateSchema = z.enum(['idle', 'queued', 'running', 'streaming']);
export type RunState = z.infer<typeof RunStateSchema>;

export const ConversationRowSchema = z.object({
  id: ConversationIdSchema,
  kind: RowKindSchema,
  /** Provider-native parent thread (codex thread_spawn); null = top level. */
  parent: ConversationIdSchema.nullable(),
  /** Chat "Fork" soft-handoff lineage; null = not a fork. */
  resumedFrom: ConversationIdSchema.nullable(),
  provider: ProviderSchema,
  cwd: z.string(),
  /** Provider title, else the first user line; derived once on the server. */
  label: z.string(),
  /** Epoch ms. */
  createdAt: z.number(),
  /** Epoch ms of the last message (createdAt when empty). */
  activityAt: z.number(),
  /** Also the stale-transcript signal: a loaded transcript of another length refetches. */
  messageCount: z.number().int().nonnegative(),
  run: RunStateSchema,
  done: z.boolean(),
});
export type ConversationRow = z.infer<typeof ConversationRowSchema>;

/** Provider-reported facts from the latest turn. Never configuration authority. */
export const TurnObservationSchema = z.object({
  observedModel: z.string().nullable(),
  // Null before the first turn reports usage, and on harnesses that report
  // none (muse). Never an estimate.
  usage: ProviderTurnUsageSchema.nullable(),
});

export const ConversationDetailSchema = z.object({
  id: ConversationIdSchema,
  sessionId: z.string(),
  // The only model/effort authority: intent + revision + server resolution.
  config: ConversationConfigStateSchema,
  queue: z.array(QueuedMessageSchema),
  subAgents: z.array(SubAgentSchema),
  latestTurn: TurnObservationSchema,
  latestAttempt: TurnAttemptSnapshotSchema.nullable().default(null),
});
export type ConversationDetail = z.infer<typeof ConversationDetailSchema>;

/**
 * One page of transcript bodies. `seq` of messages[i] is `afterSeq + 1 + i`.
 * `epoch` changes whenever the server REPLACED history rather than appended
 * (restore from disk, merge of a native transcript): a client holding another
 * epoch refetches from the start instead of appending.
 */
export const MessagePageSchema = z.object({
  epoch: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  afterSeq: z.number().int().min(-1),
  messages: z.array(MessageSchema),
});
export type MessagePage = z.infer<typeof MessagePageSchema>;

// Pattern: patches-not-snapshots (docs/patterns.md#patches-not-snapshots)
// Each variant replaces exactly one field group. Row-level patches move the
// list row; detail-level ones apply only where that detail is loaded.
export const RowPatchSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('run'), run: RunStateSchema }),
  z.object({ t: z.literal('done'), done: z.boolean() }),
  z.object({ t: z.literal('label'), label: z.string() }),
  z.object({
    t: z.literal('activity'),
    activityAt: z.number(),
    messageCount: z.number().int().nonnegative(),
  }),
  z.object({
    t: z.literal('config'),
    state: ConversationConfigStateSchema,
    commandId: z.string().nullable(),
  }),
  z.object({ t: z.literal('queue'), queue: z.array(QueuedMessageSchema) }),
  z.object({ t: z.literal('session'), sessionId: z.string() }),
  z.object({ t: z.literal('subagent'), subAgent: SubAgentSchema }),
  z.object({ t: z.literal('turn'), latestTurn: TurnObservationSchema }),
  z.object({ t: z.literal('attempt'), latestAttempt: TurnAttemptSnapshotSchema.nullable() }),
  // History was REPLACED, not appended (a transcript rewritten on disk, or the live overlay
  // absorbed into the provider's own rows): a loaded transcript refetches even when its length
  // did not change. Guard: server/test/ingest-history.test.ts.
  z.object({ t: z.literal('rewritten') }),
]);
export type RowPatch = z.infer<typeof RowPatchSchema>;

// ── Wire encoding of rows: a per-message dictionary ─────────────────────────
// 1,003 of 1,161 rows are Buddy threads, and each repeated its 42-byte buddy
// id and 44-byte workspace id; the cwd repeats too (35 distinct). A `hello`
// or `rows` message carries each distinct cwd / Buddy once and rows point at
// them by index. `decodeRows` rebuilds canonical ConversationRows, so nothing
// past the socket sees an index.
const WireRowKindSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('chat') }),
  z.object({ t: z.literal('buddy'), b: z.number().int().nonnegative(), bg: z.boolean() }),
  z.object({ t: z.literal('builder') }),
  z.object({
    t: z.literal('worker'),
    swarmId: z.string().nullable(),
    workerId: z.string().nullable(),
    role: WorkerRoleSchema.nullable(),
  }),
]);
type WireRowKind = z.infer<typeof WireRowKindSchema>;

const WireRowSchema = z.object({
  id: ConversationIdSchema,
  kind: WireRowKindSchema,
  // Defaults so the common value is omitted on the wire; the decoded row is total.
  parent: ConversationIdSchema.nullable().default(null),
  resumedFrom: ConversationIdSchema.nullable().default(null),
  provider: ProviderSchema,
  cwd: z.number().int().nonnegative(),
  label: z.string(),
  createdAt: z.number(),
  activityAt: z.number(),
  messageCount: z.number().int().nonnegative(),
  run: RunStateSchema.default('idle'),
  done: z.boolean().default(false),
});
type WireRow = z.input<typeof WireRowSchema>;

export const EncodedRowsSchema = z.object({
  cwds: z.array(z.string()),
  buddies: z.array(z.tuple([z.string().min(1), z.string().min(1)])),
  rows: z.array(WireRowSchema),
});
export type EncodedRows = z.input<typeof EncodedRowsSchema>;
type ParsedEncodedRows = z.infer<typeof EncodedRowsSchema>;

class Interner<T> {
  readonly values: T[] = [];
  private readonly index = new Map<string, number>();
  add(key: string, value: T): number {
    const existing = this.index.get(key);
    if (existing !== undefined) return existing;
    this.values.push(value);
    this.index.set(key, this.values.length - 1);
    return this.values.length - 1;
  }
}

export function encodeRows(rows: readonly ConversationRow[]): EncodedRows {
  const cwds = new Interner<string>();
  const buddies = new Interner<[string, string]>();
  const encodeKind = (kind: RowKind): WireRowKind => {
    switch (kind.t) {
      case 'buddy':
        return {
          t: 'buddy',
          b: buddies.add(`${kind.buddyId}\0${kind.workspaceId}`, [kind.buddyId, kind.workspaceId]),
          bg: kind.visibility === 'background',
        };
      case 'chat':
      case 'builder':
      case 'worker':
        return kind;
    }
  };
  const wire = rows.map((row): WireRow => {
    const encoded: WireRow = {
      id: row.id,
      kind: encodeKind(row.kind),
      provider: row.provider,
      cwd: cwds.add(row.cwd, row.cwd),
      label: row.label,
      createdAt: row.createdAt,
      activityAt: row.activityAt,
      messageCount: row.messageCount,
    };
    if (row.parent !== null) encoded.parent = row.parent;
    if (row.resumedFrom !== null) encoded.resumedFrom = row.resumedFrom;
    if (row.run !== 'idle') encoded.run = row.run;
    if (row.done) encoded.done = true;
    return encoded;
  });
  return { cwds: cwds.values, buddies: buddies.values, rows: wire };
}

/** Rebuild canonical rows. Throws on an index outside the message's tables. */
export function decodeRows(encoded: ParsedEncodedRows): ConversationRow[] {
  const at = <T>(table: readonly T[], index: number, what: string): T => {
    const value = table[index];
    if (value === undefined) throw new Error(`Row references missing ${what} #${index}`);
    return value;
  };
  return encoded.rows.map((row) => {
    const kind: RowKind =
      row.kind.t === 'buddy'
        ? {
            t: 'buddy',
            buddyId: at(encoded.buddies, row.kind.b, 'buddy')[0],
            workspaceId: at(encoded.buddies, row.kind.b, 'buddy')[1],
            visibility: row.kind.bg ? 'background' : 'foreground',
          }
        : row.kind;
    return { ...row, kind, cwd: at(encoded.cwds, row.cwd, 'cwd') };
  });
}

/** The row fields a patch changes, applied without touching the others. */
export function applyRowPatch(row: ConversationRow, patch: RowPatch): ConversationRow {
  switch (patch.t) {
    case 'run':
      return row.run === patch.run ? row : { ...row, run: patch.run };
    case 'done':
      return row.done === patch.done ? row : { ...row, done: patch.done };
    case 'label':
      return row.label === patch.label ? row : { ...row, label: patch.label };
    case 'activity':
      return row.activityAt === patch.activityAt && row.messageCount === patch.messageCount
        ? row
        : { ...row, activityAt: patch.activityAt, messageCount: patch.messageCount };
    case 'config':
      return row.provider === patch.state.config.provider
        ? row
        : { ...row, provider: patch.state.config.provider };
    case 'queue':
    case 'session':
    case 'subagent':
    case 'turn':
    case 'attempt':
    case 'rewritten':
      return row;
  }
}

/** The detail fields a patch changes (structural sharing: untouched fields keep identity). */
export function applyDetailPatch(detail: ConversationDetail, patch: RowPatch): ConversationDetail {
  switch (patch.t) {
    case 'config':
      return { ...detail, config: patch.state };
    case 'queue':
      return { ...detail, queue: patch.queue };
    case 'session':
      return { ...detail, sessionId: patch.sessionId };
    case 'subagent': {
      const index = detail.subAgents.findIndex((agent) => agent.id === patch.subAgent.id);
      const subAgents =
        index === -1
          ? [...detail.subAgents, patch.subAgent].slice(-SUBAGENT_LIMIT)
          : detail.subAgents.map((agent, i) => (i === index ? patch.subAgent : agent));
      return { ...detail, subAgents };
    }
    case 'turn':
      return { ...detail, latestTurn: patch.latestTurn };
    case 'attempt':
      return { ...detail, latestAttempt: patch.latestAttempt };
    case 'run':
    case 'done':
    case 'label':
    case 'activity':
    case 'rewritten':
      return detail;
  }
}

/** Sub-agents a detail keeps (the newest). */
export const SUBAGENT_LIMIT = 10;

export type { ConversationConfigState };
