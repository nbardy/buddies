import crypto from 'node:crypto';
import type {
  BuddyContext,
  ClientMessage,
  CommandError,
  ConversationKind,
  ConversationRow,
  CreateKind,
} from '@unleashd/shared';
import {
  CHAT_KIND,
  PROTOCOL_MISMATCH_CLOSE_CODE,
  PROTOCOL_VERSION,
  buddyKind,
  encodeRows,
  kindBuddyContext,
  requestedProtocol,
  safeParseClientMessage,
} from '@unleashd/shared';
import { WebSocket, type WebSocketServer } from 'ws';
import type {
  CompletionSuppression,
  ConversationRegistry,
  ExternalActivity,
  SessionTracking,
} from '../application/context';
import { ConfigRevisionConflictError } from '../conversations/config-records';
import {
  type ConversationConfigService,
  ConversationTombstonedError,
} from '../conversations/config-service';
import { createConversationService } from '../conversations/creation-service';
import type {
  ConversationBroadcast,
  ConversationOptions,
  ConversationRuntime,
} from '../conversations/runtime';
import { updateRuntimeConfig } from '../conversations/runtime-config';
import { noteActivity } from '../observability/event-loop-stall';
import type { OwnerInput } from '../turns/input';
import {
  sendAck,
  sendCommandAccepted,
  sendCommandRejected,
  sendProtocolError,
  sendToClient,
  validateWorkingDirectory,
} from './websocket';

export interface ResolvedBuddyConversation {
  context: BuddyContext;
  briefing: string;
  workingDirectory: string;
}

export interface ConversationWebSocketDependencies {
  registry: ConversationRegistry<ConversationRuntime>;
  /** Rows of listed conversations the registry does not hold; `hello` adds registry rows. */
  listedRows(): ConversationRow[];
  /** A listed conversation's runtime, built from its record on first use. */
  materialize(conversationId: string): Promise<unknown>;
  /** A deleted conversation leaves the ingest list too (its record is tombstoned). */
  forgetListed(conversationId: string): void;
  sessions: SessionTracking;
  externalActivity: ExternalActivity;
  completionSuppression: CompletionSuppression;
  initialLoadComplete: Promise<void>;
  isInitialLoadComplete(): boolean;
  /** One command as counted active work (also while `starting`); null once draining. */
  beginCommand(): (() => void) | null;
  configService: ConversationConfigService;
  getArchivedBuddyIds?(): Promise<string[]>;
  isBuddyArchived?(buddyId: string): Promise<boolean>;
  getDefaultWorkingDirectory(): string;
  resolveWorkingDirectory(input: string): string;
  resolveBuddyConversation(context: BuddyContext): Promise<ResolvedBuddyConversation>;
  createConversation(options: ConversationOptions): ConversationRuntime;
  createConversationLink(conversation: ConversationRuntime): Promise<void>;
  cancelBuddyConversation(conversation: ConversationRuntime): void;
  dispatchInitialMessage(
    conversation: ConversationRuntime,
    options?: { ownerInput: OwnerInput }
  ): Promise<void>;
  broadcast(data: ConversationBroadcast): void;
  broadcastExcept(excludedClient: WebSocket, data: ConversationBroadcast): void;
  logger?: Pick<Console, 'error' | 'log'>;
}

