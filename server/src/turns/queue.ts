import type { QueuedMessage } from '@unleashd/shared';
import type { SessionRelativePrompt, TurnInput } from './input';

/**
 * One queued turn. `message` is the wire row clients mirror; `input` and
 * `prompt` stay server-private (provenance and both wordings, so a turn that
 * waits is still worded at admission by the session it reaches).
 * `attemptId` is the turn-attempt record registered for this item, or null
 * once that record was terminalised and the next send must register anew.
 */
export interface QueueEntry {
  readonly message: QueuedMessage;
  readonly input: TurnInput;
  readonly prompt: SessionRelativePrompt;
  attemptId: string | null;
}

/**
 * The server-owned message queue as a pure state machine: no I/O, timers or
 * broadcasts. The conversation owns effects and calls these transitions.
 *
 * Invariants (guards in conversation-runtime.test.ts):
 * - Interrupt stops the turn, not the queue: only the in-flight head is
 *   retired; pending work keeps its order behind the new message (regression
 *   2026-09-19: interrupt used to flush every pending item). Guard:
 *   `interrupt keeps the pending queue and sends the new message first`.
 * - Promote moves a pending item first and retires the in-flight head. Guard:
 *   `promote moves a pending message first and interrupts the turn`.
 * - At most the head is 'sending'. A stale 'sending' head strands everything
 *   behind it (`startHead` skips a sending head), so every path that kills or
 *   refuses the head either finishes it or releases it back to 'pending'.
 */
// Pattern: pure-core (docs/patterns.md#pure-core)
export class TurnQueue {
  private entries: QueueEntry[] = [];

  /** The wire view, in order. */
  get items(): QueuedMessage[] {
    return this.entries.map((entry) => entry.message);
  }

  get length(): number {
    return this.entries.length;
  }

  head(): QueueEntry | undefined {
    return this.entries[0];
  }

  /** A message still waiting to be sent: memory-only work a backend exit would drop. */
  hasPending(): boolean {
    return this.entries.some((entry) => entry.message.status === 'pending');
  }

  pushBack(entry: QueueEntry): void {
    this.entries.push(entry);
  }

  pushFront(entry: QueueEntry): void {
    this.entries.unshift(entry);
  }

  /** Mark a pending head as sending and return it; a sending head or an empty queue yields null. */
  startHead(): QueueEntry | null {
    const head = this.entries[0];
    if (!head || head.message.status === 'sending') return null;
    head.message.status = 'sending';
    return head;
  }

  /** A sending head that did not start goes back to pending. Returns whether it changed. */
  releaseHead(): boolean {
    const head = this.entries[0];
    if (head?.message.status !== 'sending') return false;
    head.message.status = 'pending';
    return true;
  }

  /** Drop the sending head once its turn ended. Returns whether one was dropped. */
  finishHead(): boolean {
    if (this.entries[0]?.message.status !== 'sending') return false;
    this.entries.shift();
    return true;
  }

  /** Drop a pending head (its turn will never start). */
  dropPendingHead(): QueueEntry | null {
    if (this.entries[0]?.message.status !== 'pending') return null;
    return this.entries.shift() ?? null;
  }

  /**
   * Retire the head when its provider turn is being killed. The close handler
   * consumes a 'sending' head on its own, so a stale entry left behind would
   * strand everything queued after it. The attempt record is finished once by
   * the close handler; only the queue slot is dropped here.
   */
  retireInFlightHead(): QueueEntry | null {
    if (this.entries[0]?.message.status !== 'sending') return null;
    return this.entries.shift() ?? null;
  }

  /** Move a pending item to the front, retiring the in-flight head. Unknown or non-pending ids: null. */
  promote(messageId: string): QueueEntry | null {
    const index = this.pendingIndex(messageId);
    if (index === -1) return null;
    const [entry] = this.entries.splice(index, 1);
    this.retireInFlightHead();
    this.entries.unshift(entry);
    return entry;
  }

  /** Remove one pending item. Items already sending cannot be cancelled. */
  removePending(messageId: string): QueueEntry | null {
    const index = this.pendingIndex(messageId);
    if (index === -1) return null;
    return this.entries.splice(index, 1)[0];
  }

  /** Remove every pending item and keep the one in flight. Returns the removed items. */
  clearPending(): QueueEntry[] {
    const removed = this.entries.filter((entry) => entry.message.status === 'pending');
    this.entries = this.entries.filter((entry) => entry.message.status === 'sending');
    return removed;
  }

  /** Remove everything. Returns the pending items (the in-flight one is already accounted for). */
  clearAll(): QueueEntry[] {
    const pending = this.entries.filter((entry) => entry.message.status === 'pending');
    this.entries = [];
    return pending;
  }

  /** The attempt record `attemptId` was terminalised; its item must register a new one. */
  forgetAttempt(attemptId: string): void {
    for (const entry of this.entries) {
      if (entry.attemptId === attemptId) entry.attemptId = null;
    }
  }

  private pendingIndex(messageId: string): number {
    return this.entries.findIndex(
      (entry) => entry.message.id === messageId && entry.message.status === 'pending'
    );
  }
}
