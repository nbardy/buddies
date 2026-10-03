import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type ErrorJournalSeverity = 'error' | 'warn';
export type ErrorJournalStatus = 'unresolved' | 'acknowledged';

export interface ErrorJournalContext {
  conversationId?: string;
  attemptId?: string;
  providerSessionId?: string;
  origin?: string;
  route?: string;
}

export interface ErrorOccurrence {
  schemaVersion: 1;
  kind: 'error_occurrence';
  eventId: string;
  timestamp: string;
  serverBootId: string;
  fingerprint: string;
  severity: ErrorJournalSeverity;
  component: string;
  message: string;
  stack?: string;
  context?: ErrorJournalContext;
}

export interface ErrorAcknowledgement {
  schemaVersion: 1;
  kind: 'error_acknowledged';
  eventId: string;
  timestamp: string;
  serverBootId: string;
  fingerprint: string;
  note: string;
}

export type ErrorJournalEvent = ErrorOccurrence | ErrorAcknowledgement;

export interface ErrorGroup {
  fingerprint: string;
  severity: ErrorJournalSeverity;
  component: string;
  message: string;
  stack?: string;
  context?: ErrorJournalContext;
  firstSeenAt: string;
  lastSeenAt: string;
  count: number;
  status: ErrorJournalStatus;
  acknowledgedAt?: string;
  acknowledgementNote?: string;
}

export interface ErrorJournalOptions {
  directory: string;
  fileName?: string;
  maxBytes?: number;
  maxRotatedFiles?: number;
  serverBootId?: string;
  now?: () => Date;
  createId?: () => string;
}

export interface ErrorGroupQuery {
  status?: ErrorJournalStatus | 'all';
  since?: string;
  limit?: number;
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_ROTATED_FILES = 4;
const MAX_MESSAGE_CHARACTERS = 8_000;
const MAX_STACK_CHARACTERS = 16_000;
const MAX_NOTE_CHARACTERS = 2_000;
const MAX_QUERY_LIMIT = 1_000;

export class ErrorJournal {
  readonly serverBootId: string;

  private readonly filePath: string;
  private readonly maxBytes: number;
  private readonly maxRotatedFiles: number;
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly groups = new Map<string, ErrorGroup>();
  private initialized = false;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: ErrorJournalOptions) {
    if (!path.isAbsolute(options.directory)) {
      throw new Error('Error journal directory must be absolute');
    }
    this.filePath = path.join(options.directory, options.fileName ?? 'errors.jsonl');
    this.maxBytes = Math.max(1_024, options.maxBytes ?? DEFAULT_MAX_BYTES);
    this.maxRotatedFiles = Math.max(0, options.maxRotatedFiles ?? DEFAULT_MAX_ROTATED_FILES);
    this.serverBootId = options.serverBootId ?? crypto.randomUUID();
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? crypto.randomUUID;
  }

  initialize(): Promise<void> {
    return this.runExclusive(async () => {
      if (this.initialized) return;
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      await this.reloadFromDisk();
      this.initialized = true;
    });
  }

  capture(input: {
    severity: ErrorJournalSeverity;
    component?: string;
    message: string;
    stack?: string;
    context?: ErrorJournalContext;
  }): Promise<ErrorGroup> {
    return this.runExclusive(async () => {
      this.assertInitialized();
      const message = redactAndBound(input.message, MAX_MESSAGE_CHARACTERS);
      if (!message) throw new Error('Error journal message is required');
      const stack = input.stack ? redactAndBound(input.stack, MAX_STACK_CHARACTERS) : undefined;
      const component = normalizeComponent(input.component ?? inferComponent(message));
      const context = normalizeContext(input.context ?? inferContext(message));
      const fingerprint = fingerprintError(component, message, stack);
      const event: ErrorOccurrence = {
        schemaVersion: 1,
        kind: 'error_occurrence',
        eventId: this.createId(),
        timestamp: this.now().toISOString(),
        serverBootId: this.serverBootId,
        fingerprint,
        severity: input.severity,
        component,
        message,
        ...(stack ? { stack } : {}),
        ...(context ? { context } : {}),
      };
      await this.appendUnlocked(event);
      return cloneGroup(this.groups.get(fingerprint)!);
    });
  }

