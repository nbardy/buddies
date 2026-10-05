import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TurnAttempts } from '@unleashd/ingest';
import {
  type TurnAttemptSnapshot,
  TurnAttemptSnapshotSchema,
  isTerminalAttemptState,
} from '@unleashd/shared';
import { foldAttempt } from './attempt-fold';
import { parseJournalEvent } from './legacy-attempts';
import {
  type StructuredObservabilityLogger,
  createStructuredObservabilityLogger,
} from './structured-logger';
import type {
  AttemptQuery,
  RecentEventQuery,
  TerminalTurnAttemptState,
  TurnAttemptActivity,
  TurnAttemptJournalEvent,
  TurnAttemptState,
  TurnTerminalCause,
} from './types';

const ALLOWED: Readonly<Record<TurnAttemptState, readonly TurnAttemptState[]>> = {
  queued: ['starting', 'failed', 'cancelled', 'interrupted'],
  starting: ['running', 'failed', 'cancelled', 'interrupted'],
  running: ['stopping', 'succeeded', 'failed', 'cancelled', 'interrupted'],
  stopping: ['succeeded', 'failed', 'cancelled', 'interrupted'],
  succeeded: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};
export interface TurnAttemptJournalOptions {
  directory: string;
  fileName?: string;
  serverBootId?: string;
  now?: () => Date;
  createId?: () => string;
  logger?: StructuredObservabilityLogger;
}
export interface StartTurnAttemptInput {
  attemptId?: string;
  conversationId: string;
  queueMessageId?: string;
  providerSessionId?: string;
}
export interface TransitionTurnAttemptInput {
  attemptId: string;
  state: 'starting' | 'running' | 'stopping';
  providerSessionId?: string;
}
export interface FinishTurnAttemptInput {
  attemptId: string;
  state: TerminalTurnAttemptState;
  terminalCause: TurnTerminalCause;
  providerSessionId?: string;
}
export interface BindTurnAttemptProviderSessionInput {
  attemptId: string;
  providerSessionId: string;
}
export interface TouchTurnAttemptInput {
  attemptId: string;
  activity: TurnAttemptActivity;
  providerSessionId?: string;
}

// Pattern: one-write-path (docs/patterns.md#one-write-path)
// A serialized observation is one SQLite snapshot/event transaction. TurnRunner still owns settlement.
export class TurnAttemptJournal {
  readonly serverBootId: string;
  private readonly directory: string;
  private readonly legacyFileName: string;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly logger: StructuredObservabilityLogger;
  private store: TurnAttempts | null = null;
  private operationQueue: Promise<void> = Promise.resolve();
  private onSnapshot?: (snapshot: TurnAttemptSnapshot) => void;

  constructor(options: TurnAttemptJournalOptions) {
    if (!path.isAbsolute(options.directory)) throw new Error('Attempt directory must be absolute');
    this.directory = options.directory;
    this.legacyFileName = options.fileName ?? 'turn-attempts.jsonl';
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? crypto.randomUUID;
    this.serverBootId = options.serverBootId ?? this.createId();
    this.logger = options.logger ?? createStructuredObservabilityLogger();
  }
  subscribe(onSnapshot: (snapshot: TurnAttemptSnapshot) => void): void {
    this.onSnapshot = onSnapshot;
  }

  /**
   * `adopting`: attempts whose provider execution outlived the previous boot and is being
   * adopted (turns/executions.ts). They stay open; every other open attempt of an earlier boot is
   * recovered as interrupted. Sweeping them too marked still-running turns `server_restart`, the
   * very symptom adoption removes (agent_notes/2026-08-21_turn-lifecycle-design.md, round 2).
   */
  initialize(adopting: ReadonlySet<string>): Promise<{ recoveredAttempts: number }> {
    return this.runExclusive(async () => {
      if (this.store) return { recoveredAttempts: 0 };
      await fs.promises.mkdir(this.directory, { recursive: true });
      const store = await TurnAttempts.open(path.join(this.directory, 'turn-attempts.sqlite'));
      // A corrupt store (torn checkpoint after a power cut) was moved aside and replaced; its
      // history is recoverable with `sqlite3 <dir>/turn-attempts.sqlite .recover`.
      if (store.quarantined)
        this.logger.error('journal_quarantined', {
          serverBootId: this.serverBootId,
          quarantinedTo: store.quarantined,
        });
      // Import and completion marker commit together. Source files stay byte-for-byte untouched.
      await this.importLegacy(store);
      this.store = store;
      await this.appendEvent(this.baseEvent({ kind: 'server_boot' }));
      const recoverable = (await store.recoverable(this.serverBootId))
        .map(parseSnapshot)
        .filter((attempt) => !adopting.has(attempt.attemptId));
      for (const attempt of recoverable) {
        await this.appendEvent(
          this.baseEvent({
            kind: 'attempt_recovered',
            ...identity(attempt),
            originServerBootId: attempt.originServerBootId,
            previousState: attempt.state as 'queued' | 'starting' | 'running' | 'stopping',
            state: 'interrupted',
            terminalCause: 'server_restart',
          }),
          attempt
        );
        this.logger.warn('attempt_recovered', {
          serverBootId: this.serverBootId,
          attemptId: attempt.attemptId,
          conversationId: attempt.conversationId,
          terminalCause: 'server_restart',
        });
      }
      this.logger.info('journal_initialized', {
        serverBootId: this.serverBootId,
        count: recoverable.length,
      });
      return { recoveredAttempts: recoverable.length };
    });
  }

