import type { UnifiedAgentEvent } from '@nbardy/agent-cli';
import type { TurnAttemptActivity } from '../observability';
import { noteActivity } from '../observability/event-loop-stall';

/**
 * Turn timeouts. Three independent clocks (incident history:
 * docs/incident-2026-08-04-codex-bridge-idle-timeout.md and
 * docs/incident-2026-09-10-buddy-chat-timeout.md):
 * - bridge: any unified event or agent-cli heartbeat proves the wrapper ->
 *   Unleashd bridge is alive;
 * - provider idle: only provider events or typed native-session advancement
 *   prove progress. A timer-only heartbeat must never mask a stuck provider
 *   (guard: `timer-only heartbeats cannot mask provider idleness, while
 *   native advancement can`);
 * - max runtime: the absolute budget, passed in explicitly. Foreground Buddy
 *   turns use the SAME `TURN_MAX_RUNTIME_MS`; inheriting a background claim's
 *   600 s default killed live chats on 2026-09-10. Expiry is
 *   `max_runtime_timeout`, never `user_stop` (guard: `foreground Buddy
 *   deadline uses the conversation budget and reports timeout after joined
 *   drain`).
 * A turn that launched a background task (turns/background-wait.ts) widens only the
 * provider-idle budget, by its harness's declared wait, until its last background task
 * finishes; the max clock never moves.
 */

export type TurnTimeoutKind = 'bridge' | 'provider' | 'max';

export interface TurnWatchdogBudgets {
  readonly bridgeMs: number;
  readonly providerIdleMs: number;
  readonly maxRuntimeMs: number;
}

export interface TurnIdleReading {
  elapsedSeconds: number;
  bridgeIdleSeconds: number;
  providerIdleSeconds: number;
}

// Pattern: fix-guards (docs/patterns.md#fix-guards)
export class TurnWatchdog {
  private startedAt = 0;
  private lastBridgeEventAt = 0;
  private lastProviderProgressAt = 0;
  // The provider-idle budget of this turn: budgets.providerIdleMs until a background launch.
  private providerIdleBudgetMs = 0;
  private bridgeTimer: NodeJS.Timeout | null = null;
  private providerIdleTimer: NodeJS.Timeout | null = null;
  private maxTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly budgets: TurnWatchdogBudgets,
    private readonly onTimeout: (kind: TurnTimeoutKind) => void
  ) {}

  /**
   * Arm all three clocks. `startedAt` is when the provider started: an adopted turn keeps its
   * original max-runtime budget instead of getting a fresh one per backend. The idle clocks start
   * now, since this backend has seen nothing yet.
   */
  start(startedAt: number): void {
    this.clear();
    const now = Date.now();
    this.startedAt = startedAt;
    this.lastBridgeEventAt = now;
    this.lastProviderProgressAt = now;
    this.providerIdleBudgetMs = this.budgets.providerIdleMs;
    this.armBridge();
    this.armProviderIdle();
    this.maxTimer = setTimeout(
      () => this.fire('max'),
      Math.max(0, this.budgets.maxRuntimeMs - (now - startedAt))
    );
  }

  /**
   * Every normalized event proves the bridge is alive; only provider events and
   * native-session advancement prove provider progress. The caller only notes
   * events while its turn runs.
   */
  note(event: UnifiedAgentEvent): void {
    const now = Date.now();
    this.lastBridgeEventAt = now;
    this.armBridge();
    if (isProviderProgressEvent(event)) {
      this.lastProviderProgressAt = now;
      this.armProviderIdle();
    }
  }

  /**
   * The turn launched a background task its harness waits for after the parent goes idle, up
   * to `waitMs`. Silence within that wait is not a stall, so for the rest of the turn the
   * provider-idle budget is the wait plus the normal idle budget (a harness that still hangs
   * after its own ceiling dies as before). `endBackgroundWait` narrows it back.
   */
  allowBackgroundWait(waitMs: number): void {
    this.providerIdleBudgetMs = Math.max(
      this.providerIdleBudgetMs,
      this.budgets.providerIdleMs + waitMs
    );
    this.armProviderIdle();
  }

  /** Every background task of the turn has finished: silence is a stall again. */
  endBackgroundWait(): void {
    this.providerIdleBudgetMs = this.budgets.providerIdleMs;
    this.armProviderIdle();
  }

  clear(): void {
    for (const timer of [this.bridgeTimer, this.providerIdleTimer, this.maxTimer]) {
      if (timer) clearTimeout(timer);
    }
    this.bridgeTimer = null;
    this.providerIdleTimer = null;
    this.maxTimer = null;
  }

  idle(): TurnIdleReading {
    const now = Date.now();
    return {
      elapsedSeconds: Math.round((now - this.startedAt) / 1000),
      bridgeIdleSeconds: Math.round((now - this.lastBridgeEventAt) / 1000),
      providerIdleSeconds: Math.round((now - this.lastProviderProgressAt) / 1000),
    };
  }

  private armBridge(): void {
    if (this.bridgeTimer) clearTimeout(this.bridgeTimer);
    this.bridgeTimer = setTimeout(() => this.fire('bridge'), this.budgets.bridgeMs);
  }

  private armProviderIdle(): void {
    if (this.providerIdleTimer) clearTimeout(this.providerIdleTimer);
    const remaining = this.providerIdleBudgetMs - (Date.now() - this.lastProviderProgressAt);
    this.providerIdleTimer = setTimeout(() => this.fire('provider'), remaining);
  }

  private fire(kind: TurnTimeoutKind): void {
    noteActivity(`timer turn-watchdog ${kind}`);
    this.onTimeout(kind);
  }
}

