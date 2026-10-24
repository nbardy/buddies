import type {
  ClientMessage,
  CreateConversationCommand,
  SetConversationConfigCommand,
} from '@unleashd/shared';
import { newId } from '../utils/ids';
import {
  type Command,
  type CommandState,
  type ConfigCommand,
  type CreateArgs,
  type CreateCommand,
  type SendCommand,
  commandsAtom,
  connectionAtom,
} from './conversations';
import { jotaiStore } from './store';

// =============================================================================
// Commands: create, set_config and send, one Map (commandsAtom), settled by
// the server's `ack` or a config patch carrying the commandId. Pending
// creations are in memory only (O5, T19): a reconnect resends them with their
// original ids (the server dedupes), and the first message of a create lost
// to a full page reload survives in the `draft:<id>` key.
// =============================================================================

export type { CreateArgs } from './conversations';
export type SendOutcome = 'sent' | 'closed';

/** Send one frame now. A closed socket is an outcome the caller handles. */
export function sendNow(message: ClientMessage): SendOutcome {
  const { socket } = jotaiStore.get(connectionAtom);
  switch (socket.tag) {
    case 'open':
      socket.send(message);
      return 'sent';
    case 'connecting':
    case 'closed':
      return 'closed';
  }
}

function putCommand(command: Command): void {
  jotaiStore.set(
    commandsAtom,
    new Map(jotaiStore.get(commandsAtom)).set(command.commandId, command)
  );
}

function dropCommands(keep: (command: Command) => boolean): void {
  const current = jotaiStore.get(commandsAtom);
  const next = new Map([...current].filter(([, command]) => keep(command)));
  if (next.size !== current.size) jotaiStore.set(commandsAtom, next);
}

export function normalizeWorkingDirectory(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  if (trimmed.startsWith('~')) return trimmed.replace(/\/+$/, '') || '~';

  const withSingleSlashes = trimmed.replace(/\/+/g, '/');
  const hasLeadingSlash = withSingleSlashes.startsWith('/');
  const normalized: string[] = [];
  for (const segment of withSingleSlashes.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      normalized.pop();
      continue;
    }
    normalized.push(segment);
  }

  if (hasLeadingSlash) {
    const rootPath = `/${normalized.join('/')}`;
    return rootPath === '/' ? '/' : rootPath.replace(/\/+$/, '');
  }
  return normalized.join('/') || '.';
}

// -----------------------------------------------------------------------------
// create_conversation
// -----------------------------------------------------------------------------

function sendCreate(command: CreateCommand): void {
  const message: CreateConversationCommand = {
    type: 'create_conversation',
    commandId: command.commandId,
    conversationId: command.conversationId,
    workingDirectory: command.args.workingDirectory,
    config: command.args.config,
    initialMessage: command.args.initialMessage,
    swarmDebugPrefix: command.args.swarmDebugPrefix,
    kind: command.args.kind,
  };
  // Closed: the command stays `sent` and `resendOnHello` delivers it.
  sendNow(message);
}

/** Start a conversation. Returns its id; the caller navigates to it. */
export function createConversation(args: CreateArgs): string {
  const command: CreateCommand = {
    tag: 'create',
    commandId: newId(),
    conversationId: newId(),
    args: { ...args, workingDirectory: normalizeWorkingDirectory(args.workingDirectory) },
    createdAt: Date.now(),
    state: { tag: 'sent' },
  };
  putCommand(command);
  sendCreate(command);
  return command.conversationId;
}

const RETRYABLE_CREATION_CODES = new Set(['server_draining', 'server_starting']);

/**
 * A reconnect is a new authoritative server epoch. Admission failures from the
 * previous draining/starting epoch are retried with the original idempotency
 * ids; validation and provider failures stay failed.
 */
export function stateAfterReconnect(state: CommandState): CommandState {
  switch (state.tag) {
    case 'sent':
      return state;
    case 'rejected':
      return RETRYABLE_CREATION_CODES.has(state.code) ? { tag: 'sent' } : state;
  }
}

// -----------------------------------------------------------------------------
// set_conversation_config
// -----------------------------------------------------------------------------

export interface SetConversationConfigArgs {
  conversationId: string;
  expectedRevision: number;
  patch: SetConversationConfigCommand['patch'];
}

