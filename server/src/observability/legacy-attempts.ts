/** Raw v1 JSONL ingress only; source files are retained byte-for-byte for recovery. */
import type {
  TurnAttemptActivity,
  TurnAttemptIdentity,
  TurnAttemptJournalEvent,
  TurnAttemptState,
} from './types';
import { TERMINAL_TURN_ATTEMPT_STATES, TURN_ACTIVITY_SOURCES, TURN_TERMINAL_CAUSES } from './types';

type NonterminalTurnAttemptState = Exclude<
  TurnAttemptState,
  'succeeded' | 'failed' | 'cancelled' | 'interrupted'
>;
type JournalGeneratedFields = {
  schemaVersion: 1;
  eventId: string;
  serverBootId: string;
  timestamp: string;
};
export function parseJournalEvent(line: string): TurnAttemptJournalEvent | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (!isRecord(value) || value.schemaVersion !== 1) return undefined;
    if (
      typeof value.eventId !== 'string' ||
      typeof value.serverBootId !== 'string' ||
      typeof value.timestamp !== 'string' ||
      typeof value.kind !== 'string'
    ) {
      return undefined;
    }
    const base: JournalGeneratedFields = {
      schemaVersion: 1,
      eventId: value.eventId,
      serverBootId: value.serverBootId,
      timestamp: value.timestamp,
    };
    if (value.kind === 'server_boot') return { kind: 'server_boot', ...base };

    const identity = parseIdentity(value);
    if (!identity) return undefined;
    if (value.kind === 'attempt_created' && value.state === 'queued') {
      return { kind: 'attempt_created', ...identity, state: 'queued', ...base };
    }
    if (
      value.kind === 'attempt_state_changed' &&
      isNonterminalState(value.previousState) &&
      (value.state === 'starting' || value.state === 'running' || value.state === 'stopping')
    ) {
      return {
        kind: 'attempt_state_changed',
        ...identity,
        previousState: value.previousState,
        state: value.state,
        ...base,
      };
    }
    if (
      value.kind === 'attempt_provider_session_bound' &&
      typeof value.providerSessionId === 'string' &&
      value.providerSessionId.length > 0 &&
      isAttemptState(value.state)
    ) {
      return {
        kind: 'attempt_provider_session_bound',
        ...identity,
        providerSessionId: value.providerSessionId,
        state: value.state,
        ...base,
      };
    }
    if (value.kind === 'attempt_activity' && isAttemptState(value.state)) {
      const activity = parseActivity(value.activity);
      if (!activity) return undefined;
      return {
        kind: 'attempt_activity',
        ...identity,
        state: value.state,
        activity,
        ...base,
      };
    }
    if (
      value.kind === 'attempt_terminal' &&
      isNonterminalState(value.previousState) &&
      isOneOf(value.state, TERMINAL_TURN_ATTEMPT_STATES) &&
      isOneOf(value.terminalCause, TURN_TERMINAL_CAUSES)
    ) {
      return {
        kind: 'attempt_terminal',
        ...identity,
        previousState: value.previousState,
        state: value.state,
        terminalCause: value.terminalCause,
        ...base,
      };
    }
    if (
      value.kind === 'attempt_recovered' &&
      typeof value.originServerBootId === 'string' &&
      isNonterminalState(value.previousState) &&
      value.state === 'interrupted' &&
      value.terminalCause === 'server_restart'
    ) {
      return {
        kind: 'attempt_recovered',
        ...identity,
        originServerBootId: value.originServerBootId,
        previousState: value.previousState,
        state: 'interrupted',
        terminalCause: 'server_restart',
        ...base,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function parseIdentity(value: Record<string, unknown>): TurnAttemptIdentity | undefined {
  if (
    typeof value.attemptId !== 'string' ||
    !value.attemptId ||
    typeof value.conversationId !== 'string' ||
    !value.conversationId
  ) {
    return undefined;
  }
  if (
    (value.queueMessageId !== undefined && typeof value.queueMessageId !== 'string') ||
    (value.providerSessionId !== undefined && typeof value.providerSessionId !== 'string')
  ) {
    return undefined;
  }
  return {
    attemptId: value.attemptId,
    conversationId: value.conversationId,
    ...(value.queueMessageId ? { queueMessageId: value.queueMessageId } : {}),
    ...(value.providerSessionId ? { providerSessionId: value.providerSessionId } : {}),
  };
}

function isNonterminalState(value: unknown): value is NonterminalTurnAttemptState {
  return value === 'queued' || value === 'starting' || value === 'running' || value === 'stopping';
}

function isAttemptState(value: unknown): value is TurnAttemptState {
  return isNonterminalState(value) || isOneOf(value, TERMINAL_TURN_ATTEMPT_STATES);
}

function parseActivity(value: unknown): TurnAttemptActivity | undefined {
  // Version-1 journals originally omitted source metadata. Preserve those
  // records while making the uncertainty explicit in the projection.
  if (value === undefined) {
    return { source: 'legacy_unknown', providerEventType: 'unknown' };
  }
  if (!isRecord(value)) return undefined;
  if (
    !isOneOf(value.source, TURN_ACTIVITY_SOURCES) ||
    typeof value.providerEventType !== 'string' ||
    !value.providerEventType ||
    (value.providerEventSource !== undefined && typeof value.providerEventSource !== 'string')
  ) {
    return undefined;
  }
  const heartbeat = parseHeartbeat(value.heartbeat);
  if (value.heartbeat !== undefined && !heartbeat) return undefined;
  return {
    source: value.source,
    providerEventType: value.providerEventType,
    ...(value.providerEventSource ? { providerEventSource: value.providerEventSource } : {}),
    ...(heartbeat ? { heartbeat } : {}),
  };
}

function parseHeartbeat(value: unknown): TurnAttemptActivity['heartbeat'] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  const unified = optionalNonnegativeNumber(value.unifiedEventSilentSeconds);
  const stdout = optionalNonnegativeNumber(value.rawStdoutSilentSeconds);
  const stdoutReadableLength = optionalNonnegativeNumber(value.stdoutReadableLengthBytes);
  const nativeSilent = optionalNonnegativeNumber(value.nativeSessionSilentSeconds);
  const nativeSize = optionalNonnegativeNumber(value.nativeSessionSizeBytes);
  if (
    (value.unifiedEventSilentSeconds !== undefined && unified === undefined) ||
    (value.rawStdoutSilentSeconds !== undefined && stdout === undefined) ||
    (value.stdoutReadableLengthBytes !== undefined && stdoutReadableLength === undefined) ||
    (value.stdoutStreamEvent !== undefined &&
      value.stdoutStreamEvent !== 'attached' &&
      value.stdoutStreamEvent !== 'resume' &&
      value.stdoutStreamEvent !== 'pause' &&
      value.stdoutStreamEvent !== 'close') ||
    (value.stdoutReadableFlowing !== undefined &&
      value.stdoutReadableFlowing !== null &&
      typeof value.stdoutReadableFlowing !== 'boolean') ||
    (value.nativeSessionSilentSeconds !== undefined && nativeSilent === undefined) ||
    (value.nativeSessionSizeBytes !== undefined && nativeSize === undefined) ||
    (value.nativeSessionAvailable !== undefined &&
      typeof value.nativeSessionAvailable !== 'boolean') ||
    (value.nativeSessionAdvanced !== undefined &&
      typeof value.nativeSessionAdvanced !== 'boolean') ||
    (value.phase !== undefined && value.phase !== 'startup' && value.phase !== 'running')
  ) {
    return undefined;
  }
  return {
    ...(unified !== undefined ? { unifiedEventSilentSeconds: unified } : {}),
    ...(stdout !== undefined ? { rawStdoutSilentSeconds: stdout } : {}),
    ...(value.phase === 'startup' || value.phase === 'running' ? { phase: value.phase } : {}),
    ...(value.stdoutStreamEvent === 'attached' ||
    value.stdoutStreamEvent === 'resume' ||
    value.stdoutStreamEvent === 'pause' ||
    value.stdoutStreamEvent === 'close'
      ? { stdoutStreamEvent: value.stdoutStreamEvent }
      : {}),
    ...(typeof value.stdoutReadableFlowing === 'boolean' || value.stdoutReadableFlowing === null
      ? { stdoutReadableFlowing: value.stdoutReadableFlowing }
      : {}),
    ...(stdoutReadableLength !== undefined
      ? { stdoutReadableLengthBytes: stdoutReadableLength }
      : {}),
    ...(typeof value.nativeSessionAvailable === 'boolean'
      ? { nativeSessionAvailable: value.nativeSessionAvailable }
      : {}),
    ...(typeof value.nativeSessionAdvanced === 'boolean'
      ? { nativeSessionAdvanced: value.nativeSessionAdvanced }
      : {}),
    ...(nativeSilent !== undefined ? { nativeSessionSilentSeconds: nativeSilent } : {}),
    ...(nativeSize !== undefined ? { nativeSessionSizeBytes: nativeSize } : {}),
  };
}

function optionalNonnegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isOneOf<const Values extends readonly string[]>(
  value: unknown,
  values: Values
): value is Values[number] {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