  startAttempt(input: StartTurnAttemptInput): Promise<TurnAttemptSnapshot> {
    return this.runExclusive(async () => {
      const attemptId = input.attemptId ?? this.createId();
      if (await this.requireStore().get(attemptId))
        throw new Error(`Attempt already exists: ${attemptId}`);
      return (await this.appendEvent(
        this.baseEvent({
          kind: 'attempt_created',
          attemptId,
          conversationId: required(input.conversationId, 'conversationId'),
          queueMessageId: optional(input.queueMessageId, 'queueMessageId'),
          providerSessionId: optional(input.providerSessionId, 'providerSessionId'),
          state: 'queued',
        })
      ))!;
    });
  }
  transitionAttempt(input: TransitionTurnAttemptInput): Promise<TurnAttemptSnapshot> {
    return this.mutate(input.attemptId, (current) => {
      assertTransition(current.state, input.state);
      return this.baseEvent({
        kind: 'attempt_state_changed',
        ...identity(current, input.providerSessionId),
        previousState: current.state as 'queued' | 'starting' | 'running' | 'stopping',
        state: input.state,
      });
    });
  }
  /**
   * The first terminal record wins; a later one is a replay and appends nothing. Settle effects
   * repeat after a crash between the effect and the next phase write (execution-state.ts), and a
   * timeout records its terminal before the drain's settle records it again.
   */
  finishAttempt(input: FinishTurnAttemptInput): Promise<TurnAttemptSnapshot> {
    return this.mutate(input.attemptId, (current) => {
      if (isTerminalAttemptState(current.state)) return null;
      assertTransition(current.state, input.state);
      return this.baseEvent({
        kind: 'attempt_terminal',
        ...identity(current, input.providerSessionId),
        previousState: current.state as 'queued' | 'starting' | 'running' | 'stopping',
        state: input.state,
        terminalCause: input.terminalCause,
      });
    });
  }
  bindProviderSession(input: BindTurnAttemptProviderSessionInput): Promise<TurnAttemptSnapshot> {
    return this.mutate(input.attemptId, (current) =>
      this.baseEvent({
        kind: 'attempt_provider_session_bound',
        ...identity(current, required(input.providerSessionId, 'providerSessionId')),
        providerSessionId: input.providerSessionId,
        state: current.state,
      })
    );
  }
  touchAttempt(input: TouchTurnAttemptInput): Promise<TurnAttemptSnapshot> {
    return this.mutate(input.attemptId, (current) => {
      if (
        input.activity.source === 'agent_cli_heartbeat' ||
        current.lastActivity?.source !== input.activity.source
      ) {
        this.logger.info('attempt_activity', {
          serverBootId: this.serverBootId,
          attemptId: input.attemptId,
          conversationId: current.conversationId,
          activitySource: input.activity.source,
          providerEventType: input.activity.providerEventType,
        });
      }
      return this.baseEvent({
        kind: 'attempt_activity',
        ...identity(current, input.providerSessionId),
        state: current.state,
        activity: input.activity,
      });
    });
  }
  getAttempt(id: string): Promise<TurnAttemptSnapshot | undefined> {
    return this.runExclusive(async () => {
      const value = await this.requireStore().get(id);
      return value ? parseSnapshot(value) : undefined;
    });
  }
  queryAttempts(query: AttemptQuery = {}): Promise<TurnAttemptSnapshot[]> {
    return this.runExclusive(async () =>
      (
        await this.requireStore().query(
          query.conversationId,
          query.queueMessageId,
          query.providerSessionId,
          query.state,
          query.terminalCause,
          limit(query.limit)
        )
      ).map(parseSnapshot)
    );
  }
  recentEvents(query: RecentEventQuery = {}): Promise<TurnAttemptJournalEvent[]> {
    return this.runExclusive(async () =>
      (
        await this.requireStore().events(
          query.attemptId,
          query.conversationId,
          query.since,
          limit(query.limit)
        )
      ).map((value) => JSON.parse(value) as TurnAttemptJournalEvent)
    );
  }
  flush(): Promise<void> {
    return this.runExclusive(async () => undefined);
  }

