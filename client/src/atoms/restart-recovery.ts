import type { QueuedMessage } from '@unleashd/shared';
import { atom } from 'jotai';
import { atomFamily } from 'jotai-family';
import { jotaiStore } from './store';

export const RESTART_RECOVERY_KEY_PREFIX = 'restartRecovery:';

export interface RestartRecoverySnapshot {
  version: 1;
  currentMessage: string;
  queuedMessages: string[];
  updatedAt: string;
}

function isRestartRecoverySnapshot(value: unknown): value is RestartRecoverySnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RestartRecoverySnapshot>;
  return (
    candidate.version === 1 &&
    typeof candidate.currentMessage === 'string' &&
    candidate.currentMessage.length > 0 &&
    Array.isArray(candidate.queuedMessages) &&
    candidate.queuedMessages.every(
      (message) => typeof message === 'string' && message.length > 0
    ) &&
    typeof candidate.updatedAt === 'string'
  );
}

export function loadRestartRecovery(conversationId: string): RestartRecoverySnapshot | null {
  if (!conversationId || typeof localStorage === 'undefined') return null;
  const key = `${RESTART_RECOVERY_KEY_PREFIX}${conversationId}`;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (isRestartRecoverySnapshot(parsed)) return parsed;
    localStorage.removeItem(key);
  } catch {
    // Quota/private-mode/corrupt data must not break the composer.
  }
  return null;
}

export const restartRecoveryAtomFamily = atomFamily((conversationId: string) =>
  atom<RestartRecoverySnapshot | null>(loadRestartRecovery(conversationId))
);

function saveRestartRecovery(
  conversationId: string,
  snapshot: RestartRecoverySnapshot | null
): void {
  jotaiStore.set(restartRecoveryAtomFamily(conversationId), snapshot);
  if (typeof localStorage === 'undefined') return;
  const key = `${RESTART_RECOVERY_KEY_PREFIX}${conversationId}`;
  try {
    if (snapshot) localStorage.setItem(key, JSON.stringify(snapshot));
    else localStorage.removeItem(key);
  } catch {
    // In-memory recovery still works for this document.
  }
}

/**
 * Mirror the server queue while it exists. An empty queue is deliberately not
 * destructive: after a server restart the replacement runtime has no queue,
 * and the previous snapshot is exactly what the user may choose to recover.
 */
export function captureRestartRecoveryQueue(
  conversationId: string,
  queue: readonly QueuedMessage[]
): void {
  if (queue.length === 0) return;
  const sendingIndex = queue.findIndex((message) => message.status === 'sending');
  const currentIndex = Math.max(sendingIndex, 0);
  const current = queue[currentIndex];
  saveRestartRecovery(conversationId, {
    version: 1,
    currentMessage: current.content,
    queuedMessages: queue
      .filter((_, index) => index !== currentIndex)
      .map((message) => message.content),
    updatedAt: new Date().toISOString(),
  });
}

export function clearRestartRecovery(conversationId: string): void {
  if (!conversationId) return;
  saveRestartRecovery(conversationId, null);
}

export function removeRestartRecoveryAtom(conversationId: string): void {
  restartRecoveryAtomFamily.remove(conversationId);
}