  captureConsole(severity: ErrorJournalSeverity, values: readonly unknown[]): Promise<ErrorGroup> {
    const errors = values.filter((value): value is Error => value instanceof Error);
    const messageParts = values.flatMap((value) => {
      if (value instanceof Error) return value.message ? [value.message] : [value.name];
      if (typeof value === 'string') return [value];
      if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return [String(value)];
      }
      return [];
    });
    const message = messageParts.join(' ').trim() || 'Console error without a textual message';
    const stack = errors
      .map((error) => error.stack)
      .find((value): value is string => Boolean(value));
    return this.capture({
      severity,
      message,
      stack: stack ?? new Error(message).stack,
    });
  }

  queryGroups(query: ErrorGroupQuery = {}): Promise<ErrorGroup[]> {
    return this.runExclusive(async () => {
      this.assertInitialized();
      const limit = normalizeLimit(query.limit);
      const status = query.status ?? 'unresolved';
      return Array.from(this.groups.values())
        .filter(
          (group) =>
            (status === 'all' || group.status === status) &&
            (!query.since || group.lastSeenAt >= query.since)
        )
        .sort(
          (left, right) =>
            right.lastSeenAt.localeCompare(left.lastSeenAt) ||
            right.fingerprint.localeCompare(left.fingerprint)
        )
        .slice(0, limit)
        .map(cloneGroup);
    });
  }

  acknowledge(fingerprint: string, note: string): Promise<ErrorGroup> {
    return this.runExclusive(async () => {
      this.assertInitialized();
      const current = this.groups.get(fingerprint);
      if (!current) throw new Error(`Error group not found: ${fingerprint}`);
      const boundedNote = redactAndBound(note, MAX_NOTE_CHARACTERS);
      if (!boundedNote) throw new Error('Acknowledgement note is required');
      const event: ErrorAcknowledgement = {
        schemaVersion: 1,
        kind: 'error_acknowledged',
        eventId: this.createId(),
        timestamp: this.now().toISOString(),
        serverBootId: this.serverBootId,
        fingerprint,
        note: boundedNote,
      };
      await this.appendUnlocked(event);
      return cloneGroup(this.groups.get(fingerprint)!);
    });
  }

  flush(): Promise<void> {
    return this.runExclusive(async () => undefined);
  }

  private async appendUnlocked(event: ErrorJournalEvent): Promise<void> {
    await this.repairActiveFileTerminator();
    const line = `${JSON.stringify(event)}\n`;
    if (await this.rotateIfNeeded(Buffer.byteLength(line))) await this.reloadFromDisk();
    await fs.promises.appendFile(this.filePath, line, { encoding: 'utf8', mode: 0o600 });
    applyEvent(this.groups, event);
  }

  private async repairActiveFileTerminator(): Promise<void> {
    const handle = await fs.promises.open(this.filePath, 'a+', 0o600);
    try {
      await handle.chmod(0o600);
      const stat = await handle.stat();
      if (stat.size === 0) return;
      const lastByte = Buffer.allocUnsafe(1);
      await handle.read(lastByte, 0, 1, stat.size - 1);
      if (lastByte[0] !== 10) await handle.appendFile('\n', 'utf8');
    } finally {
      await handle.close();
    }
  }

  private async rotateIfNeeded(incomingBytes: number): Promise<boolean> {
    const currentBytes = await fs.promises
      .stat(this.filePath)
      .then((stat) => stat.size)
      .catch(() => 0);
    if (currentBytes === 0 || currentBytes + incomingBytes <= this.maxBytes) return false;
    if (this.maxRotatedFiles === 0) {
      await fs.promises.truncate(this.filePath, 0);
    } else {
      await fs.promises.rm(`${this.filePath}.${this.maxRotatedFiles}`, { force: true });
      for (let index = this.maxRotatedFiles - 1; index >= 1; index -= 1) {
        await fs.promises
          .rename(`${this.filePath}.${index}`, `${this.filePath}.${index + 1}`)
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
      }
      await fs.promises.rename(this.filePath, `${this.filePath}.1`);
    }
    return true;
  }

  private async reloadFromDisk(): Promise<void> {
    this.groups.clear();
    for (const file of this.journalFilesOldestFirst()) {
      const content = await fs.promises.readFile(file, 'utf8').catch(() => '');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        const event = parseEvent(line);
        if (event) applyEvent(this.groups, event);
      }
    }
  }

  private journalFilesOldestFirst(): string[] {
    const files: string[] = [];
    for (let index = this.maxRotatedFiles; index >= 1; index -= 1) {
      files.push(`${this.filePath}.${index}`);
    }
    files.push(this.filePath);
    return files;
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('Initialize the error journal first');
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

export function installConsoleErrorCapture(
  journal: ErrorJournal,
  target: Pick<Console, 'error' | 'warn'> = console
): () => void {
  const originalError = target.error.bind(target);
  const originalWarn = target.warn.bind(target);
  const wrap =
    (severity: ErrorJournalSeverity, original: (...values: unknown[]) => void) =>
    (...values: unknown[]): void => {
      original(...values);
      void journal.captureConsole(severity, values).catch((error) => {
        originalError('[error-journal] Failed to persist console failure:', error);
      });
    };
  target.error = wrap('error', originalError);
  target.warn = wrap('warn', originalWarn);
  const uncaughtMonitor = (error: Error, origin: string) => {
    void journal
      .capture({
        severity: 'error',
        component: 'process',
        message: `Uncaught exception (${origin}): ${error.message}`,
        stack: error.stack,
        context: { origin },
      })
      .catch((captureError) => {
        originalError('[error-journal] Failed to persist uncaught exception:', captureError);
      });
  };
  process.on('uncaughtExceptionMonitor', uncaughtMonitor);
  return () => {
    target.error = originalError;
    target.warn = originalWarn;
    process.off('uncaughtExceptionMonitor', uncaughtMonitor);
  };
}

function applyEvent(groups: Map<string, ErrorGroup>, event: ErrorJournalEvent): void {
  if (event.kind === 'error_acknowledged') {
    const current = groups.get(event.fingerprint);
    if (!current) return;
    current.status = 'acknowledged';
    current.acknowledgedAt = event.timestamp;
    current.acknowledgementNote = event.note;
    return;
  }
  const current = groups.get(event.fingerprint);
  if (!current) {
    groups.set(event.fingerprint, {
      fingerprint: event.fingerprint,
      severity: event.severity,
      component: event.component,
      message: event.message,
      ...(event.stack ? { stack: event.stack } : {}),
      ...(event.context ? { context: { ...event.context } } : {}),
      firstSeenAt: event.timestamp,
      lastSeenAt: event.timestamp,
      count: 1,
      status: 'unresolved',
    });
    return;
  }
  current.severity = current.severity === 'error' ? 'error' : event.severity;
  current.message = event.message;
  current.stack = event.stack ?? current.stack;
  current.context = event.context ? { ...event.context } : current.context;
  current.lastSeenAt = event.timestamp;
  current.count += 1;
  current.status = 'unresolved';
  current.acknowledgedAt = undefined;
  current.acknowledgementNote = undefined;
}

function parseEvent(line: string): ErrorJournalEvent | null {
  try {
    const value: unknown = JSON.parse(line);
    if (!isRecord(value) || value.schemaVersion !== 1) return null;
    if (
      typeof value.eventId !== 'string' ||
      typeof value.timestamp !== 'string' ||
      typeof value.serverBootId !== 'string' ||
      typeof value.fingerprint !== 'string'
    ) {
      return null;
    }
    if (value.kind === 'error_acknowledged' && typeof value.note === 'string') {
      return value as unknown as ErrorAcknowledgement;
    }
    if (
      value.kind === 'error_occurrence' &&
      (value.severity === 'error' || value.severity === 'warn') &&
      typeof value.component === 'string' &&
      typeof value.message === 'string' &&
      (value.stack === undefined || typeof value.stack === 'string') &&
      (value.context === undefined || isRecord(value.context))
    ) {
      return value as unknown as ErrorOccurrence;
    }
    return null;
  } catch {
    return null;
  }
}

function fingerprintError(component: string, message: string, stack?: string): string {
  const topFrame = stack
    ?.split('\n')
    .find((line) => /^\s*at\s+/.test(line) && !line.includes('error-journal'));
  const normalized = [
    component,
    normalizeVolatileText(message),
    normalizeVolatileText(topFrame ?? ''),
  ]
    .join('\n')
    .toLowerCase();
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 24);
}

