import type {
  TerminalTurnAttemptState,
  TurnAttemptActivity,
  TurnAttemptState,
  TurnTerminalCause,
} from '@unleashd/shared';
import {
  TerminalTurnAttemptStateSchema,
  TurnActivitySourceSchema,
  TurnTerminalCauseSchema,
} from '@unleashd/shared';

export type {
  TerminalTurnAttemptState,
  TurnActivitySource,
  TurnAttemptActivity,
  TurnAttemptSnapshot,
  TurnAttemptState,
  TurnTerminalCause,
} from '@unleashd/shared';
export const TERMINAL_TURN_ATTEMPT_STATES = TerminalTurnAttemptStateSchema.options;
export const TURN_TERMINAL_CAUSES = TurnTerminalCauseSchema.options;
export const TURN_ACTIVITY_SOURCES = TurnActivitySourceSchema.options;
export interface TurnAttemptIdentity {
  attemptId: string;
  conversationId: string;
  queueMessageId?: string;
  providerSessionId?: string;
}

interface JournalEventBase {
  schemaVersion: 1;
  eventId: string;
  serverBootId: string;
  timestamp: string;
}

export interface ServerBootEvent extends JournalEventBase {
  kind: 'server_boot';
}

export interface AttemptCreatedEvent extends JournalEventBase, TurnAttemptIdentity {
  kind: 'attempt_created';
  state: 'queued';
}

export interface AttemptStateChangedEvent extends JournalEventBase, TurnAttemptIdentity {
  kind: 'attempt_state_changed';
  previousState: TurnAttemptState;
  state: Exclude<TurnAttemptState, TerminalTurnAttemptState | 'queued'>;
}

export interface AttemptProviderSessionBoundEvent extends JournalEventBase, TurnAttemptIdentity {
  kind: 'attempt_provider_session_bound';
  providerSessionId: string;
  state: TurnAttemptState;
}

export interface AttemptActivityEvent extends JournalEventBase, TurnAttemptIdentity {
  kind: 'attempt_activity';
  state: TurnAttemptState;
  activity: TurnAttemptActivity;
}

export interface AttemptTerminalEvent extends JournalEventBase, TurnAttemptIdentity {
  kind: 'attempt_terminal';
  previousState: Exclude<TurnAttemptState, TerminalTurnAttemptState>;
  state: TerminalTurnAttemptState;
  terminalCause: TurnTerminalCause;
}

export interface AttemptRecoveredEvent extends JournalEventBase, TurnAttemptIdentity {
  kind: 'attempt_recovered';
  originServerBootId: string;
  previousState: Exclude<TurnAttemptState, TerminalTurnAttemptState>;
  state: 'interrupted';
  terminalCause: 'server_restart';
}

export type TurnAttemptJournalEvent =
  | ServerBootEvent
  | AttemptCreatedEvent
  | AttemptStateChangedEvent
  | AttemptProviderSessionBoundEvent
  | AttemptActivityEvent
  | AttemptTerminalEvent
  | AttemptRecoveredEvent;

export interface AttemptQuery {
  conversationId?: string;
  queueMessageId?: string;
  providerSessionId?: string;
  state?: TurnAttemptState;
  terminalCause?: TurnTerminalCause;
  limit?: number;
}

export interface RecentEventQuery {
  attemptId?: string;
  conversationId?: string;
  since?: string;
  limit?: number;
}
