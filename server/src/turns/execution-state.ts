import type { TurnTerminalCause } from '../observability';

// Pattern: persisted-state-machine (docs/patterns.md#persisted-state-machine)
/**
 * ONE provider execution's truth, persisted in its journal (`phase.json`, turns/executions.ts)
 * and written BEFORE the side effects of each step. A replacement backend decides what to do
 * with a journal from this phase and the process's liveness alone.
 *
 * Why one persisted state: until 2026-10-03 the truth was spread over three stores that a crash
 * could tear apart. The tool grant lived in memory, the journal on disk, and the Buddy run row in
 * the crate:
 * - 2a: Stop and timeouts revoked the grant in memory only. A backend SIGKILLed inside the 3 s
 *   SIGTERM→SIGKILL grace left a journal the next backend adopted as LIVE, grant restored, and
 *   nothing stopped the turn again.
 * - 2b: the journal was removed when the drain resolved, before the fire-and-forget run settle
 *   landed. A crash between them recovered a finished run as interrupted.
 * Now a stop is `stopping` on disk before any signal, and a drained turn is `ended(outcome)` on
 * disk before its settle, which stays on disk until the settle lands.
 * Guards:
 * - server/test/execution-crash-checker.test.ts: every crash point, exhaustively, plus a
 *   mutation check;
 * - server/test/adoption-stop.test.ts (2a) and adoption-settle-crash.test.ts (2b): the real
 *   backend, killed in each window.
 * Decision: agent_notes/2026-10-03_p1-single-execution-state-decision.md.
 */
export type Phase =
  /** The provider may run and write; the only phase that holds a tool grant. */
  | { readonly t: 'running' }
  /** Being ended for a reason that decides its outcome. It never gets its grant back. */
  | { readonly t: 'stopping'; readonly intent: StopIntent }
  /** Killed for a fresh session (`reset`): nothing settles it; a later backend discards it. */
  | { readonly t: 'abandoned' }
  /** Drained; its settle may not have landed yet. A later backend settles it with this outcome. */
  | { readonly t: 'ended'; readonly outcome: ExecutionOutcome }
  /** The settle landed; only the journal's removal is left. */
  | { readonly t: 'settled' };

export type StopIntent =
  | { readonly t: 'user_stop' }
  | {
      readonly t: 'timeout';
      readonly terminalCause: 'bridge_timeout' | 'provider_idle_timeout' | 'max_runtime_timeout';
      readonly message: string;
    };

/** How a turn ended, for its attempt record and its run. */
export type ExecutionOutcome =
  | { readonly t: 'complete'; readonly text: string }
  | { readonly t: 'failed'; readonly cause: TurnTerminalCause; readonly detail: string }
  | { readonly t: 'cancelled'; readonly detail: string };

/** What happens to a live execution. */
export type ExecutionEvent =
  | { readonly t: 'stop'; readonly intent: StopIntent }
  | { readonly t: 'abandon' }
  /** The process ended and every event was folded: `observed` is what the stream showed. */
  | { readonly t: 'drained'; readonly observed: ExecutionOutcome }
  /** The settle effect finished (attempt record, run settle). */
  | { readonly t: 'landed' };

/** A side effect, run only after the step's phase is on disk. */
export type Effect =
  | { readonly t: 'revoke_grant' }
  /** SIGTERM the process group now; SIGKILL it after the grace if it still runs. */
  | { readonly t: 'signal' }
  /** An adopted live turn: its run deadline expires it again, from the same instant. */
  | { readonly t: 'arm_deadline' }
  | { readonly t: 'settle'; readonly outcome: ExecutionOutcome }
  | { readonly t: 'remove' };

export interface Step {
  readonly phase: Phase;
  readonly effects: readonly Effect[];
}

/** The process as a replacement backend finds it (agent-cli's exited and lost are both `ended`). */
export type ProcessAt = 'live' | 'ended';

/** What a replacement backend does with a journal it found. */
export type Adoption =
  /** Kill it if it runs and delete it: there is nothing to settle. */
  | { readonly t: 'discard' }
  /** Its conversation follows it from byte 0 (the replay), running these effects. */
  | { readonly t: 'follow'; readonly effects: readonly Effect[] };

type Handlers<P extends Phase> = {
  readonly [E in ExecutionEvent as E['t']]: (phase: P, event: E) => Step;
};

/** One row per phase, one cell per event; each cell is one straight-line step. */
export type TransitionTable = { readonly [P in Phase as P['t']]: Handlers<P> };

/** One row per phase, one cell per process state. */
export type AdoptionTable = {
  readonly [P in Phase as P['t']]: { readonly [A in ProcessAt]: (phase: P) => Adoption };
};

const stay = (phase: Phase): Step => ({ phase, effects: [] });

/** A settle cannot land before the turn ended: a bug in the caller, never a state. */
function notEnded(phase: Phase): never {
  throw new Error(`execution state: a settle landed in phase ${phase.t}`);
}

/** The outcome a stop decides, whatever the stream showed after it. */
const stopOutcome: { readonly [I in StopIntent as I['t']]: (intent: I) => ExecutionOutcome } = {
  user_stop: () => ({ t: 'cancelled', detail: 'Stopped by the owner' }),
  timeout: (intent) => ({ t: 'failed', cause: intent.terminalCause, detail: intent.message }),
};

