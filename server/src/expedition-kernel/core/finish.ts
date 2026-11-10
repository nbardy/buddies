import { type LiveCall, type State, liveCalls, stageOf } from './state';
import { AWAITED_BY_FINISH, CUT_AT_DEADLINE } from './tables';

// When the expedition stops. The deadline bounds work, not judgment: a judge already running, a
// done verdict and a question already put to the owner finish first. The old host cut these off
// at the deadline and recorded an answered owner verdict as `skipped` (see `finishIfDue` in
// server/src/expeditions/host.ts and bce2400); here they hold `due` back instead.

export type Due = { readonly t: 'no' } | { readonly t: 'budget' } | { readonly t: 'deadline' };

/** Whether the host should write `finished` now. `budget`: everything is spent. `deadline`: the
 * time is up. Either waits for running judges, done verdicts and pending asks; producers and
 * commands still running are the host's to cancel (`cutOff`) and wind down after `finished`. */
export function due(state: State, now: Date): Due {
  if (state.progress.t === 'finished' || awaitingJudgment(state)) return { t: 'no' };
  if (now.getTime() >= state.deadlineMs) return { t: 'deadline' };
  if (state.spentUsd >= state.contract.budget.usd) return { t: 'budget' };
  return { t: 'no' };
}

function awaitingJudgment(state: State): boolean {
  return (
    state.pendingAsks.size > 0 ||
    liveCalls(state).some((c) => AWAITED_BY_FINISH[c.call.t] || stageOf(c.status).t === 'judging')
  );
}

/** Past the deadline: the runs to cancel now. Agents still producing and commands; never a judge,
 * an ask, a verdict or a leader wake. */
export function cutOff(state: State, now: Date): LiveCall[] {
  if (now.getTime() < state.deadlineMs) return [];
  return liveCalls(state).filter(
    (c) => CUT_AT_DEADLINE[c.call.t] && stageOf(c.status).t === 'producing'
  );
}
