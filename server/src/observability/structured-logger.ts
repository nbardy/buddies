export const OBSERVABILITY_LOG_EVENTS = [
  'journal_initialized',
  'journal_rotated',
  'journal_corrupt_line',
  'journal_quarantined',
  'journal_write_failed',
  'attempt_recovered',
  'attempt_observation_failed',
  'attempt_created',
  'attempt_state_changed',
  'attempt_activity',
  'attempt_terminal',
] as const;

export type ObservabilityLogEvent = (typeof OBSERVABILITY_LOG_EVENTS)[number];

export interface SafeObservabilityLogContext {
  serverBootId?: string;
  attemptId?: string;
  conversationId?: string;
  queueMessageId?: string;
  providerSessionId?: string;
  terminalCause?: string;
  activitySource?: string;
  providerEventType?: string;
  providerEventSource?: string;
  heartbeatPhase?: string;
  unifiedEventSilentSeconds?: number;
  rawStdoutSilentSeconds?: number;
  stdoutStreamEvent?: string;
  stdoutReadableFlowing?: boolean | null;
  stdoutReadableLengthBytes?: number;
  nativeSessionAvailable?: boolean;
  nativeSessionAdvanced?: boolean;
  nativeSessionSilentSeconds?: number;
  nativeSessionSizeBytes?: number;
  state?: string;
  count?: number;
  fileIndex?: number;
  quarantinedTo?: string;
}

export interface StructuredObservabilityLogger {
  info(event: ObservabilityLogEvent, context?: SafeObservabilityLogContext): void;
  warn(event: ObservabilityLogEvent, context?: SafeObservabilityLogContext): void;
  error(event: ObservabilityLogEvent, context?: SafeObservabilityLogContext): void;
}

export function createStructuredObservabilityLogger(
  sink: Pick<Console, 'error' | 'info' | 'warn'> = console,
  now: () => Date = () => new Date()
): StructuredObservabilityLogger {
  const write = (
    level: 'error' | 'info' | 'warn',
    event: ObservabilityLogEvent,
    context: SafeObservabilityLogContext = {}
  ): void => {
    sink[level](
      JSON.stringify({
        timestamp: now().toISOString(),
        level,
        component: 'turn-attempt-journal',
        event,
        ...pickSafeContext(context),
      })
    );
  };
  return {
    info: (event, context) => write('info', event, context),
    warn: (event, context) => write('warn', event, context),
    error: (event, context) => write('error', event, context),
  };
}

function pickSafeContext(context: SafeObservabilityLogContext): SafeObservabilityLogContext {
  return {
    ...(context.serverBootId ? { serverBootId: context.serverBootId } : {}),
    ...(context.attemptId ? { attemptId: context.attemptId } : {}),
    ...(context.conversationId ? { conversationId: context.conversationId } : {}),
    ...(context.queueMessageId ? { queueMessageId: context.queueMessageId } : {}),
    ...(context.providerSessionId ? { providerSessionId: context.providerSessionId } : {}),
    ...(context.terminalCause ? { terminalCause: context.terminalCause } : {}),
    ...(context.activitySource ? { activitySource: context.activitySource } : {}),
    ...(context.providerEventType ? { providerEventType: context.providerEventType } : {}),
    ...(context.providerEventSource ? { providerEventSource: context.providerEventSource } : {}),
    ...(context.heartbeatPhase ? { heartbeatPhase: context.heartbeatPhase } : {}),
    ...(context.unifiedEventSilentSeconds !== undefined
      ? { unifiedEventSilentSeconds: context.unifiedEventSilentSeconds }
      : {}),
    ...(context.rawStdoutSilentSeconds !== undefined
      ? { rawStdoutSilentSeconds: context.rawStdoutSilentSeconds }
      : {}),
    ...(context.stdoutStreamEvent !== undefined
      ? { stdoutStreamEvent: context.stdoutStreamEvent }
      : {}),
    ...(context.stdoutReadableFlowing !== undefined
      ? { stdoutReadableFlowing: context.stdoutReadableFlowing }
      : {}),
    ...(context.stdoutReadableLengthBytes !== undefined
      ? { stdoutReadableLengthBytes: context.stdoutReadableLengthBytes }
      : {}),
    ...(context.nativeSessionAvailable !== undefined
      ? { nativeSessionAvailable: context.nativeSessionAvailable }
      : {}),
    ...(context.nativeSessionAdvanced !== undefined
      ? { nativeSessionAdvanced: context.nativeSessionAdvanced }
      : {}),
    ...(context.nativeSessionSilentSeconds !== undefined
      ? { nativeSessionSilentSeconds: context.nativeSessionSilentSeconds }
      : {}),
    ...(context.nativeSessionSizeBytes !== undefined
      ? { nativeSessionSizeBytes: context.nativeSessionSizeBytes }
      : {}),
    ...(context.state ? { state: context.state } : {}),
    ...(context.count !== undefined ? { count: context.count } : {}),
    ...(context.fileIndex !== undefined ? { fileIndex: context.fileIndex } : {}),
    ...(context.quarantinedTo ? { quarantinedTo: context.quarantinedTo } : {}),
  };
}