export function outcomeOfStop(intent: StopIntent): ExecutionOutcome {
  return (stopOutcome[intent.t] as (intent: StopIntent) => ExecutionOutcome)(intent);
}

/**
 * Every step persists its phase first (applyStep in turns/executions.ts), so each effect below
 * runs only once the phase that explains it is on disk:
 * - `revoke_grant` and `signal` follow `stopping`/`abandoned`: a crash after them can never
 *   adopt the turn as live (2a);
 * - `settle` follows `ended(outcome)`: a crash before it lands settles the same outcome at the
 *   next boot (2b);
 * - `remove` follows `settled`.
 * Effects are idempotent (attempt terminal: first wins; run settle: the lease rejects a second;
 * signals check the wrapper's identity), because a crash between an effect and the next phase
 * write repeats it.
 */
export const TRANSITIONS: TransitionTable = {
  running: {
    stop: (_, { intent }) => ({
      phase: { t: 'stopping', intent },
      effects: [{ t: 'revoke_grant' }, { t: 'signal' }],
    }),
    abandon: () => ({
      phase: { t: 'abandoned' },
      effects: [{ t: 'revoke_grant' }, { t: 'signal' }],
    }),
    drained: (_, { observed }) => ({
      phase: { t: 'ended', outcome: observed },
      effects: [{ t: 'revoke_grant' }, { t: 'settle', outcome: observed }],
    }),
    landed: notEnded,
  },
  stopping: {
    // The first intent stands: its signal and SIGKILL escalation are already armed.
    stop: stay,
    abandon: () => ({ phase: { t: 'abandoned' }, effects: [] }),
    drained: ({ intent }) => {
      const outcome = outcomeOfStop(intent);
      return { phase: { t: 'ended', outcome }, effects: [{ t: 'settle', outcome }] };
    },
    landed: notEnded,
  },
  abandoned: {
    stop: stay,
    abandon: stay,
    drained: () => ({ phase: { t: 'settled' }, effects: [{ t: 'remove' }] }),
    landed: notEnded,
  },
  ended: {
    stop: stay,
    abandon: stay,
    // An adopted `ended` journal replays, then settles the outcome decided before the crash.
    drained: (phase) => ({ phase, effects: [{ t: 'settle', outcome: phase.outcome }] }),
    landed: () => ({ phase: { t: 'settled' }, effects: [{ t: 'remove' }] }),
  },
  settled: {
    stop: stay,
    abandon: stay,
    drained: stay,
    landed: stay,
  },
};

const follow = (...effects: Effect[]): Adoption => ({ t: 'follow', effects });
const discard = (): Adoption => ({ t: 'discard' });

/**
 * Boot. A live `running` turn is the only one that gets its grant back (`holdsGrant`) and its
 * deadline re-armed. A `stopping` turn is followed and signalled again: the grace may have died
 * with the old backend (Stop always kills). An `ended` one only needs its settle.
 */
export const ADOPTIONS: AdoptionTable = {
  running: { live: () => follow({ t: 'arm_deadline' }), ended: () => follow() },
  stopping: { live: () => follow({ t: 'signal' }), ended: () => follow() },
  abandoned: { live: discard, ended: discard },
  ended: { live: () => follow(), ended: () => follow() },
  settled: { live: discard, ended: discard },
};

/** Thin dispatcher: the phase's row, the event's cell. */
export function transition(
  phase: Phase,
  event: ExecutionEvent,
  table: TransitionTable = TRANSITIONS
): Step {
  const row = table[phase.t] as Handlers<Phase>;
  return (row[event.t] as (phase: Phase, event: ExecutionEvent) => Step)(phase, event);
}

export function adoption(
  phase: Phase,
  process: ProcessAt,
  table: AdoptionTable = ADOPTIONS
): Adoption {
  return (table[phase.t][process] as (phase: Phase) => Adoption)(phase);
}

/**
 * Whether a found journal's tool grant is valid again: exactly a live `running` execution. Boot
 * restores these grants BEFORE the Buddy MCP endpoint listens, so an adopted turn's tool call never
 * meets a 401 from a backend that has not restored it yet (the 401 window of the P1 review,
 * 2026-10-01; guard: execution-adoption.test.ts).
 */
export const GRANTS: GrantTable = {
  running: { live: true, ended: false },
  stopping: { live: false, ended: false },
  abandoned: { live: false, ended: false },
  ended: { live: false, ended: false },
  settled: { live: false, ended: false },
};

export type GrantTable = { readonly [P in Phase['t']]: { readonly [A in ProcessAt]: boolean } };

export function holdsGrant(phase: Phase, process: ProcessAt, table: GrantTable = GRANTS): boolean {
  return table[phase.t][process];
}

/** A live execution: its journal directory and the phase last written there. */
export interface Execution {
  readonly dir: string;
  phase: Phase;
}

/**
 * The one place a phase changes: the next phase is written to disk BEFORE any of the step's
 * effects is handed back to run. A crash between the two leaves the new phase with its effects
 * undone, and every phase's adoption redoes them.
 */
export function applyStep(
  execution: Execution,
  event: ExecutionEvent,
  write: (dir: string, phase: Phase) => void,
  table: TransitionTable = TRANSITIONS
): readonly Effect[] {
  const step = transition(execution.phase, event, table);
  write(execution.dir, step.phase);
  execution.phase = step.phase;
  return step.effects;
}
