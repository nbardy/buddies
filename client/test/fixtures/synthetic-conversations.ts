import {
  type ConversationDetail,
  type ConversationRow,
  ConversationRowSchema,
  type Message,
  createDefaultConversationConfig,
} from '@unleashd/shared';

/**
 * Schema-valid conversations shaped like a real store: many chats per folder,
 * oompa workers in worktrees, Buddy threads, provider child sessions and a
 * few background tasks. Shared by the render-isolation test and the
 * per-event benchmark (client/bench/conversation-event.bench.ts).
 */

const EPOCH = Date.parse('2026-09-01T00:00:00.000Z');
const FOLDERS = 30;

export function syntheticId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

export function syntheticMessage(role: Message['role'], content: string, timestamp: Date): Message {
  return { role, body: { t: 'text', text: content }, timestamp };
}

export function syntheticConversation(
  index: number,
  overrides: Partial<ConversationRow> = {}
): ConversationRow {
  const folder = `/Users/dev/git/project-${index % FOLDERS}`;
  const worker = index % 5 === 4;
  const buddy = index % 10 === 3;
  const child = index % 33 === 7 && index > 0;
  const activity = EPOCH + index * 60_000;
  return ConversationRowSchema.parse({
    id: syntheticId(index),
    kind: buddy
      ? {
          t: 'buddy',
          buddyId: `buddy-${index % 4}`,
          workspaceId: 'workspace-1',
          visibility: index % 20 === 13 ? 'background' : 'foreground',
        }
      : worker
        ? { t: 'worker', swarmId: `swarm-${index % 3}`, workerId: null, role: 'work' }
        : { t: 'chat' },
    parent: child ? syntheticId(index - 7) : null,
    resumedFrom: null,
    provider: 'claude',
    cwd: worker ? `${folder}/.ws${index % 3}-w1-i${index % 7}` : folder,
    label: `Question ${index}`,
    createdAt: EPOCH + index * 1_000,
    activityAt: activity,
    messageCount: 2,
    run: 'idle',
    done: index % 17 === 0,
    ...overrides,
  });
}

export function syntheticConversations(count: number): ConversationRow[] {
  return Array.from({ length: count }, (_, index) => syntheticConversation(index));
}

/** The two messages a synthetic row counts (Question / Answer). */
export function syntheticMessages(index: number): Message[] {
  const activity = new Date(EPOCH + index * 60_000);
  return [
    syntheticMessage('user', `Question ${index}`, new Date(activity.getTime() - 30_000)),
    syntheticMessage('assistant', `Answer ${index}`, activity),
  ];
}

/** A loaded detail for a synthetic chat. */
export function syntheticDetail(
  id: string,
  overrides: Partial<ConversationDetail> = {}
): ConversationDetail {
  return {
    id,
    sessionId: id,
    config: {
      config: createDefaultConversationConfig('claude'),
      revision: 0,
      resolution: {
        status: 'resolved',
        catalogRevision: 'synthetic',
        value: { provider: 'claude', modelId: 'claude-default' },
      },
    },
    queue: [],
    subAgents: [],
    latestTurn: { observedModel: null, usage: null },
    latestAttempt: null,
    ...overrides,
  };
}
