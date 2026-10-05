import { createHash } from 'node:crypto';
import type { BuddyContext, ConversationConfig } from '@unleashd/shared';
import type { ConversationRecord } from '../conversations/config-records';
import type { ConfigProvenance } from '../conversations/config-records';
import type { ConversationRuntime } from '../conversations/runtime';

// A Buddy's STABLE conversations — its DM and its seat in each channel thread
// (channels.ts) — share one shape: an id derived
// per generation, reopened while it lives. Nothing maps ids to conversations;
// the conversation-config record of each derived id is the whole state:
//
//   absent  — never created: the first free generation.
//   deleted — tombstoned by the owner; that id is unusable forever.
//   live    — reopen it. Its persisted config is the harness/model it runs,
//             which is how a thread seat remembers the owner's pick.
//
// A later generation exists only because an earlier one was deleted or (for a
// seat) replaced by a pick on another PROVIDER, so the newest created one is current.

export type ConversationSlot =
  | { kind: 'absent' }
  | { kind: 'deleted' }
  | { kind: 'live'; config: ConversationConfig; provenance?: ConfigProvenance };

export function slotOf(record: ConversationRecord | undefined): ConversationSlot {
  if (!record) return { kind: 'absent' };
  if (record.status === 'deleted') return { kind: 'deleted' };
  return { kind: 'live', config: record.config, provenance: record.provenance };
}

export interface StableConversationPorts {
  slot(conversationId: string): Promise<ConversationSlot>;
  getConversation(id: string): ConversationRuntime | undefined;
  ensureConversationReady(conversation: ConversationRuntime): Promise<ConversationRuntime>;
  createConversation(input: {
    context: BuddyContext;
    commandId: string;
    conversationId: string;
    deferInitialMessage: true;
    /** Omitted: the Buddy's profile default, resolved by the creation service. */
    config?: ConversationConfig;
    provenance?: ConfigProvenance;
  }): Promise<ConversationRuntime>;
  /** Run a live one on `config` from its next turn (runtime-config.ts `replaceRuntimeConfig`). */
  reconfigure(
    conversation: ConversationRuntime,
    config: ConversationConfig,
    provenance?: ConfigProvenance
  ): Promise<void>;
}

const MAX_GENERATIONS = 32;

// UUID-shaped id derived from a seed, so a (purpose, Buddy, …) tuple always
// names the same transcript across restarts without storing a mapping.
export function stableConversationId(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export type LiveConversation = {
  conversationId: string;
  config: ConversationConfig;
  provenance?: ConfigProvenance;
};

/**
 * One scan of a stable conversation's generations: the current one (null when none lives), every
 * live id oldest first (the DM shows earlier chats above a divider), and the first never used.
 */
export async function scanGenerations(
  ports: Pick<StableConversationPorts, 'slot'>,
  idOf: (generation: number) => string
): Promise<{ current: LiveConversation | null; live: string[]; next(): string }> {
  let current: LiveConversation | null = null;
  const live: string[] = [];
  for (let generation = 0; generation < MAX_GENERATIONS; generation += 1) {
    const conversationId = idOf(generation);
    const slot = await ports.slot(conversationId);
    switch (slot.kind) {
      case 'absent':
        return { current, live, next: () => conversationId };
      case 'deleted':
        current = null;
        break;
      case 'live':
        current = { conversationId, config: slot.config, provenance: slot.provenance };
        live.push(conversationId);
        break;
    }
  }
  return {
    current,
    live,
    next: () => {
      throw new Error(`Every conversation generation here is used (${MAX_GENERATIONS})`);
    },
  };
}

/** Reopen the runtime if it is registered, else create (or replay) it. */
export async function openConversation(
  ports: StableConversationPorts,
  input: {
    context: BuddyContext;
    conversationId: string;
    commandId: string;
    config?: ConversationConfig;
    provenance?: ConfigProvenance;
  }
): Promise<ConversationRuntime> {
  const existing = ports.getConversation(input.conversationId);
  if (existing) return ports.ensureConversationReady(existing);
  return ports.createConversation({ ...input, deferInitialMessage: true });
}
