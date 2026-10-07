import type {
  ConversationDetail,
  ConversationRow,
  Message,
  MessagePage,
  RowPatch,
  ServerMessage,
} from '@unleashd/shared';
import {
  ConversationDetailSchema,
  MessagePageSchema,
  applyDetailPatch,
  applyRowPatch,
  decodeRows,
} from '@unleashd/shared';
import { archivedBuddyIdsAtom, hideArchivedBuddy } from './buddy-visibility';
import {
  dropCommandsFor,
  reconcileCommandsOnHello,
  rejectSends,
  sendMessageCommand,
  sendNow,
  settleAccepted,
  settleConfig,
  settleCreate,
  settleRejected,
} from './commands';
import {
  type LoadedTranscript,
  type Socket,
  type Transcript,
  connectionAtom,
  defaultCwdOf,
  forgetConversationAtoms,
  loadedOf,
  releaseTranscriptDerived,
  rowStore,
  rowsAtom,
  streamStore,
  transcriptStore,
} from './conversations';
import { invalidateBuddyResources, invalidateChannelResources } from './resources';
import {
  captureRestartRecoveryQueue,
  clearRestartRecovery,
  removeRestartRecoveryAtom,
} from './restart-recovery';
import { jotaiStore } from './store';
import { DRAFT_KEY_PREFIX, PENDING_FILES_KEY_PREFIX, removeSeenIndex } from './ui';

// =============================================================================
// Chunk buffer
//
// Text chunks arrive 100-200x per response (1-20 chars each). They accumulate
// here, outside state, and flush once per animation frame into the streaming
// conversation's own atom.
// =============================================================================

const chunkBuffer: Map<string, string> = new Map();
let chunkFlushScheduled = false;
const transcriptRequests = new Map<string, Promise<void>>();
// Bumped on every `hello`: a response started under an older socket epoch is
// dropped instead of overwriting state the new epoch already delivered.
let connectionEpoch = 0;
// Bumped per id on every `rewritten` patch. A first load already in flight
// (transcript `loading`) was read from the history the server just replaced;
// without this it landed as `loaded` and, when the replaced history had the
// same count, the open view never refetched it (final review 2026-09-26).
const historyGeneration = new Map<string, number>();

// =============================================================================
// Reads (snapshots for event handlers; never a subscription)
// =============================================================================

export function readConversation(id: string): ConversationRow | null {
  return jotaiStore.get(rowsAtom).get(id) ?? null;
}

function readTranscript(id: string): Transcript {
  return jotaiStore.get(transcriptStore.byKey(id));
}

function readLoaded(id: string): LoadedTranscript | null {
  return loadedOf(readTranscript(id));
}

export function readConversationDetail(id: string): ConversationDetail | null {
  return readLoaded(id)?.detail ?? null;
}

export function readConversationMessages(id: string): readonly Message[] {
  return readLoaded(id)?.messages ?? [];
}

// =============================================================================
// Writes. Each names the ids it touches, so only those per-id atoms and the
// list index move.
// =============================================================================

// Pattern: parse-dont-validate (docs/patterns.md#parse-dont-validate)
// An archived Buddy's rows never enter the store, so no reader filters them
// (until T19 every rowFamily read and three list views re-checked the set).
function admitted(rows: readonly ConversationRow[]): ConversationRow[] {
  const archived = jotaiStore.get(archivedBuddyIdsAtom);
  if (archived.size === 0) return rows as ConversationRow[];
  return rows.filter((row) => !(row.kind.t === 'buddy' && archived.has(row.kind.buddyId)));
}

function putRows(rows: readonly ConversationRow[]): void {
  const admit = admitted(rows);
  if (admit.length === 0) return;
  jotaiStore.set(rowStore.patch, { set: admit.map((row) => [row.id, row] as const), remove: [] });
}

function removeConversations(ids: readonly string[]): void {
  if (ids.length === 0) return;
  jotaiStore.set(rowStore.patch, { set: [], remove: ids });
  jotaiStore.set(transcriptStore.patch, { set: [], remove: ids });
  for (const id of ids) loadedOrder.delete(id);
}