export function registerConversationWebSocket(
  webSocketServer: WebSocketServer,
  dependencies: ConversationWebSocketDependencies
): void {
  const createOrReuse = createConversationService({
    configService: dependencies.configService,
    getConversation: (id) => dependencies.registry.get(id),
    createConversation: dependencies.createConversation,
    registerConversation: (conversation) => dependencies.registry.set(conversation),
    createConversationLink: dependencies.createConversationLink,
  });
  webSocketServer.on('connection', (socket, request) => {
    const logger = dependencies.logger ?? console;
    // Another protocol cannot read these frames: a typed close, not a list that stops updating.
    if (requestedProtocol(request.url ?? '/') !== PROTOCOL_VERSION) {
      socket.close(PROTOCOL_MISMATCH_CLOSE_CODE, `protocol ${PROTOCOL_VERSION}`);
      return;
    }
    void sendInitialState(socket, dependencies).catch((error) =>
      logger.error('Initial state failed', error)
    );

    socket.on('message', async (message) => {
      let activeCommand: { commandId: string; conversationId?: string } | null = null;
      let releaseCommand: (() => void) | null = null;
      const reject = (error: CommandError) =>
        activeCommand
          ? sendCommandRejected(socket, { ...activeCommand, error })
          : sendProtocolError(socket, error.message);
      try {
        const parsed: unknown = JSON.parse(message.toString());
        const result = safeParseClientMessage(parsed);
        if (!result.success) {
          rejectInvalidMessage(socket, parsed, result.error.issues, logger);
          return;
        }

        const data = result.data;
        noteActivity(`ws ${data.type}`);
        if ('commandId' in data) {
          activeCommand = {
            commandId: data.commandId,
            ...('conversationId' in data ? { conversationId: data.conversationId } : {}),
          };
        }
        const rejectDraining = () =>
          reject({
            code: 'server_draining',
            message: 'Backend reload is draining active turns; try again after reconnecting',
          });
        // The slot is taken BEFORE the barrier, and the barrier resolving does not mean
        // success (docs/ws-contract-surprises.md; guard "a command parked on the startup barrier…").
        releaseCommand = dependencies.beginCommand();
        if (!releaseCommand) {
          rejectDraining();
          return;
        }
        // A create cannot collide with history, so only other commands wait for it.
        if (data.type !== 'create_conversation') {
          await dependencies.initialLoadComplete;
          if (socket.readyState !== WebSocket.OPEN) return;
          if (!dependencies.isInitialLoadComplete()) {
            rejectDraining();
            return;
          }
        }
        if ('conversationId' in data && data.type !== 'create_conversation') {
          await dependencies.materialize(data.conversationId);
        }
        const target =
          'conversationId' in data ? dependencies.registry.get(data.conversationId) : undefined;
        const targetBuddy = target ? kindBuddyContext(target.kind) : null;
        if (targetBuddy && (await dependencies.isBuddyArchived?.(targetBuddy.buddyId))) {
          throw new Error('Buddy is archived');
        }
        logCommand(data, logger);

        switch (data.type) {
          case 'create_conversation': {
            const rejectCreate = (error: unknown) => {
              logger.error('Conversation creation failed', error);
              reject({ code: 'create_failed', message: replayFailureMessage(error) });
            };
            let buddyResolution: ResolvedBuddyConversation | null = null;
            try {
              buddyResolution =
                data.kind.t === 'buddy'
                  ? await dependencies.resolveBuddyConversation(data.kind.context)
                  : null;
            } catch (error) {
              rejectCreate(error);
              break;
            }

            const workingDirectory = dependencies.resolveWorkingDirectory(
              buddyResolution?.workingDirectory ?? data.workingDirectory
            );
            const kind = createdKind(data.kind, buddyResolution, (id) =>
              dependencies.registry.get(id)
            );
            const buddy = kindBuddyContext(kind);
            if (buddy && (await dependencies.isBuddyArchived?.(buddy.buddyId))) {
              throw new Error('Buddy is archived');
            }
            try {
              const persisted = await dependencies.configService.getRecord(data.conversationId);
              if (!persisted) {
                const directoryError = validateWorkingDirectory(workingDirectory);
                if (directoryError) {
                  reject(directoryError);
                  break;
                }
              }

              const conversation = await createOrReuse({
                conversationId: data.conversationId,
                commandId: data.commandId,
                workingDirectory,
                config: data.config,
                initialMessage: data.initialMessage,
                swarmDebugPrefix: data.swarmDebugPrefix,
                resumedFromConversationId: data.kind.t === 'fork' ? data.kind.from : undefined,
                kind,
                buddyBriefing: buddyResolution?.briefing,
              });
              const rows = encodeRows([conversation.toRow()]);
              sendAck(socket, data.commandId, { t: 'created', rows });
              dependencies.broadcastExcept(socket, { type: 'rows', ...rows });
              await dependencies.dispatchInitialMessage(conversation, {
                ownerInput: { origin: 'owner_input', inputId: data.commandId },
              });
            } catch (error) {
              // By error type: a replay can send `created` then `rejected`
              // (docs/ws-contract-surprises.md#replay-of-create_conversation…).
              rejectCreate(error);
            }
            break;
          }

          case 'stop_conversation':
            dependencies.registry.get(data.conversationId)?.stop();
            break;

          case 'delete_conversation': {
            const conversation = dependencies.registry.get(data.conversationId);
            const deletedDurably = await dependencies.configService.delete(data.conversationId);
            if (conversation) {
              conversation.stop();
              // stop() closes Buddy ownership only while a process runs; an idle thread's
              // durable link (and delegated/review work) is terminalized here.
              dependencies.cancelBuddyConversation(conversation);
              dependencies.registry.delete(data.conversationId);
              dependencies.sessions.markDeleted(conversation.sessionId);
              for (const [sessionId, conversationId] of dependencies.sessions.aliasEntries()) {
                if (conversationId === conversation.id) {
                  dependencies.sessions.markDeleted(sessionId);
                }
              }
              dependencies.sessions.unregisterConversationAliases(conversation.id);
              dependencies.externalActivity.clear(conversation.sessionId, conversation.id);
              dependencies.completionSuppression.clear(conversation.sessionId, conversation.id);
            }
            dependencies.forgetListed(data.conversationId);
            if (conversation || deletedDurably) {
              dependencies.broadcast({ type: 'removed', ids: [data.conversationId] });
            }
            break;
          }

          case 'set_conversation_done': {
            const conversation = dependencies.registry.get(data.conversationId);
            if (!conversation) {
              sendProtocolError(
                socket,
                `Conversation ${data.conversationId} is not open on this server`
              );
              break;
            }
            const record = await dependencies.configService.setDone(data.conversationId, data.done);
            if (!record) throw new Error(`Conversation ${data.conversationId} has no record`);
            conversation.done = record.done;
            // Pattern: patches-not-snapshots (docs/patterns.md#patches-not-snapshots)
            // v2 re-sent the conversation: 1.36 MB for a 1,099-message chat (2026-09-25).
            // Guard: wire-v3.test.ts "a done toggle sends one small patch".
            dependencies.broadcast({
              type: 'patch',
              id: conversation.id,
              patch: { t: 'done', done: record.done },
            });
            break;
          }

          case 'set_conversation_config': {
            const conversation = dependencies.registry.get(data.conversationId);
            if (!conversation) {
              reject({ code: 'conversation_not_found', message: 'Conversation not found' });
              break;
            }
            const result = await updateRuntimeConfig(
              dependencies.configService,
              conversation,
              data
            );
            if (!result.ok) {
              // The authoritative state first, to the requester only, then the error.
              sendToClient(socket, {
                type: 'patch',
                id: conversation.id,
                patch: { t: 'config', state: conversation.configState(), commandId: null },
              });
              reject(result.error);
              break;
            }
            // The patch carrying this commandId is the requester's acknowledgement.
            dependencies.broadcast({
              type: 'patch',
              id: conversation.id,
              patch: { t: 'config', state: conversation.configState(), commandId: data.commandId },
            });
            break;
          }

          // A missing runtime is a REJECTION, never an acceptance: the composer already
          // emptied (docs/ws-contract-surprises.md, silent drop).
          case 'queue_message':
          case 'interrupt_and_send': {
            const conversation = dependencies.registry.get(data.conversationId);
            if (!conversation) {
              reject({
                code: 'conversation_not_found',
                message: `Conversation ${data.conversationId} is not open on this server`,
              });
              break;
            }
            await createOrReuse.ensureReady(conversation);
            const ownerInput = {
              origin: 'owner_input',
              inputId: crypto.randomUUID(),
            } as const;
            if (data.type === 'queue_message')
              conversation.enqueueMessage(data.content, ownerInput);
            else conversation.interruptAndSend(data.content, ownerInput);
            sendCommandAccepted(socket, { commandId: data.commandId });
            break;
          }
          case 'cancel_queued_message':
            dependencies.registry.get(data.conversationId)?.cancelQueuedMessage(data.messageId);
            break;
          case 'promote_queued_message':
            dependencies.registry.get(data.conversationId)?.promoteQueuedMessage(data.messageId);
            break;
          case 'clear_queue':
            dependencies.registry.get(data.conversationId)?.clearQueue();
            break;
        }
      } catch (error) {
        logger.error('Error handling WebSocket message:', error);
        if (activeCommand) {
          sendCommandRejected(socket, {
            ...activeCommand,
            error: { code: 'command_failed', message: errorMessage(error) },
          });
        } else {
          sendProtocolError(socket, `Failed to handle message: ${errorMessage(error)}`);
        }
      } finally {
        releaseCommand?.();
      }
    });
  });
}