export function setConversationConfig({
  conversationId,
  expectedRevision,
  patch,
}: SetConversationConfigArgs): string {
  // A new attempt replaces an earlier failed one for the same conversation.
  dropCommands(
    (command) =>
      !(
        command.tag === 'set_config' &&
        command.conversationId === conversationId &&
        command.state.tag === 'rejected'
      )
  );
  const command: ConfigCommand = {
    tag: 'set_config',
    commandId: newId(),
    conversationId,
    baseRevision: expectedRevision,
    patch,
    state: { tag: 'sent' },
  };
  const outcome = sendNow({
    type: 'set_conversation_config',
    commandId: command.commandId,
    conversationId,
    expectedRevision,
    patch,
  });
  putCommand(
    outcome === 'sent'
      ? command
      : { ...command, state: { tag: 'rejected', code: 'closed', message: 'Not connected' } }
  );
  return command.commandId;
}

// -----------------------------------------------------------------------------
// queue_message / interrupt_and_send: the composer awaits the exact ack.
// -----------------------------------------------------------------------------

export function sendMessageCommand(
  conversationId: string,
  content: string,
  mode: SendCommand['mode']
): Promise<void> {
  const commandId = newId();
  return new Promise<void>((resolve, reject) => {
    const outcome = sendNow({
      type: mode === 'queue' ? 'queue_message' : 'interrupt_and_send',
      conversationId,
      content,
      commandId,
    });
    if (outcome === 'closed') {
      reject(new Error('Not connected; the message was not sent'));
      return;
    }
    putCommand({
      tag: 'send',
      commandId,
      conversationId,
      content,
      mode,
      settle: { resolve, reject },
    });
  });
}

// -----------------------------------------------------------------------------
// Settlement (called from the WS spine, actions.ts)
// -----------------------------------------------------------------------------

/** A conversation's create landed (its rows arrived with the ack). */
export function settleCreate(commandId: string): void {
  dropCommands((command) => command.commandId !== commandId);
}

/** A config patch carried this commandId: the write landed. */
export function settleConfig(commandId: string): void {
  dropCommands((command) => command.commandId !== commandId);
}

export function settleAccepted(commandId: string): void {
  const command = jotaiStore.get(commandsAtom).get(commandId);
  if (command?.tag !== 'send') return;
  dropCommands((other) => other !== command);
  command.settle.resolve();
}

export function settleRejected(commandId: string, error: { code: string; message: string }): void {
  const command = jotaiStore.get(commandsAtom).get(commandId);
  if (!command) return;
  switch (command.tag) {
    case 'send':
      dropCommands((other) => other !== command);
      command.settle.reject(new Error(error.message));
      return;
    case 'create':
    case 'set_config':
      putCommand({ ...command, state: { tag: 'rejected', ...error } });
      return;
  }
}

/** Reject every in-flight send (socket epoch ended, or a generic server error). */
export function rejectSends(error: Error): void {
  const sends = [...jotaiStore.get(commandsAtom).values()].filter(
    (command): command is SendCommand => command.tag === 'send'
  );
  if (sends.length === 0) return;
  dropCommands((command) => command.tag !== 'send');
  for (const command of sends) command.settle.reject(error);
}

/**
 * A `hello` opened a new server epoch:
 * - sends are rejected (the composer keeps its text; the user retries);
 * - config commands are dropped: they are revision-checked and their result
 *   is already in the detail, so a lost ack must not leave "Saving…" forever;
 * - creates the server now holds are settled, the rest are resent with their
 *   original ids (retryable rejections become `sent` again).
 */
export function reconcileCommandsOnHello(held: (conversationId: string) => boolean): void {
  rejectSends(new Error('Connection restarted before the message was accepted'));
  const next = new Map<string, Command>();
  const resend: CreateCommand[] = [];
  for (const command of jotaiStore.get(commandsAtom).values()) {
    if (command.tag !== 'create' || held(command.conversationId)) continue;
    const state = stateAfterReconnect(command.state);
    const retried = state === command.state ? command : { ...command, state };
    next.set(command.commandId, retried);
    if (retried.state.tag === 'sent') resend.push(retried);
  }
  jotaiStore.set(commandsAtom, next);
  for (const command of resend) sendCreate(command);
}

/** Forget commands for a removed conversation. */
export function dropCommandsFor(conversationId: string): void {
  dropCommands((command) => command.conversationId !== conversationId);
}