export function describeTurnTimeout(
  kind: TurnTimeoutKind,
  input: TurnIdleReading & { sawMeaningfulOutput: boolean }
): {
  terminalCause: 'bridge_timeout' | 'provider_idle_timeout' | 'max_runtime_timeout';
  message: string;
} {
  const outputDetail = input.sawMeaningfulOutput
    ? ''
    : ' (no assistant text or tool output reached Unleashd)';
  switch (kind) {
    case 'bridge':
      return {
        terminalCause: 'bridge_timeout',
        message: `Turn event bridge stalled: no unified event or bridge heartbeat for ${input.bridgeIdleSeconds}s${outputDetail}`,
      };
    case 'provider':
      return {
        terminalCause: 'provider_idle_timeout',
        message: `Turn stalled: no provider event or native-session advancement for ${input.providerIdleSeconds}s${outputDetail}`,
      };
    case 'max':
      return {
        terminalCause: 'max_runtime_timeout',
        message: `Turn reached its maximum runtime after ${input.elapsedSeconds}s${outputDetail}`,
      };
  }
}

// --- Activity classification --------------------------------------------------

const AGENT_CLI_HEARTBEAT_SOURCE = 'agent-cli.heartbeat';
const AGENT_CLI_NATIVE_SESSION_SOURCE = 'agent-cli.native-session';

export function isProviderProgressEvent(event: UnifiedAgentEvent): boolean {
  if (
    event.type === 'progress' &&
    event.source === AGENT_CLI_HEARTBEAT_SOURCE &&
    event.data?.nativeSessionAdvanced === true
  ) {
    return true;
  }
  return !(event.type === 'progress' && event.source === AGENT_CLI_HEARTBEAT_SOURCE);
}

export function turnAttemptActivityFromEvent(event: UnifiedAgentEvent): TurnAttemptActivity {
  if (event.type === 'progress' && event.source === AGENT_CLI_HEARTBEAT_SOURCE) {
    const unifiedEventSilentSeconds = nonnegativeFiniteNumber(
      event.data?.unifiedEventSilentSeconds
    );
    const rawStdoutSilentSeconds = nonnegativeFiniteNumber(event.data?.rawStdoutSilentSeconds);
    const phase =
      event.data?.phase === 'startup' || event.data?.phase === 'running'
        ? event.data.phase
        : undefined;
    const nativeSessionAdvanced = event.data?.nativeSessionAdvanced === true;
    const nativeSessionAvailable =
      typeof event.data?.nativeSessionAvailable === 'boolean'
        ? event.data.nativeSessionAvailable
        : undefined;
    const nativeSessionSilentSeconds = nonnegativeFiniteNumber(
      event.data?.nativeSessionSilentSeconds
    );
    const stdoutStreamEvent =
      event.data?.stdoutStreamEvent === 'attached' ||
      event.data?.stdoutStreamEvent === 'resume' ||
      event.data?.stdoutStreamEvent === 'pause' ||
      event.data?.stdoutStreamEvent === 'close'
        ? event.data.stdoutStreamEvent
        : undefined;
    const stdoutReadableFlowing =
      typeof event.data?.stdoutReadableFlowing === 'boolean' ||
      event.data?.stdoutReadableFlowing === null
        ? event.data.stdoutReadableFlowing
        : undefined;
    const stdoutReadableLengthBytes = nonnegativeFiniteNumber(
      event.data?.stdoutReadableLengthBytes
    );
    const nativeSessionSizeBytes = nonnegativeFiniteNumber(event.data?.nativeSessionSizeBytes);
    return {
      source: nativeSessionAdvanced ? 'native_session' : 'agent_cli_heartbeat',
      providerEventType: event.type,
      providerEventSource: event.source,
      heartbeat: {
        ...(unifiedEventSilentSeconds !== undefined ? { unifiedEventSilentSeconds } : {}),
        ...(rawStdoutSilentSeconds !== undefined ? { rawStdoutSilentSeconds } : {}),
        ...(phase ? { phase } : {}),
        ...(stdoutStreamEvent ? { stdoutStreamEvent } : {}),
        ...(stdoutReadableFlowing !== undefined ? { stdoutReadableFlowing } : {}),
        ...(stdoutReadableLengthBytes !== undefined ? { stdoutReadableLengthBytes } : {}),
        ...(nativeSessionAvailable !== undefined ? { nativeSessionAvailable } : {}),
        ...(nativeSessionAdvanced ? { nativeSessionAdvanced: true } : {}),
        ...(nativeSessionSilentSeconds !== undefined ? { nativeSessionSilentSeconds } : {}),
        ...(nativeSessionSizeBytes !== undefined ? { nativeSessionSizeBytes } : {}),
      },
    };
  }
  if (event.type === 'progress' && event.source === AGENT_CLI_NATIVE_SESSION_SOURCE) {
    return {
      source: 'native_session',
      providerEventType: event.type,
      providerEventSource: event.source,
    };
  }
  return {
    source: 'provider_event',
    providerEventType: event.type,
    ...(event.type === 'progress' ? { providerEventSource: event.source } : {}),
  };
}

function nonnegativeFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
