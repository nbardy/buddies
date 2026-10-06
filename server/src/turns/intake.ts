import type { ConversationInput } from '../../../crates/unleashd-ingest/index';
import type { SessionRelativePrompt, TurnInput } from './input';
import type { QueueEntry } from './queue';

/**
 * Where a conversation's pending owner messages live DURABLY, one carrier per conversation kind
 * (chosen by its TurnPolicy, never both): a Buddy conversation's are crate `chat` runs; every other
 * kind's are rows of the records store's `conversation_input`. The in-memory `TurnQueue` is the
 * pure state machine and the wire view; every entry in it has a row here, written when the owner
 * sent it, so a message queued behind a running turn survives any backend exit.
 *
 * Pattern: durable-intake (docs/patterns.md#durable-intake). Why `stamp` exists: a turn that
 * spawned and whose backend then died is ADOPTED from its journal. If its row were still
 * unstamped the next boot would requeue the same message and it would run twice, so the stamp
 * ("this message executes") must land BEFORE the spawn. The runtime therefore starts a queue head
 * only once its stamp has landed (`stamp` returns false until then and calls `landed`).
 */
export interface InputCarrier {
  /** A message was sent: write it (ordered after every earlier write of this carrier). */
  put(conversationId: string, entry: QueueEntry): void;
  /** The owner moved a pending message first. */
  promote(entry: QueueEntry): void;
  /** The owner removed a pending message. */
  cancel(entry: QueueEntry): void;
  /** The message's turn ended or was retired: its row is done. */
  settle(entry: QueueEntry): void;
  /**
   * True once the message is stamped executing. Otherwise starts the stamp and returns false;
   * `landed` runs when it is written (or has failed, which the carrier logs): ask again then.
   */
  stamp(entry: QueueEntry, landed: () => void): boolean;
}

/** What is stored for one message: everything needed to start its turn in a new backend. */
interface StoredEntry {
  content: string;
  queuedAt: string;
  input: TurnInput;
  prompt: SessionRelativePrompt;
}

export function encodeEntry(entry: QueueEntry): string {
  const stored: StoredEntry = {
    content: entry.message.content,
    queuedAt: entry.message.queuedAt.toISOString(),
    input: entry.input,
    prompt: entry.prompt,
  };
  return JSON.stringify(stored);
}

/**
 * The inverse of `encodeEntry`; `id` is the message id the row is named by. The attempt record of
 * the backend that queued it is not stored: that backend's attempts are terminal now, and the
 * entry registers a new one when it starts (`prepareQueuedAttempt`).
 */
export function decodeEntry(id: string, body: string): QueueEntry {
  const stored = JSON.parse(body) as StoredEntry;
  return {
    message: {
      id,
      content: stored.content,
      queuedAt: new Date(stored.queuedAt),
      status: 'pending',
    },
    input: Object.freeze(stored.input),
    prompt: stored.prompt,
    attemptId: null,
  };
}

/** The records-store half of the carrier (ConversationRecordStore implements it). */
export interface InputRows {
  putInput(conversationId: string, id: string, body: string, queuedAt: string): Promise<boolean>;
  promoteInput(id: string): Promise<boolean>;
  markInputExecuting(id: string): Promise<boolean>;
  settleInput(id: string): Promise<boolean>;
  listInputs(conversationId: string): Promise<ConversationInput[]>;
  conversationsWithInputs(): Promise<string[]>;
}

/**
 * The records carrier. Writes go through ONE chain: the store runs each call on its own blocking
 * task, so two awaited-nowhere calls could land out of order (a stamp before its put would find no
 * row). A failed write is loud (the error journal captures console.error) and never thrown into
 * the runtime: the message still runs from memory, and only its durability is lost.
 */
export function recordsCarrier(rows: InputRows, logger: Pick<Console, 'error'> = console): InputCarrier {
  let tail: Promise<unknown> = Promise.resolve();
  const stamped = new Set<string>();
  const write = (what: string, op: () => Promise<unknown>): Promise<void> => {
    const next = tail.then(op).then(
      () => undefined,
      (error) => logger.error(`[intake] ${what} failed:`, error)
    );
    tail = next;
    return next;
  };
  return {
    put: (conversationId, entry) => {
      void write(`put ${entry.message.id}`, () =>
        rows.putInput(
          conversationId,
          entry.message.id,
          encodeEntry(entry),
          entry.message.queuedAt.toISOString()
        )
      );
    },
    promote: (entry) => {
      void write(`promote ${entry.message.id}`, () => rows.promoteInput(entry.message.id));
    },
    cancel: (entry) => {
      void write(`cancel ${entry.message.id}`, () => rows.settleInput(entry.message.id));
    },
    settle: (entry) => {
      stamped.delete(entry.message.id);
      void write(`settle ${entry.message.id}`, () => rows.settleInput(entry.message.id));
    },
    stamp: (entry, landed) => {
      if (stamped.has(entry.message.id)) return true;
      void write(`stamp ${entry.message.id}`, () => rows.markInputExecuting(entry.message.id)).then(
        () => {
          stamped.add(entry.message.id);
          landed();
        }
      );
      return false;
    },
  };
}

/** A host with no durable store (tests, a first-run data dir before the store opens): nothing to write. */
export const volatileCarrier: InputCarrier = {
  put: () => undefined,
  promote: () => undefined,
  cancel: () => undefined,
  settle: () => undefined,
  stamp: () => true,
};
