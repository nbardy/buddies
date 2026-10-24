import crypto from 'node:crypto';
import type { ConversationBranch, ConversationConfig, ConversationKind } from '@unleashd/shared';
import type { ConfigProvenance } from './config-records';
import type { ConversationConfigService } from './config-service';
import type { ConversationOptions, ConversationRuntime } from './runtime';

export interface CreationFingerprintInput {
  workingDirectory: string;
  config: ConversationConfig;
  initialMessage?: string;
  swarmDebugPrefix?: string;
  resumedFromConversationId?: string;
  /** The one identity, written to the record once. */
  kind: ConversationKind;
  branch?: ConversationBranch;
}

export interface CreateConversationInput extends CreationFingerprintInput {
  conversationId: string;
  commandId: string;
  buddyBriefing?: string;
  provenance?: ConfigProvenance;
}

export interface ConversationCreationPorts {
  configService: Pick<ConversationConfigService, 'createOrReplay' | 'getRecord'>;
  /** A registered runtime, else the one built from its stored record (runtimes.ts); undefined when none. */
  materialize(id: string): Promise<ConversationRuntime | undefined>;
  getConversation(id: string): ConversationRuntime | undefined;
  createConversation(options: ConversationOptions): ConversationRuntime;
  registerConversation(conversation: ConversationRuntime): void;
  createConversationLink(conversation: ConversationRuntime): Promise<void>;
}

export function creationFingerprint(input: CreationFingerprintInput): string {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        workingDirectory: input.workingDirectory,
        config: input.config,
        initialMessage: input.initialMessage ?? null,
        swarmDebugPrefix: input.swarmDebugPrefix ?? null,
        resumedFromConversationId: input.resumedFromConversationId ?? null,
        kind: input.kind,
        ...(input.branch ? { branch: input.branch } : {}),
      })
    )
    .digest('hex');
}

/** One creation boundary for chat, Builder, delegation and schedules.
 * Creation is inert: input dispatch belongs to the caller's admission path.
 */
export function createConversationService(ports: ConversationCreationPorts) {
  const linking = new Map<string, Promise<void>>();
  const linked = new WeakSet<ConversationRuntime>();
  async function createOrReuse(input: CreateConversationInput): Promise<ConversationRuntime> {
    // Pattern: lazy-runtimes (docs/patterns.md#lazy-runtimes)
    // A stored record has no runtime until first use, so "not registered" does NOT mean "not
    // created": build it from the record first, and the fork source too (the runtime reads it
    // synchronously on its first turn, runtime.ts `chatForkSource`). Replaying the create over a
    // cold record would rebuild it from THIS command's config, which may differ from the stored one.
    // BEFORE createOrReplay: after it every id has a record, and a new one is built inline below.
    // Guard: server/test/lazy-buddy-runtimes.test.ts.
    await Promise.all([
      ports.materialize(input.conversationId),
      ...(input.resumedFromConversationId
        ? [ports.materialize(input.resumedFromConversationId)]
        : []),
    ]);
    // Even a registry hit must validate the durable command and tombstone.
    const creation = await ports.configService.createOrReplay({
      conversationId: input.conversationId,
      workingDirectory: input.workingDirectory,
      kind: input.kind,
      config: input.config,
      provenance: input.provenance,
      creation: {
        commandId: input.commandId,
        fingerprint: creationFingerprint(input),
        initialMessage: input.initialMessage,
        swarmDebugPrefix: input.swarmDebugPrefix,
        resumedFromConversationId: input.resumedFromConversationId,
        branch: input.branch,
      },
    });
    // No await between lookup and register: concurrent matching callers reuse
    // one runtime, including calls from different transports.
    let conversation = ports.getConversation(input.conversationId);
    if (!conversation) {
      const currentSession =
        creation.record.currentSession?.provider === creation.state.config.provider
          ? creation.record.currentSession
          : undefined;
      conversation = ports.createConversation({
        id: input.conversationId,
        workingDirectory: creation.record.workingDirectory ?? input.workingDirectory,
        configState: creation.state,
        done: creation.record.done,
        // The record's kind: a replay keeps what the first create stored.
        kind: creation.record.kind,
        existingSessionId: currentSession?.sessionId,
        existingSessionAudienceKey: currentSession?.buddyAudienceKey,
        swarmDebugPrefix: input.swarmDebugPrefix ?? null,
        resumedFromConversationId: input.resumedFromConversationId ?? null,
        buddyBriefing: input.buddyBriefing,
      });
      ports.registerConversation(conversation);
    }
    return ensureReady(conversation, creation.record);
  }

  async function ensureReady(
    conversation: ConversationRuntime,
    verifiedRecord?: Awaited<ReturnType<ConversationCreationPorts['configService']['getRecord']>>
  ): Promise<ConversationRuntime> {
    const record = verifiedRecord ?? (await ports.configService.getRecord(conversation.id));
    if (!record || record.status === 'deleted')
      throw new Error('Conversation is missing or deleted');
    if (ports.getConversation(conversation.id) !== conversation)
      throw new Error('Conversation is no longer registered or was replaced');
    // The link write is keyed in its store. Retrying a partial creation repairs
    // this projection before the caller may acknowledge or admit input.
    if (linked.has(conversation)) return conversation;
    let link = linking.get(conversation.id);
    if (!link) {
      link = ports.createConversationLink(conversation);
      linking.set(conversation.id, link);
    }
    try {
      await link;
      // Deletion may win while linking is suspended. A successful projection
      // write does not keep the original runtime or durable record alive.
      const current = await ports.configService.getRecord(conversation.id);
      if (!current || current.status === 'deleted')
        throw new Error('Conversation is missing or deleted');
      if (ports.getConversation(conversation.id) !== conversation)
        throw new Error('Conversation is no longer registered or was replaced');
      linked.add(conversation);
    } finally {
      if (linking.get(conversation.id) === link) linking.delete(conversation.id);
    }
    return conversation;
  }
  return Object.assign(createOrReuse, { ensureReady });
}
