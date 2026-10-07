import type {
  ClientMessage,
  ConversationConfig,
  ConversationConfigPatch,
  ConversationDetail,
  ConversationRow,
  CreateKind,
  Message,
  QueuedMessage,
  SubAgent,
  TurnAttemptSnapshot,
} from '@unleashd/shared';
import { type Atom, atom } from 'jotai';
import { atomFamily } from 'jotai-family';
import { selectAtom } from 'jotai/utils';
import {
  type MessageGroup,
  groupChatMessages,
  regroupChatMessages,
  withStreamingTail,
} from '../utils/chat-message-groups';
import {
  type ConversationIndex,
  EMPTY_CONVERSATION_INDEX,
  type ListIndex,
  buildListIndex,
  reuseUnchangedFields,
  updateConversationIndex,
} from './conversation-index';
import { atomWithPrevious, keyedAtoms, stableAtom } from './structural';
import { hasUnseenAfter, prefsAtom, seenAtom } from './ui';

export type {
  ConversationListEntry,
  ListIndex,
} from './conversation-index';

// =============================================================================
// Client state core (06-target-client §1.3). Base atoms:
//   connectionAtom · rows (rowsAtom/rowFamily) · transcripts · streams ·
//   commandsAtom — plus prefs/seen (ui.ts), the resource cache (resources.ts)
//   and the channel outbox (channel-outbox.ts).
// Derived: rowFamily · listIndexAtom · groupsFamily · commandFor · unreadFamily.
//
// Writes go through actions.ts / commands.ts (jotaiStore.set lives in
// atoms/, gate G1). Components subscribe per id, or to one index field via
// `listField`, never to the whole row map (AGENTS.md).
//
// §5 #10 — jotai-family memoizes per-id atoms forever; `forgetConversationAtoms`
// frees them when a conversation is removed (PWA sessions are long).
// =============================================================================

function labelled<T extends { debugLabel?: string }>(value: T, label: string): T {
  value.debugLabel = label;
  return value;
}

// -----------------------------------------------------------------------------
// Connection
// -----------------------------------------------------------------------------

/** The socket. A send while not open is a typed outcome, never a silent drop. */
export type Socket =
  | { tag: 'connecting' }
  | { tag: 'open'; send: (message: ClientMessage) => void }
  | { tag: 'closed' };

/**
 * What the server told us. `skew`: it speaks another protocol version (a dev
 * reload in progress: Vite serves this client before the backend restarts);
 * the rows stay and the socket reconnects until a v3 `hello` arrives.
 * `outdated`: the server is NEWER and closed the socket; this tab runs stale
 * code, so it stops reconnecting and asks for a reload (UpdateBanner).
 */
export type ServerState =
  | { tag: 'unknown' }
  | { tag: 'skew'; serverVersion: number }
  | { tag: 'outdated'; serverVersion: number }
  | { tag: 'v3'; defaultCwd: string; loadComplete: boolean };

export interface Connection {
  socket: Socket;
  server: ServerState;
}

// One atom replaces wsStatusAtom + sendFnAtom (whose default `send` was a
// no-op: a silent fallback) + protocolMismatchAtom + defaultCwdAtom +
// conversationLoadCompleteAtom. It changes only on connect, close and hello.
export const connectionAtom = atom<Connection>({
  socket: { tag: 'connecting' },
  server: { tag: 'unknown' },
});

export function defaultCwdOf(server: ServerState): string {
  switch (server.tag) {
    case 'v3':
      return server.defaultCwd;
    case 'unknown':
    case 'skew':
    case 'outdated':
      return '';
  }
}

/** True once the server's authoritative conversation list has arrived. */
export function loadCompleteOf(server: ServerState): boolean {
  switch (server.tag) {
    case 'v3':
      return server.loadComplete;
    case 'unknown':
    case 'skew':
    case 'outdated':
      return false;
  }
}

// -----------------------------------------------------------------------------
// Rows + the list index
// Pattern: one-store-one-index (docs/patterns.md#one-store-one-index)
//
// The authoritative list ROWS (protocol v3: list fields only, no bodies). Each
// write sets only the per-id atoms it touched and moves the list index in the
// same step, so an event about conversation A does no work for B (03-app-core
// §6.2 #7). Archived Buddies' rows never enter (filtered at ingestion in
// actions.ts), so no reader filters them again.
// -----------------------------------------------------------------------------

const conversationIndexAtom = atom<ConversationIndex>(EMPTY_CONVERSATION_INDEX);

export const rowStore = keyedAtoms<ConversationRow, null>({
  label: 'row',
  absent: null,
  onCommit: (get, set, next, changed) =>
    set(conversationIndexAtom, updateConversationIndex(get(conversationIndexAtom), next, changed)),
});