  /** `make` returns null when the attempt already holds what the event would record. */
  private mutate(
    id: string,
    make: (current: TurnAttemptSnapshot) => TurnAttemptJournalEvent | null
  ): Promise<TurnAttemptSnapshot> {
    return this.runExclusive(async () => {
      const value = await this.requireStore().get(required(id, 'attemptId'));
      if (!value) throw new Error(`Attempt not found: ${id}`);
      const current = parseSnapshot(value);
      const event = make(current);
      if (!event) return current;
      return (await this.appendEvent(event, current))!;
    });
  }
  private async appendEvent(
    event: TurnAttemptJournalEvent,
    current?: TurnAttemptSnapshot
  ): Promise<TurnAttemptSnapshot | undefined> {
    const store = this.requireStore();
    const snapshot = foldAttempt(current, event);
    await store.append(snapshot ? JSON.stringify(snapshot) : undefined, JSON.stringify(event));
    if (snapshot) {
      try {
        this.onSnapshot?.(snapshot);
      } catch {
        // A subscriber failing after commit must not turn a durable observation into a retry.
        this.logger.error('attempt_observation_failed', {
          serverBootId: this.serverBootId,
          attemptId: snapshot.attemptId,
        });
      }
    }
    return snapshot;
  }
  private async importLegacy(store: TurnAttempts): Promise<void> {
    if (await store.legacyImported()) return;
    const base = path.join(this.directory, this.legacyFileName);
    const files = [4, 3, 2, 1, 0].map((n) => (n ? `${base}.${n}` : base));
    const attempts = new Map<string, TurnAttemptSnapshot>();
    const rows: { event: TurnAttemptJournalEvent; snapshot: TurnAttemptSnapshot | null }[] = [];
    let malformed = 0;
    let nonempty = 0;
    for (const file of files) {
      let content: string;
      try {
        content = await fs.promises.readFile(file, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        nonempty++;
        const event = parseJournalEvent(line);
        if (!event) {
          malformed++;
          continue;
        }
        const snapshot = foldAttempt(
          'attemptId' in event ? attempts.get(event.attemptId) : undefined,
          event
        );
        if (snapshot) attempts.set(snapshot.attemptId, snapshot);
        rows.push({ event, snapshot: snapshot ?? null });
      }
    }
    if (nonempty > 0 && rows.length === 0)
      throw new Error('Legacy attempt history has no readable events; source files were preserved');
    await store.importLegacy(JSON.stringify(rows));
    if (malformed)
      this.logger.warn('journal_corrupt_line', {
        serverBootId: this.serverBootId,
        count: malformed,
      });
  }
  private baseEvent(event: Record<string, unknown>): TurnAttemptJournalEvent {
    return {
      ...event,
      schemaVersion: 1,
      eventId: this.createId(),
      serverBootId: this.serverBootId,
      timestamp: this.now().toISOString(),
    } as TurnAttemptJournalEvent;
  }
  private requireStore(): TurnAttempts {
    if (!this.store) throw new Error('Initialize the attempt store first');
    return this.store;
  }
  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

function parseSnapshot(value: string): TurnAttemptSnapshot {
  return TurnAttemptSnapshotSchema.parse(JSON.parse(value));
}
function required(value: string, name: string): string {
  if (!value.trim()) throw new Error(`${name} must not be empty`);
  return value;
}
function optional(value: string | undefined, name: string): string | undefined {
  return value === undefined ? undefined : required(value, name);
}
function limit(value?: number): number {
  return value && Number.isFinite(value) ? Math.min(1000, Math.max(1, Math.floor(value))) : 100;
}
function assertTransition(current: TurnAttemptState, next: TurnAttemptState): void {
  if (!ALLOWED[current].includes(next) || isTerminalAttemptState(current))
    throw new Error(`Invalid attempt transition: ${current} -> ${next}`);
}
function identity(attempt: TurnAttemptSnapshot, providerSessionId?: string) {
  return {
    attemptId: attempt.attemptId,
    conversationId: attempt.conversationId,
    queueMessageId: attempt.queueMessageId,
    providerSessionId: providerSessionId ?? attempt.providerSessionId,
  };
}