async function sendInitialState(
  socket: WebSocket,
  dependencies: ConversationWebSocketDependencies
): Promise<void> {
  const archivedBuddyIds = dependencies.getArchivedBuddyIds
    ? await dependencies.getArchivedBuddyIds()
    : [];
  if (socket.readyState !== WebSocket.OPEN) return;
  // Rows only; v2's `init` carried everything (1.87 MB for 1,161 conversations, 2026-09-25).
  // Guard: wire-v3.test.ts "hello stays inside its per-row budget".
  sendToClient(socket, {
    type: 'hello',
    protocol: { version: PROTOCOL_VERSION },
    defaultCwd: dependencies.getDefaultWorkingDirectory(),
    loading: !dependencies.isInitialLoadComplete(),
    archivedBuddyIds,
    ...encodeRows([
      ...Array.from(dependencies.registry.values(), (conversation) =>
        externallyRunning(conversation.toRow(), conversation, dependencies.externalActivity)
      ),
      ...dependencies.listedRows(),
    ]),
  });
}

/** A transcript another process is writing shows as running. */
function externallyRunning(
  row: ConversationRow,
  conversation: { id: string; sessionId: string },
  externalActivity: ExternalActivity
): ConversationRow {
  return row.run === 'idle' &&
    (externalActivity.has(conversation.sessionId) || externalActivity.has(conversation.id))
    ? { ...row, run: 'running' }
    : row;
}