/** Every row by id — imperative reads and tests only; components use rowFamily. */
export const rowsAtom = rowStore.all;
/** One conversation's row; null when the client does not hold it. */
export const rowFamily = rowStore.byKey;

const promotedSetAtom = stableAtom(
  (get) => new Set(get(prefsAtom).promotedWorkers) as ReadonlySet<string>,
  (a, b) => a.size === b.size && [...a].every((id) => b.has(id))
);

/** Every collection view, one pass per list move (see conversation-index.ts). */
export const listIndexAtom = atomWithPrevious((get, previous: ListIndex | undefined) => {
  const next = buildListIndex(get(conversationIndexAtom).list, get(promotedSetAtom), Date.now());
  return previous ? reuseUnchangedFields(previous, next) : next;
});

const listFields = new Map<keyof ListIndex, Atom<unknown>>();

/**
 * One field of the list index. Fields keep their identity while their content
 * is unchanged, so a subscriber re-renders only when ITS view moved.
 */
export function listField<K extends keyof ListIndex>(key: K): Atom<ListIndex[K]> {
  let field = listFields.get(key);
  if (!field) {
    field = labelled(
      selectAtom(listIndexAtom, (index) => index[key]),
      `listIndex.${key}`
    );
    listFields.set(key, field);
  }
  return field as Atom<ListIndex[K]>;
}

const NO_ROWS: readonly ConversationRow[] = [];

/** A parent's child-session rows, oldest first (the sub-agent panel). */
export const childRowsFamily = atomFamily((parentId: string) =>
  labelled(
    atom((get): readonly ConversationRow[] => {
      const ids = get(listField('childrenOf')).get(parentId);
      return ids ? ids.flatMap((id) => get(rowFamily(id)) ?? []) : NO_ROWS;
    }),
    `childRows:${parentId}`
  )
);

// -----------------------------------------------------------------------------
// Transcripts: loaded on demand (GET /api/conversations/:id + /messages)
// -----------------------------------------------------------------------------

/**
 * One conversation's bodies. `loaded` holds every message the server had at
 * `epoch` plus live `message` events appended since, and the detail
 * (config, queue, sub-agents), which detail-level patches keep current. A row
 * whose messageCount differs from `messages.length` makes the open view page
 * in its tail (useConversationBodies).
 */
export type Transcript =
  | { tag: 'absent' }
  | { tag: 'loading'; latestAttempt?: TurnAttemptSnapshot | null }
  | {
      tag: 'loaded';
      epoch: number;
      messages: readonly Message[];
      detail: ConversationDetail;
    }
  | { tag: 'failed'; error: string };

export type LoadedTranscript = Extract<Transcript, { tag: 'loaded' }>;

const ABSENT: Transcript = { tag: 'absent' };

export const transcriptStore = keyedAtoms<Transcript, Transcript>({
  label: 'transcript',
  absent: ABSENT,
});
export const transcriptFamily = transcriptStore.byKey;

/** The loaded transcript, or null (absent / loading / failed). */
export function loadedOf(transcript: Transcript): LoadedTranscript | null {
  switch (transcript.tag) {
    case 'loaded':
      return transcript;
    case 'absent':
    case 'loading':
    case 'failed':
      return null;
  }
}

const EMPTY_MESSAGES: readonly Message[] = [];
const EMPTY_QUEUE: readonly QueuedMessage[] = [];
const EMPTY_SUB_AGENTS: readonly SubAgent[] = [];

export const messagesOf = (t: Transcript) => loadedOf(t)?.messages ?? EMPTY_MESSAGES;
export const detailOf = (t: Transcript) => loadedOf(t)?.detail ?? null;
export const queueOf = (t: Transcript) => loadedOf(t)?.detail.queue ?? EMPTY_QUEUE;
export const subAgentsOf = (t: Transcript) => loadedOf(t)?.detail.subAgents ?? EMPTY_SUB_AGENTS;

// -----------------------------------------------------------------------------
// Streaming text — per conversation, so a frame for A touches only A's atom
// (the plain Map form was copied every frame and recomputed every reader).
// -----------------------------------------------------------------------------

export const streamStore = keyedAtoms<string, ''>({ label: 'stream', absent: '' });
export const streamFamily = streamStore.byKey;

interface SettledGroups {
  messages: readonly Message[];
  prefix: string | null;
  groups: MessageGroup[];
}