// Fix-guard (2026-10-08 audit: a threads tab reached ~17GB): a tab kept the full transcript of every
// conversation it ever opened until the socket reconnected. Past this many, the least recently
// written ones go back to `absent`; the open view's `useConversationBodies` reloads on demand.
// Above PREFETCH_CONVERSATION_LIMIT (12) so warming never evicts the open chat.
// Guard: client/test/transcript-eviction.test.ts.
const LOADED_TRANSCRIPT_LIMIT = 24;
/** Loaded ids, least recently written first (a Set iterates in insertion order). */
const loadedOrder = new Set<string>();

function putTranscript(id: string, transcript: Transcript): void {
  jotaiStore.set(transcriptStore.patch, { set: [[id, transcript]], remove: [] });
  loadedOrder.delete(id);
  if (transcript.tag !== 'loaded') return;
  loadedOrder.add(id);
  evictStaleTranscripts(id);
}

/** Ids a mounted view is showing (useConversationBodies); an idle open chat is the oldest write. */
const viewedTranscripts = new Set<string>();
export function setTranscriptViewed(id: string, viewed: boolean): void {
  if (viewed) viewedTranscripts.add(id);
  else viewedTranscripts.delete(id);
}

/** A viewed chat, a streaming reply or an in-flight load is never evicted from under its reader. */
function evictStaleTranscripts(justWritten: string): void {
  let over = loadedOrder.size - LOADED_TRANSCRIPT_LIMIT;
  for (const id of loadedOrder) {
    if (over <= 0) return;
    if (id === justWritten || viewedTranscripts.has(id)) continue;
    if (jotaiStore.get(streamStore.byKey(id)) !== '' || transcriptRequests.has(id)) continue;
    loadedOrder.delete(id);
    jotaiStore.set(transcriptStore.patch, { set: [], remove: [id] });
    releaseTranscriptDerived(id);
    over -= 1;
  }
}

// =============================================================================
// On-demand bodies: detail + message pages (protocol v3)
// =============================================================================

const MESSAGE_PAGE_LIMIT = 500;

