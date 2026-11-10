import { useEffect, useState } from 'react';
import {
  type TurnDiagnosticsInput,
  type TurnDiagnosticsViewModel,
  buildTurnDiagnosticsViewModel,
  isActiveTurnStatus,
} from '../../utils/turn-diagnostics';
import './TurnStatus.css';

/**
 * The live turn pill.
 *
 * `header` (desktop chat header): a bordered pill that keeps label + elapsed
 * time and drops the activity / reason trail, where "Running 7s Provider
 * output just now" was mostly noise — except on warning/danger tones, where
 * that trail IS the signal (stalled bridge, provider silence, failure cause).
 * The full text always stays in `title`.
 * `composer` (mobile composer): borderless, wraps, always shows the trail.
 */
export type TurnStatusPresentation = 'header' | 'composer';

export interface TurnStatusViewProps {
  view: TurnDiagnosticsViewModel;
  presentation: TurnStatusPresentation;
  className?: string;
}

const DIAGNOSTIC_TONES: ReadonlySet<TurnDiagnosticsViewModel['tone']> = new Set([
  'warning',
  'danger',
]);

const SHOWS_TRAIL: Record<TurnStatusPresentation, (view: TurnDiagnosticsViewModel) => boolean> = {
  header: (view) => DIAGNOSTIC_TONES.has(view.tone),
  composer: () => true,
};

export function TurnStatusView({ view, presentation, className = '' }: TurnStatusViewProps) {
  const showTrail = SHOWS_TRAIL[presentation](view);
  return (
    <output
      className={`turn-status turn-status--${presentation} turn-status--${view.tone} ui-inline-row ${className}`}
      aria-live="polite"
      title={view.title}
    >
      <span className="turn-status__indicator" aria-hidden="true" />
      <span className="turn-status__label">{view.label}</span>
      {view.duration ? <span className="turn-status__duration">{view.duration}</span> : null}
      {showTrail && view.lastActivity ? (
        <span className="turn-status__activity">{view.lastActivity}</span>
      ) : null}
      {showTrail && view.reason ? (
        <span className="turn-status__reason ui-truncate">{view.reason}</span>
      ) : null}
    </output>
  );
}

/** `now` pins the clock (tests); otherwise it ticks each second while the turn is live. */
export function TurnStatus({
  diagnostics,
  now,
  presentation,
}: {
  diagnostics: TurnDiagnosticsInput;
  now?: number;
  presentation: TurnStatusPresentation;
}) {
  const [clock, setClock] = useState(() => now ?? Date.now());
  useEffect(() => {
    if (now !== undefined) return setClock(now);
    if (!isActiveTurnStatus(diagnostics.status) && diagnostics.lastActivityAt == null) {
      return setClock(Date.now());
    }
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [diagnostics.lastActivityAt, diagnostics.status, now]);
  const view = buildTurnDiagnosticsViewModel(diagnostics, now ?? clock);
  return <TurnStatusView view={view} presentation={presentation} />;
}
