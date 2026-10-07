import { WebSocket, type WebSocketServer } from 'ws';
import type { ConversationBroadcast } from '../conversations/runtime';

const MAX_CLIENT_BACKLOG_BYTES = 8 * 1024 * 1024;

export interface ConversationIdentity {
  id: string;
  sessionId: string;
}

export interface ConversationRegistry<TConversation extends ConversationIdentity> {
  readonly size: number;
  get(id: string): TConversation | undefined;
  has(id: string): boolean;
  set(conversation: TConversation): void;
  delete(id: string): boolean;
  values(): IterableIterator<TConversation>;
  entries(): IterableIterator<[string, TConversation]>;
  keys(): IterableIterator<string>;
}

export interface SessionTracking {
  registerAlias(sessionId: string | null | undefined, conversationId: string): void;
  unregisterAlias(sessionId: string | null | undefined, options?: { keepKnown?: boolean }): void;
  unregisterConversationAliases(conversationId: string, options?: { keepKnown?: boolean }): void;
  aliasFor(sessionId: string): string | undefined;
  aliasEntries(): IterableIterator<[string, string]>;
  hasAlias(sessionId: string): boolean;
  isKnown(sessionId: string): boolean;
  isDeleted(sessionId: string): boolean;
  markDeleted(sessionId: string): void;
  prune(registry: ConversationRegistry<ConversationIdentity>): void;
}

export interface ExternalActivity {
  entries(): IterableIterator<[string, number]>;
  has(sessionId: string): boolean;
  set(sessionId: string, lastSeen: number): void;
  delete(sessionId: string): void;
  clear(...sessionIds: Array<string | null | undefined>): void;
}

export interface CompletionSuppression {
  mark(...sessionIds: Array<string | null | undefined>): void;
  clear(...sessionIds: Array<string | null | undefined>): void;
  isSuppressed(sessionId: string, now: number): boolean;
  prune(now: number): void;
}

export interface ConversationApplicationContext<TConversation extends ConversationIdentity> {
  registry: ConversationRegistry<TConversation>;
  sessions: SessionTracking;
  externalActivity: ExternalActivity;
  completionSuppression: CompletionSuppression;
  broadcast(data: ConversationBroadcast): void;
  broadcastExcept(excludedClient: WebSocket, data: ConversationBroadcast): void;
}

export function createConversationApplicationContext<
  TConversation extends ConversationIdentity,
>(options: {
  webSocketServer: WebSocketServer;
  completionSuppressionMs: number;
  now?: () => number;
}): ConversationApplicationContext<TConversation> {
  const conversations = new Map<string, TConversation>();
  const aliases = new Map<string, string>();
  const knownSessionIds = new Set<string>();
  const deletedSessionIds = new Set<string>();
  const externallyRunning = new Map<string, number>();
  const completionSuppressUntil = new Map<string, number>();
  const now = options.now ?? Date.now;

  const registry: ConversationRegistry<TConversation> = {
    get size() {
      return conversations.size;
    },
    get: (id) => conversations.get(id),
    has: (id) => conversations.has(id),
    set(conversation) {
      conversations.set(conversation.id, conversation);
    },
    delete: (id) => conversations.delete(id),
    values: () => conversations.values(),
    entries: () => conversations.entries(),
    keys: () => conversations.keys(),
  };

  function unregisterAlias(
    sessionId: string | null | undefined,
    unregisterOptions: { keepKnown?: boolean } = {}
  ): void {
    if (!sessionId) return;
    aliases.delete(sessionId);
    if (!unregisterOptions.keepKnown) knownSessionIds.delete(sessionId);
  }

  const sessions: SessionTracking = {
    registerAlias(sessionId, conversationId) {
      if (!sessionId) return;
      aliases.set(sessionId, conversationId);
      knownSessionIds.add(sessionId);
    },
    unregisterAlias,
    unregisterConversationAliases(conversationId, unregisterOptions = {}) {
      for (const [sessionId, mappedConversationId] of aliases) {
        if (mappedConversationId === conversationId) {
          unregisterAlias(sessionId, unregisterOptions);
        }
      }
    },
    aliasFor: (sessionId) => aliases.get(sessionId),
    aliasEntries: () => aliases.entries(),
    hasAlias: (sessionId) => aliases.has(sessionId),
    isKnown: (sessionId) => knownSessionIds.has(sessionId),
    isDeleted: (sessionId) => deletedSessionIds.has(sessionId),
    markDeleted: (sessionId) => deletedSessionIds.add(sessionId),
    prune(conversationRegistry) {
      if (deletedSessionIds.size > 10_000) deletedSessionIds.clear();
      for (const sessionId of knownSessionIds) {
        if (!conversationRegistry.has(sessionId) && !aliases.has(sessionId)) {
          knownSessionIds.delete(sessionId);
        }
      }
    },
  };

  const externalActivity: ExternalActivity = {
    entries: () => externallyRunning.entries(),
    has: (sessionId) => externallyRunning.has(sessionId),
    set: (sessionId, lastSeen) => {
      externallyRunning.set(sessionId, lastSeen);
    },
    delete: (sessionId) => {
      externallyRunning.delete(sessionId);
    },
    clear(...sessionIds) {
      for (const sessionId of sessionIds) {
        if (sessionId) externallyRunning.delete(sessionId);
      }
    },
  };

  const completionSuppression: CompletionSuppression = {
    mark(...sessionIds) {
      const until = now() + options.completionSuppressionMs;
      for (const sessionId of sessionIds) {
        if (sessionId) completionSuppressUntil.set(sessionId, until);
      }
    },
    clear(...sessionIds) {
      for (const sessionId of sessionIds) {
        if (sessionId) completionSuppressUntil.delete(sessionId);
      }
    },
    isSuppressed(sessionId, timestamp) {
      const until = completionSuppressUntil.get(sessionId);
      if (until === undefined) return false;
      if (timestamp < until) return true;
      completionSuppressUntil.delete(sessionId);
      return false;
    },
    prune(timestamp) {
      for (const [sessionId, until] of completionSuppressUntil) {
        if (timestamp >= until) completionSuppressUntil.delete(sessionId);
      }
    },
  };

  // Fix-guard (2026-10-08 audit): `client.send` queues in node's heap while a tab is frozen or on a
  // slow link, and every broadcast goes to every tab, so one stalled tab grew the server without
  // bound. Past this backlog the socket is dropped; the client reconnects and gets a fresh `hello`.
  // Guard: server/test/websocket-backpressure.test.ts.
  function send(data: ConversationBroadcast, excludedClient?: WebSocket): void {
    const payload = JSON.stringify(data);
    options.webSocketServer.clients.forEach((client) => {
      if (client === excludedClient || client.readyState !== WebSocket.OPEN) return;
      if (client.bufferedAmount > MAX_CLIENT_BACKLOG_BYTES) client.terminate();
      else client.send(payload);
    });
  }

  return {
    registry,
    sessions,
    externalActivity,
    completionSuppression,
    broadcast: (data) => send(data),
    broadcastExcept: (excludedClient, data) => send(data, excludedClient),
  };
}