// Groups of the committed records. A new record (or a grown last response)
// rebuilds only the last group; earlier groups keep their identity. A detail
// patch (queue, sub-agent) changes the transcript but not `messages`, so it
// returns the previous value.
const settledGroupsFamily = atomFamily((id: string) =>
  atomWithPrevious((get, previous: SettledGroups | undefined): SettledGroups => {
    const transcript = get(transcriptFamily(id));
    const messages = messagesOf(transcript);
    // Swarm debug prefix stripped from the first user record (chat kinds only).
    const prefix = detailOf(transcript)?.swarmDebugPrefix ?? null;
    if (previous && previous.messages === messages && previous.prefix === prefix) return previous;
    const groups =
      previous && previous.prefix === prefix
        ? regroupChatMessages(previous.groups, previous.messages, messages, prefix)
        : groupChatMessages(messages, prefix);
    return { messages, prefix, groups };
  })
);

// While a reply streams (~60 frames a second) only the last group is rebuilt:
// every other group is the settled object, so TranscriptGroup skips.
export const groupsFamily = atomFamily((id: string) =>
  labelled(
    atom((get) => {
      const settled = get(settledGroupsFamily(id));
      return withStreamingTail(
        settled.groups,
        settled.messages,
        get(streamFamily(id)),
        settled.prefix
      );
    }),
    `groups:${id}`
  )
);

// -----------------------------------------------------------------------------
// Commands: client-owned, in flight until the server acknowledges them.
// A pending create is not a partial row; it lives here, never in rowsAtom.
// -----------------------------------------------------------------------------

export type CommandState = { tag: 'sent' } | { tag: 'rejected'; code: string; message: string };

export interface CreateArgs {
  workingDirectory: string;
  config: ConversationConfig;
  /** chat | buddy{context} | fork{from}: the one kind encoding (T09). */
  kind: CreateKind;
  initialMessage?: string;
  swarmDebugPrefix?: string;
}

export interface CreateCommand {
  tag: 'create';
  commandId: string;
  conversationId: string;
  args: CreateArgs;
  createdAt: number;
  state: CommandState;
}

export interface ConfigCommand {
  tag: 'set_config';
  commandId: string;
  conversationId: string;
  baseRevision: number;
  patch: ConversationConfigPatch;
  state: CommandState;
}

export interface SendCommand {
  tag: 'send';
  commandId: string;
  conversationId: string;
  content: string;
  mode: 'queue' | 'interrupt';
  /** Settles the composer's await: resolved on accept, rejected otherwise. */
  settle: { resolve: () => void; reject: (error: Error) => void };
}

export type Command = CreateCommand | ConfigCommand | SendCommand;

// Replaces pendingCreationsAtom, pendingConfigCommandsAtom and the
// module-level pendingMessageCommands Map in actions.ts.
export const commandsAtom = atom<ReadonlyMap<string, Command>>(new Map());

export interface ConversationCommands {
  create: CreateCommand | null;
  config: ConfigCommand | null;
}

/** The in-flight create and config commands for one conversation. */
export const commandFor = atomFamily((conversationId: string) =>
  labelled(
    stableAtom(
      (get): ConversationCommands => {
        let create: CreateCommand | null = null;
        let config: ConfigCommand | null = null;
        for (const command of get(commandsAtom).values()) {
          if (command.conversationId !== conversationId) continue;
          if (command.tag === 'create') create = command;
          else if (command.tag === 'set_config') config = command;
        }
        return { create, config };
      },
      (a, b) => a.create === b.create && a.config === b.config
    ),
    `commands:${conversationId}`
  )
);

/** Every in-flight create, newest first (the sidebar's pending rows). */
export const pendingCreatesOf = (commands: ReadonlyMap<string, Command>): CreateCommand[] =>
  Array.from(commands.values())
    .filter((command): command is CreateCommand => command.tag === 'create')
    .sort((a, b) => b.createdAt - a.createdAt);

// -----------------------------------------------------------------------------
// NEW badge: messages past the last one this device saw.
// -----------------------------------------------------------------------------

export const unreadFamily = atomFamily((id: string) =>
  labelled(
    atom((get) => {
      const row = get(rowFamily(id));
      return row !== null && hasUnseenAfter(get(seenAtom)[id], row.messageCount);
    }),
    `unread:${id}`
  )
);

/**
 * Free the derived groups built from an evicted transcript. The atom families hold their atoms
 * (and each atom's last value) strongly, so an absent transcript alone leaves the old message
 * groups resident.
 */
export function releaseTranscriptDerived(id: string): void {
  settledGroupsFamily.remove(id);
  groupsFamily.remove(id);
}

/** Free every per-id atom memoized for a removed conversation. */
export function forgetConversationAtoms(id: string): void {
  rowStore.forget(id);
  childRowsFamily.remove(id);
  transcriptStore.forget(id);
  streamStore.forget(id);
  settledGroupsFamily.remove(id);
  groupsFamily.remove(id);
  commandFor.remove(id);
  unreadFamily.remove(id);
}
