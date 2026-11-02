import type { ExpeditionDraftView, ExpeditionSummary } from '@unleashd/shared';
import { useAtomValue } from 'jotai';
import { Suspense, lazy, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { type SummaryRead, expeditionSummaryFamily } from '../../atoms/channel-rail';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { buddyWrite, errorText } from './api';
import { backgroundOf, useOpenExpedition } from './expedition-overlay';
import {
  DRAFT_PILL,
  EXPEDITIONS_POLL_MS,
  EXPEDITIONS_URL,
  budgetLine,
  draftAction,
  draftUrl,
  expeditionHref,
  expeditionPill,
  issueCount,
  pollMsOf,
} from './expedition-view';
import './BuddyWorkerThreadBadge.css';
import './Expedition.css';

// The cards a launch leaves in a chat: the live badge, the draft card and the shared Launch.

function BadgeBody({ read }: { read: SummaryRead }) {
  switch (read.t) {
    case 'found': {
      const pill = expeditionPill(read.summary);
      return (
        <>
          <span className={`expedition-pill expedition-tone-${pill.tone}`}>{pill.label}</span>
          <span className="ui-truncate expedition-badge-counts">{read.summary.line}</span>
        </>
      );
    }
    case 'unavailable':
    case 'missing':
      return <span>unavailable</span>;
    case 'pending':
      return null;
  }
}

// Reads the one cached list (N badges, one request); the modal fetches the full view.
export function ExpeditionBadge({ id }: { id: string }) {
  const read = useAtomValue(expeditionSummaryFamily(id));
  usePolledFetch<ExpeditionSummary[]>(
    EXPEDITIONS_URL,
    read.t === 'found' ? pollMsOf(read.summary, EXPEDITIONS_POLL_MS) : EXPEDITIONS_POLL_MS
  );
  const location = useLocation();
  const name = read.t === 'found' ? read.summary.name : null;
  return (
    <Link
      className="buddy-worker-thread-badge ui-inline-row ui-card expedition-badge"
      to={expeditionHref(id)}
      state={{ background: backgroundOf(location) }}
      aria-label={`Open expedition ${name ?? id}`}
    >
      ⛺ <strong className="ui-truncate expedition-badge-name">{name ?? 'Expedition'}</strong>
      <BadgeBody read={read} /> ↗
    </Link>
  );
}

// The modal (and its markdown renderer) loads on the first Info click, not with every chat.
const ExpeditionModal = lazy(() =>
  import('./ExpeditionModal').then((m) => ({ default: m.ExpeditionModal }))
);

/** The card the host posts for a draft (server expeditions/drafts.ts). */
export function ExpeditionDraftCard(p: { draftId: string; workspaceId: string }) {
  const view = usePolledFetch<ExpeditionDraftView>(draftUrl(p.draftId, p.workspaceId), 0);
  const [info, setInfo] = useState(false);
  if (!view.data)
    return (
      <div className="buddy-worker-thread-badge ui-card expedition-draft-card">
        ⛺ Draft expedition
        {view.kind === 'failed' ? `: ${view.error.message}` : '…'}
      </div>
    );
  const d = view.data;
  const issues = d.state.t === 'open' ? d.issues.length : 0;
  const pill = DRAFT_PILL[d.state.t];
  return (
    <section
      className="buddy-worker-thread-badge ui-card ui-stack expedition-draft-card"
      aria-label={`Draft expedition ${d.charter.name}`}
    >
      <div className="ui-row expedition-draft-card-title">
        ⛺ <strong className="ui-truncate">{d.charter.name}</strong>
        <span className={`expedition-pill expedition-tone-${pill.tone}`}>{pill.label}</span>
      </div>
      <span className="ui-truncate">{d.charter.goalLine}</span>
      <span className="ui-muted">
        {budgetLine(d.charter.limits)}
        {issues > 0 && ` · ${issueCount(issues)}`}
      </span>
      <div className="ui-row expedition-draft-card-actions">
        <button type="button" className="expedition-button" onClick={() => setInfo(true)}>
          Info
        </button>
        <DraftLaunchButton d={d} refetch={view.refetch} onOpen={() => setInfo(false)} />
      </div>
      {info && (
        <Suspense fallback={null}>
          <ExpeditionModal
            target={{ t: 'draft', draftId: p.draftId, workspaceId: p.workspaceId }}
            onClose={() => setInfo(false)}
          />
        </Suspense>
      )}
    </section>
  );
}

// Pattern: one-definition (docs/patterns.md#one-definition)
/** `onOpen` closes the draft modal first, so the live one never stacks over a stale draft. */
type LaunchProps = { d: ExpeditionDraftView; refetch(): Promise<void>; onOpen(): void };
export function DraftLaunchButton({ d, refetch, onOpen }: LaunchProps) {
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
      // Never the accent: a replaced draft's dimmed accent Launch read as live (2026-11-02).
      return (
        <span className="ui-row expedition-launch">
          <button type="button" className="expedition-button" disabled>
            Launch
          </button>
          <span className="ui-muted">{action.reason}</span>
        </span>
      );
    case 'launch':
      return (
        <ActionButton
          act={() =>
            buddyWrite('expedition.launch', { draftId: d.id }, { workspaceId: d.workspaceId })
          }
          refetch={refetch}
          label="Launch"
          busy="Launching…"
          primary
        />
      );
  }
}

type ActionState = { t: 'idle' } | { t: 'pending' } | { t: 'failed'; error: string };

/** A host action's button (Launch, Retire): runs `act`, then `refetch`; busy while pending, and
 * the server's refusal (it re-checks at click time) shows inline. */
type ActionProps = {
  act(): Promise<unknown>;
  refetch(): Promise<void>;
  label: string;
  busy: string;
};
export function ActionButton(p: ActionProps & { primary?: boolean }) {
  const [state, setState] = useState<ActionState>({ t: 'idle' });
  const run = () => {
    setState({ t: 'pending' });
    p.act()
      .then(p.refetch)
      .then(() => setState({ t: 'idle' }))
      .catch((cause: unknown) => setState({ t: 'failed', error: errorText(cause) }));
  };
  return (
    <span className="ui-row expedition-launch">
      <button
        type="button"
        className={`expedition-button${p.primary ? ' expedition-button--primary' : ''}`}
        disabled={state.t === 'pending'}
        aria-busy={state.t === 'pending'}
        onClick={run}
      >
        {state.t === 'pending' ? p.busy : p.label}
      </button>
      {state.t === 'failed' && (
        <span role="alert" className="expedition-error">
          {state.error}
        </span>
      )}
    </span>
  );
}