function normalizeVolatileText(value: string): string {
  return value
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b(?:0x)?[0-9a-f]{16,}\b/gi, '<id>')
    .replace(/:\d+:\d+\)?/g, ':<line>:<column>')
    .replace(/\b\d+(?:\.\d+)?(?:ms|s|bytes)?\b/gi, '<number>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function redactAndBound(value: string, maximumCharacters: number): string {
  const redacted = value
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(
      /\b(token|secret|password|authorization|api[-_]?key)(\s*[=:]\s*)[^\s,;]+/gi,
      '$1$2[REDACTED]'
    )
    .replace(/([?&](?:token|secret|password|key)=)[^&#\s]+/gi, '$1[REDACTED]')
    .trim();
  if (redacted.length <= maximumCharacters) return redacted;
  return `${redacted.slice(0, maximumCharacters - 32)}\n… [truncated by error journal]`;
}

function inferComponent(message: string): string {
  const bracketed = message.match(/^\[([^\]]+)\]/)?.[1];
  if (bracketed && !/^[0-9a-f-]{36}$/i.test(bracketed)) return bracketed;
  if (bracketed) return 'conversation-runtime';
  return 'server';
}

function inferContext(message: string): ErrorJournalContext | undefined {
  const conversationId =
    message.match(/^\[([0-9a-f-]{36})\]/i)?.[1] ??
    message.match(/\bconversation(?:Id)?\s*[:=]?\s*([0-9a-f-]{36})\b/i)?.[1];
  const attemptId = message.match(/\battempt(?:Id)?\s*[:=]?\s*([0-9a-f-]{36})\b/i)?.[1];
  const context: ErrorJournalContext = {
    ...(conversationId ? { conversationId } : {}),
    ...(attemptId ? { attemptId } : {}),
  };
  return Object.keys(context).length > 0 ? context : undefined;
}

function normalizeComponent(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .slice(0, 80);
  return normalized || 'server';
}

function normalizeContext(
  context: ErrorJournalContext | undefined
): ErrorJournalContext | undefined {
  if (!context) return undefined;
  const normalized: ErrorJournalContext = {
    ...(context.conversationId
      ? { conversationId: redactAndBound(context.conversationId, 200) }
      : {}),
    ...(context.attemptId ? { attemptId: redactAndBound(context.attemptId, 200) } : {}),
    ...(context.providerSessionId
      ? { providerSessionId: redactAndBound(context.providerSessionId, 200) }
      : {}),
    ...(context.origin ? { origin: redactAndBound(context.origin, 200) } : {}),
    ...(context.route ? { route: redactAndBound(context.route, 500) } : {}),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 100;
  return Math.min(Math.floor(value), MAX_QUERY_LIMIT);
}

function cloneGroup(group: ErrorGroup): ErrorGroup {
  return {
    ...group,
    ...(group.context ? { context: { ...group.context } } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