/**
 * The kind a create command gets: a thin dispatcher over what it asked for.
 * A fork inherits its source's kind (the client holds only the source's row);
 * a fork of a conversation this server no longer holds is a plain chat.
 */
function createdKind(
  requested: CreateKind,
  buddy: ResolvedBuddyConversation | null,
  getConversation: (id: string) => { kind: ConversationKind } | undefined
): ConversationKind {
  switch (requested.t) {
    case 'chat':
      return CHAT_KIND;
    case 'buddy':
      if (!buddy) throw new Error('Buddy conversation was not resolved');
      return buddyKind(buddy.context);
    case 'fork':
      return getConversation(requested.from)?.kind ?? CHAT_KIND;
  }
}

function rejectInvalidMessage(
  socket: WebSocket,
  parsed: unknown,
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
  logger: Pick<Console, 'error'>
): void {
  const issueSummary = issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
  logger.error(`[WS] Invalid client message: ${issueSummary}`);
  const commandId =
    typeof parsed === 'object' && parsed !== null && 'commandId' in parsed
      ? parsed.commandId
      : null;
  if (typeof commandId === 'string' && commandId) {
    sendCommandRejected(socket, {
      commandId,
      error: { code: 'invalid_message', message: `Invalid message: ${issueSummary}` },
    });
  } else {
    sendProtocolError(socket, `Invalid message: ${issueSummary}`);
  }
}

function logCommand(data: ClientMessage, logger: Pick<Console, 'log'>): void {
  if (data.type === 'queue_message') {
    logger.log(
      `[WS] Received queue_message conversationId=${data.conversationId}, contentLen=${data.content.length}, preview="${formatLogPreview(data.content)}"`
    );
    return;
  }
  logger.log(`[WS] Received message type: ${data.type}`, JSON.stringify(data).substring(0, 200));
}

function formatLogPreview(content: string, maximumCharacters = 140): string {
  return content.replace(/\s+/g, ' ').slice(0, maximumCharacters);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A failed create/replay's message, by error type (docs/ws-contract-surprises.md, 2026-09-06). */
function replayFailureMessage(error: unknown): string {
  if (error instanceof ConfigRevisionConflictError) {
    return 'Conversation ID already exists with different configuration';
  }
  if (error instanceof ConversationTombstonedError) return error.message;
  return errorMessage(error);
}
