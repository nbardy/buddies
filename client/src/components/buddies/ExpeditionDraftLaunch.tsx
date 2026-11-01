import type { ExpeditionDraftView } from '@unleashd/shared';
import { type LaunchState, useDraftLaunch } from './expedition-launch';
import { useOpenExpedition } from './expedition-overlay';
import { draftAction } from './expedition-view';
import './Expedition.css';

// Pattern: one-definition (docs/patterns.md#one-definition)
/** Launch, its blocked reason, or "Launched →": one control for the card and the modal.
 * `onOpen` runs before "Launched →" opens the live modal: the draft modal closes first, so the
 * live one never stacks over it (closing it would show the stale draft again). */
export function DraftLaunchButton({
  d,
  refetch,
  onOpen,
}: { d: ExpeditionDraftView; refetch(): Promise<void>; onOpen(): void }) {
  const { state, launch } = useDraftLaunch(d, refetch);
  const openExpedition = useOpenExpedition();
  const action = draftAction(d);
  switch (action.t) {
    case 'launched':
      return (
        <button
          type="button"
          className="expedition-button"
          onClick={() => {
            onOpen();
            openExpedition(action.expeditionId);
          }}
        >
          Launched →
        </button>
      );
    case 'blocked':
      // A quiet disabled button, never the accent: a replaced draft's dimmed accent Launch still
      // read as the card's action (2026-11-02 visual pass).
      return (
        <span className="ui-row expedition-launch">
          <button type="button" className="expedition-button" disabled>
            Launch
          </button>
          <span className="ui-muted">{action.reason}</span>
        </span>
      );
    case 'launch':
      return <LaunchControl state={state} launch={launch} />;
  }
}

function LaunchControl({ state, launch }: { state: LaunchState; launch(): void }) {
  return (
    <span className="ui-row expedition-launch">
      <button
        type="button"
        className="expedition-button expedition-button--primary"
        disabled={state.t === 'pending'}
        aria-busy={state.t === 'pending'}
        onClick={launch}
      >
        {state.t === 'pending' ? 'Launching…' : 'Launch'}
      </button>
      {state.t === 'failed' && (
        <span role="alert" className="expedition-error">
          {state.error}
        </span>
      )}
    </span>
  );
}