async function fetchJson<T>(
  url: string,
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false; error: Error };
  }
): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request ${url} failed with HTTP ${response.status}`);
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) throw new Error(`Invalid response from ${url}: ${parsed.error.message}`);
  return parsed.data;
}

function messagesUrl(id: string, afterSeq: number): string {
  return `/api/conversations/${encodeURIComponent(id)}/messages?afterSeq=${afterSeq}&limit=${MESSAGE_PAGE_LIMIT}`;
}

/**
 * Every message with seq > afterSeq, paged. Restarts from the beginning when
 * the server's epoch moves mid-read (its history was replaced, not appended).
 */
async function readMessagesAfter(
  id: string,
  afterSeq: number
): Promise<{ epoch: number; messages: Message[] }> {
  let first: MessagePage | null = null;
  const messages: Message[] = [];
  let cursor = afterSeq;
  while (true) {
    const page = await fetchJson(messagesUrl(id, cursor), MessagePageSchema);
    if (first && page.epoch !== first.epoch) return readMessagesAfter(id, -1);
    first ??= page;
    messages.push(...page.messages);
    cursor += page.messages.length;
    if (page.messages.length === 0 || cursor + 1 >= page.total) {
      return { epoch: page.epoch, messages };
    }
  }
}

/** The whole history, tagged with the `rewritten` generation it was read under. */
async function readCurrentHistory(
  id: string
): Promise<{ generation: number; epoch: number; messages: Message[] }> {
  const generation = historyGeneration.get(id) ?? 0;
  return { generation, ...(await readMessagesAfter(id, -1)) };
}

function dedupe(id: string, start: () => Promise<void>): Promise<void> {
  const existing = transcriptRequests.get(id);
  if (existing) return existing;
  const request = start().finally(() => {
    // An old epoch may settle after reconnect installed a newer request.
    if (transcriptRequests.get(id) === request) transcriptRequests.delete(id);
  });
  transcriptRequests.set(id, request);
  return request;
}

/**
 * Open a conversation: its detail and every message body. Deduped in flight
 * and epoch-guarded against reconnect. The outcome lands in the transcript
 * atom (`loaded` or `failed`), so a remount shows it without refetching.
 */
export function loadConversationDetails(conversationId: string): Promise<void> {
  return dedupe(conversationId, async () => {
    const requestEpoch = connectionEpoch;
    if (!readLoaded(conversationId)) putTranscript(conversationId, { tag: 'loading' });
    try {
      const [detail, first] = await Promise.all([
        fetchJson(
          `/api/conversations/${encodeURIComponent(conversationId)}`,
          ConversationDetailSchema
        ),
        readCurrentHistory(conversationId),
      ]);
      let body = first;
      while (body.generation !== (historyGeneration.get(conversationId) ?? 0)) {
        body = await readCurrentHistory(conversationId);
      }
      if (requestEpoch !== connectionEpoch || !readConversation(conversationId)) return;
      // Fix guard: a terminal attempt patch can arrive after detail GET but before
      // history resolves; retaining it in `loading` prevents stale recovery/status.
      const loading = readTranscript(conversationId);
      reconcileStream(conversationId, body.messages.at(-1));
      const currentDetail =
        loading.tag === 'loading' && loading.latestAttempt !== undefined
          ? { ...detail, latestAttempt: loading.latestAttempt }
          : detail;
      putTranscript(conversationId, {
        tag: 'loaded',
        epoch: body.epoch,
        messages: body.messages,
        detail: currentDetail,
      });
    } catch (cause) {
      if (requestEpoch !== connectionEpoch) return;
      putTranscript(conversationId, {
        tag: 'failed',
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  });
}

/**
 * Page in only what changed: the last message we hold (a streamed reply may
 * have grown) and everything after it. A different epoch means the history
 * was replaced, so the whole transcript reloads. A failed refresh leaves the
 * previous history on screen; the next moved count retries.
 */
export function refreshTranscript(conversationId: string): Promise<void> {
  const current = readLoaded(conversationId);
  if (!current) return loadConversationDetails(conversationId);
  return dedupe(conversationId, async () => {
    const requestEpoch = connectionEpoch;
    const keep = Math.max(0, current.messages.length - 1);
    const tail = await readMessagesAfter(conversationId, keep - 1);
    if (requestEpoch !== connectionEpoch) return;
    const latest = readLoaded(conversationId);
    if (tail.epoch !== current.epoch || !latest) {
      putTranscript(conversationId, { tag: 'absent' });
      transcriptRequests.delete(conversationId);
      await loadConversationDetails(conversationId);
      return;
    }
    reconcileStream(conversationId, tail.messages.at(-1) ?? latest.messages.at(keep - 1));
    // Structural sharing: the kept prefix keeps its message objects, so only
    // the tail groups rebuild (T05's tail regroup).
    putTranscript(conversationId, {
      ...latest,
      epoch: tail.epoch,
      messages: [...latest.messages.slice(0, keep), ...tail.messages],
    });
  }).catch((error) => {
    console.warn(`[WS] Could not refresh history for ${conversationId}:`, error);
  });
}

function flushChunkBuffer(): void {
  chunkFlushScheduled = false;
  if (chunkBuffer.size === 0) return;
  const pending = new Map(chunkBuffer);
  chunkBuffer.clear();
  // Only the streaming conversations' own atoms: the list never sees chunks.
  const updates: Array<readonly [string, string]> = [];
  for (const [id, text] of pending) {
    if (readLoaded(id)?.messages.at(-1)?.role !== 'assistant') continue;
    updates.push([id, jotaiStore.get(streamStore.byKey(id)) + text]);
  }
  if (updates.length > 0) jotaiStore.set(streamStore.patch, { set: updates, remove: [] });
}

// Fix-guard (2026-10-08 audit: a threads tab reached ~17GB): the flush rode requestAnimationFrame
// alone, and browsers never fire it in a hidden tab. The server sends every conversation's chunks
// to every tab, so a background tab buffered all agents' streamed text without bound. The timer
// fires in hidden tabs (throttled to ~1s); whichever of frame/timer comes first flushes, and
// flushChunkBuffer drops text for conversations that are not streaming here.
// Guard: client/test/chunk-flush-hidden.test.ts.
const CHUNK_FLUSH_FALLBACK_MS = 100;

function scheduleChunkFlush(): void {
  if (chunkFlushScheduled) return;
  chunkFlushScheduled = true;
  const flushIfPending = () => {
    if (chunkFlushScheduled) flushChunkBuffer();
  };
  requestAnimationFrame(flushIfPending);
  setTimeout(flushIfPending, CHUNK_FLUSH_FALLBACK_MS);
}

// =============================================================================
// Connection
// =============================================================================

export function setSocket(socket: Socket): void {
  jotaiStore.set(connectionAtom, { ...jotaiStore.get(connectionAtom), socket });
}

/**
 * The socket delivered another protocol's greeting (a v2 `init`): the backend
 * has not reloaded yet. Keep every row; useWebSocket reconnects.
 */
export function noteProtocolMismatch(serverVersion: number): void {
  jotaiStore.set(connectionAtom, {
    ...jotaiStore.get(connectionAtom),
    server: { tag: 'skew', serverVersion },
  });
}

/**
 * The server closed the socket because it speaks a newer protocol: this tab
 * runs code from before the swap. Keep the rows; UpdateBanner asks for a reload.
 */
export function noteClientOutdated(serverVersion: number): void {
  jotaiStore.set(connectionAtom, {
    socket: { tag: 'closed' },
    server: { tag: 'outdated', serverVersion },
  });
}

// =============================================================================
// Public actions — called by components
// =============================================================================

/**
 * Hide or unhide a conversation. Not optimistic: the server writes the record
 * and broadcasts a `done` patch, which is what moves the row. Callers disable
 * the control while disconnected.
 */
export function setConversationDone(conversationId: string, done: boolean): void {
  sendNow({ type: 'set_conversation_done', conversationId, done });
}

/**
 * End all work on a conversation. WebSocket messages are processed in order,
 * so pending work is cleared before the active provider process is stopped.
 */
export function endConversation(conversationId: string): void {
  if (!readConversation(conversationId)) return;
  sendNow({ type: 'clear_queue', conversationId });
  sendNow({ type: 'stop_conversation', conversationId });
}

export function interruptAndSend(conversationId: string, content: string): Promise<void> {
  if (!readConversation(conversationId))
    return Promise.reject(new Error(`Conversation ${conversationId} not found`));
  return sendMessageCommand(conversationId, content, 'interrupt');
}

export function queueMessage(conversationId: string, content: string): Promise<void> {
  return sendMessageCommand(conversationId, content, 'queue');
}

export async function resumeInterruptedMessages(
  conversationId: string,
  messages: readonly string[]
): Promise<void> {
  for (const content of messages) await queueMessage(conversationId, content);
}

export function cancelQueuedMessage(conversationId: string, messageId: string): void {
  sendNow({ type: 'cancel_queued_message', conversationId, messageId });
}

export function promoteQueuedMessage(conversationId: string, messageId: string): void {
  sendNow({ type: 'promote_queued_message', conversationId, messageId });
}

export function clearQueue(conversationId: string): void {
  sendNow({ type: 'clear_queue', conversationId });
}

// =============================================================================
// WebSocket message handlers — one clean handler per ServerMessage variant.
// The dispatcher stays thin (CLAUDE.md D1); work lives in handlers (D2).
// =============================================================================

function handleHello(data: Extract<ServerMessage, { type: 'hello' }>): void {
  jotaiStore.set(archivedBuddyIdsAtom, new Set(data.archivedBuddyIds));
  connectionEpoch += 1;
  transcriptRequests.clear();
  const rows = admitted(decodeRows(data));

  // During startup the server sends an early, possibly empty, hello and
  // hydrates disk conversations via later `rows` batches. Keep the prior
  // epoch's rows until that load completes; otherwise a reload makes the
  // sidebar flash empty and can evict the open conversation while its
  // replacement server is still restoring it.
  const next = data.loading
    ? new Map(jotaiStore.get(rowsAtom))
    : new Map<string, ConversationRow>();
  for (const row of rows) next.set(row.id, row);

  jotaiStore.set(connectionAtom, {
    ...jotaiStore.get(connectionAtom),
    server: { tag: 'v3', defaultCwd: data.defaultCwd, loadComplete: !data.loading },
  });
  jotaiStore.set(rowsAtom, next);
  // Bodies belong to the previous epoch; the open view reloads them.
  jotaiStore.set(transcriptStore.all, new Map());
  loadedOrder.clear();
  chunkBuffer.clear();
  jotaiStore.set(streamStore.all, new Map());
  reconcileCommandsOnHello((id) => next.has(id));
}

function handleRows(data: Extract<ServerMessage, { type: 'rows' }>): void {
  const rows = decodeRows(data);
  putRows(rows);
  // A moved messageCount on a loaded transcript is picked up by the view that
  // shows it (useConversationBodies pages in the tail), not here.
  if (rows.some((row) => row.kind.t === 'buddy')) invalidateBuddyResources();
}

function handleRemoved(data: Extract<ServerMessage, { type: 'removed' }>): void {
  for (const id of data.ids) forgetConversation(id);
}

function forgetConversation(id: string): void {
  // Read before the delete: the Buddy views that cache this conversation can
  // only be identified while the row is still here.
  const deleted = readConversation(id);
  removeConversations([id]);
  if (deleted?.kind.t === 'buddy') invalidateBuddyResources();
  dropCommandsFor(id);
  localStorage.removeItem(`${DRAFT_KEY_PREFIX}${id}`);
  localStorage.removeItem(`${PENDING_FILES_KEY_PREFIX}${id}`);
  clearRestartRecovery(id);
  removeRestartRecoveryAtom(id);
  removeSeenIndex(id);
  forgetConversationAtoms(id);
}

function handleReady(data: Extract<ServerMessage, { type: 'ready' }>): void {
  const authoritative = new Set(data.conversationIds);
  removeConversations(
    Array.from(jotaiStore.get(rowsAtom).keys()).filter((id) => !authoritative.has(id))
  );
  const connection = jotaiStore.get(connectionAtom);
  jotaiStore.set(connectionAtom, {
    ...connection,
    server: { tag: 'v3', defaultCwd: defaultCwdOf(connection.server), loadComplete: true },
  });
}

// Pattern: patches-not-snapshots (docs/patterns.md#patches-not-snapshots)
function handlePatch(data: Extract<ServerMessage, { type: 'patch' }>): void {
  const row = readConversation(data.id);
  if (row) {
    const next = applyRowPatch(row, data.patch);
    if (next !== row) putRows([next]);
  }
  const loaded = readLoaded(data.id);
  if (loaded) {
    const detail = applyDetailPatch(loaded.detail, data.patch);
    if (detail !== loaded.detail) putTranscript(data.id, { ...loaded, detail });
  } else if (data.patch.t === 'attempt') {
    const transcript = readTranscript(data.id);
    if (transcript.tag === 'loading') {
      putTranscript(data.id, { ...transcript, latestAttempt: data.patch.latestAttempt });
    }
  }
  patchEffects(data.id, data.patch);
}

/** What a patch means beyond the field it sets (one handler per variant). */
function patchEffects(id: string, patch: RowPatch): void {
  switch (patch.t) {
    case 'run':
      runChanged(id, patch.run);
      return;
    case 'config':
      if (patch.commandId !== null) settleConfig(patch.commandId);
      return;
    case 'queue':
      captureRestartRecoveryQueue(id, patch.queue);
      return;
    case 'rewritten':
      historyReplaced(id);
      return;
    case 'activity':
    case 'done':
    case 'label':
    case 'session':
    case 'subagent':
    case 'turn':
    case 'attempt':
      return;
  }
}

function runChanged(id: string, run: ConversationRow['run']): void {
  if (run === 'streaming') return;
  // Flush pending chunks first, or a pending rAF re-adds the text we drop.
  flushChunkBuffer();
  // Streaming stopped: the transcript already holds the committed text
  // (chunks and `message_complete` mirror the server's fold).
  jotaiStore.set(streamStore.patch, { set: [], remove: [id] });
}

/**
 * The server replaced this history (same count possible, so bodiesStep would
 * not notice): drop a loaded copy to `absent` and the view that shows it
 * reloads it (useConversationBodies). The WS spine itself never fetches bodies.
 */
function historyReplaced(id: string): void {
  historyGeneration.set(id, (historyGeneration.get(id) ?? 0) + 1);
  if (!readLoaded(id)) return;
  putTranscript(id, { tag: 'absent' });
}

function handleAck(data: Extract<ServerMessage, { type: 'ack' }>): void {
  switch (data.result.t) {
    case 'created':
      creationAcknowledged(data.commandId, decodeRows(data.result.rows));
      return;
    case 'accepted':
      settleAccepted(data.commandId);
      return;
    case 'rejected':
      settleRejected(data.commandId, data.result.error);
      return;
  }
}

function creationAcknowledged(commandId: string, rows: readonly ConversationRow[]): void {
  putRows(rows);
  settleCreate(commandId);
  // A new conversation's bodies are empty; its detail (config) is one request.
  for (const row of rows) void loadConversationDetails(row.id);
  // A Buddy's detail bundle carries its conversation list, so a new Buddy
  // thread makes every cached Buddy view one row out of date.
  if (rows.some((row) => row.kind.t === 'buddy')) invalidateBuddyResources();
}

function handleMessageEvent(data: Extract<ServerMessage, { type: 'message' }>): void {
  if (data.role === 'assistant' && data.body.t === 'parts') {
    // A typed part follows any pending text chunks in the same provider stream.
    // Guard: a tool frame must not hide the prose until message_complete.
    flushChunkBuffer();
    commitStreamSegment(data.conversationId);
  }
  // Bodies are kept only for loaded transcripts; the row's activity patch
  // (sent with every message) carries the count for everyone else.
  const loaded = readLoaded(data.conversationId);
  if (!loaded) return;
  // A duplicate assistant record; the live one is already growing.
  if (
    data.role === 'assistant' &&
    data.body.t === 'text' &&
    data.body.text === '' &&
    loaded.messages.at(-1)?.body.t === 'text' &&
    loaded.messages.at(-1)?.role === 'assistant'
  )
    return;
  putTranscript(data.conversationId, {
    ...loaded,
    messages: [...loaded.messages, { role: data.role, body: data.body, timestamp: new Date() }],
  });
}

/**
 * A history read landed while a reply streams. The server's copy of the reply already holds the
 * chunks it folded before answering, and the stream atom still holds them too, so the view drew
 * them twice (withStreamingTail) and the next tool frame committed the double (#bugfixes
 * 2026-09-29: every Codex DM reply showed each paragraph twice, glued, "…local workBy …").
 * Keep only the chunks the server copy does not have yet; guard: stream-history-refresh.test.ts.
 */
function reconcileStream(id: string, after: Message | undefined): void {
  flushChunkBuffer();
  const streamed = jotaiStore.get(streamStore.byKey(id));
  if (!streamed) return;
  const before = readLoaded(id)?.messages.at(-1);
  const shown = before?.role === 'assistant' && before.body.t === 'text' ? before.body.text : '';
  const server = after?.role === 'assistant' && after.body.t === 'text' ? after.body.text : null;
  // The server moved past this text record (or rewrote it): its snapshot is the whole reply.
  const already = server?.startsWith(shown) ? server.slice(shown.length) : null;
  const rest =
    already !== null && streamed.startsWith(already) ? streamed.slice(already.length) : '';
  jotaiStore.set(
    streamStore.patch,
    rest ? { set: [[id, rest]], remove: [] } : { set: [], remove: [id] }
  );
}

function commitStreamSegment(id: string): void {
  const loaded = readLoaded(id);
  const last = loaded?.messages.at(-1);
  const streamed = jotaiStore.get(streamStore.byKey(id));
  if (!loaded || last?.body.t !== 'text' || !streamed) return;
  putTranscript(id, {
    ...loaded,
    messages: [
      ...loaded.messages.slice(0, -1),
      { ...last, body: { t: 'text', text: last.body.text + streamed } },
    ],
  });
  jotaiStore.set(streamStore.patch, { set: [], remove: [id] });
}

function handleChunk(data: Extract<ServerMessage, { type: 'chunk' }>): void {
  if (data.text.length === 0) return;
  chunkBuffer.set(data.conversationId, (chunkBuffer.get(data.conversationId) ?? '') + data.text);
  scheduleChunkFlush();
}

function handleError(data: Extract<ServerMessage, { type: 'error' }>): void {
  console.error('Server error:', data.message);
  // A generic protocol error must not strand the composer waiting forever or
  // discard the submitted draft.
  rejectSends(new Error(data.message));
}

function handleMessageComplete(data: Extract<ServerMessage, { type: 'message_complete' }>): void {
  // message_complete can arrive in the same tick as the last chunk, before rAF.
  flushChunkBuffer();
  commitStreamedReply(data.conversationId, data.reason ?? 'success');
  const remaining = readConversationDetail(data.conversationId)?.queue.filter(
    (message) => message.status === 'pending'
  );
  if (remaining?.length) captureRestartRecoveryQueue(data.conversationId, remaining);
  else clearRestartRecovery(data.conversationId);
}

/** Fold the streamed text into the last assistant message, as the server did. */
function commitStreamedReply(id: string, reason: NonNullable<Message['completionReason']>): void {
  const loaded = readLoaded(id);
  const last = loaded?.messages.at(-1);
  if (!loaded || last?.role !== 'assistant') return;
  const streamed = jotaiStore.get(streamStore.byKey(id));
  putTranscript(id, {
    ...loaded,
    messages: [
      ...loaded.messages.slice(0, -1),
      {
        ...last,
        body: last.body.t === 'text' ? { t: 'text', text: last.body.text + streamed } : last.body,
        completedAt: last.completedAt ?? new Date(),
        completionReason: last.completionReason ?? reason,
      },
    ],
  });
  jotaiStore.set(streamStore.patch, { set: [], remove: [id] });
}

function handleBuddyArchived(buddyId: string): void {
  hideArchivedBuddy(buddyId);
  const ids = Array.from(jotaiStore.get(rowsAtom).values())
    .filter((row) => row.kind.t === 'buddy' && row.kind.buddyId === buddyId)
    .map((row) => row.id);
  removeConversations(ids);
}

// =============================================================================
// Thin dispatcher (D1)
// =============================================================================

export function handleMessage(data: ServerMessage): void {
  switch (data.type) {
    case 'buddy_archived':
      handleBuddyArchived(data.buddyId);
      return;
    case 'buddies_changed':
      invalidateBuddyResources();
      return;
    case 'channel_changed':
      invalidateChannelResources(data.channelId);
      return;
    case 'hello':
      handleHello(data);
      return;
    case 'rows':
      handleRows(data);
      return;
    case 'removed':
      handleRemoved(data);
      return;
    case 'ready':
      handleReady(data);
      return;
    case 'patch':
      handlePatch(data);
      return;
    case 'ack':
      handleAck(data);
      return;
    case 'message':
      handleMessageEvent(data);
      return;
    case 'chunk':
      handleChunk(data);
      return;
    case 'error':
      handleError(data);
      return;
    case 'message_complete':
      handleMessageComplete(data);
      return;
  }
}
