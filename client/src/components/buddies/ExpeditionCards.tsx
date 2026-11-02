import type { ExpeditionDraftView, ExpeditionSummary } from '@unleashd/shared';
import { useAtomValue } from 'jotai';
import { Suspense, lazy, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { type SummaryRead, expeditionSummaryFamily } from '../../atoms/channel-rail';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { buddyWrite } from './api';
import { type ActionState, useHostAction } from './expedition-action';
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
  pollMsOf,
} from './expedition-view';
import './BuddyWorkerThreadBadge.css';
import './Expedition.css';

// The cards a launch leaves in a chat (thread, DM or channel): the live badge, the draft card,
// and the one Launch control they and the modal footer share.

/** The settled list stops polling; every other read keeps the list fresh. */
const listPollMs = (read: SummaryRead) =>
  read.t === 'found' ? pollMsOf(read.summary, EXPEDITIONS_POLL_MS) : EXPEDITIONS_POLL_MS;

function BadgeCounts({ s }: { s: ExpeditionSummary }) {
  const pill = expeditionPill(s);
  return (
    <>
      <span className={`expedition-pill expedition-tone-${pill.tone}`}>{pill.label}</span>
      <span className="ui-truncate expedition-badge-counts">{s.line}</span>
    </>
  );
}

/** δ over what the cached list says about this expedition. */
function BadgeBody({ read }: { read: SummaryRead }) {
  switch (read.t) {
    case 'found':
      return <BadgeCounts s={read.summary} />;
    case 'unavailable':
    case 'missing':
      return <span>unavailable</span>;
    case 'pending':
      return null;
  }
}

const nameOf = (read: SummaryRead) => (read.t === 'found' ? read.summary.name : 'Expedition');

// The live badge a launch leaves in its chat (thread, DM or channel): one line, opens the
// expedition modal over the chat (the URL is /expeditions/:id, so the link also travels). It reads
// the one cached list (GET /api/buddies/expeditions, shared with the rail and index), so N badges
// are one request, not N full-view polls; the modal fetches the full view when opened.
export function ExpeditionBadge({ id }: { id: string }) {
  const read = useAtomValue(expeditionSummaryFamily(id));
  usePolledFetch<ExpeditionSummary[]>(EXPEDITIONS_URL, listPollMs(read));
  const location = useLocation();
  return (
    <Link
      className="buddy-worker-thread-badge ui-inline-row ui-card expedition-badge"
      to={expeditionHref(id)}
      state={{ background: backgroundOf(location) }}
      aria-label={`Open expedition ${read.t === 'found' ? read.summary.name : id}`}
    >
      ⛺ <strong className="ui-truncate expedition-badge-name">{nameOf(read)}</strong>
      <BadgeBody read={read} /> ↗
    </Link>
  );
}

// The draft card the host posts when a Buddy drafts an expedition (server expeditions/drafts.ts):
// a sibling of the live badge. Info opens the expedition modal on the draft (charter, issues,
// defaults); Launch starts it through the same host launch as the tool.

// The modal (and its markdown renderer) loads on the first Info click, not with every chat.
const ExpeditionModal = lazy(() =>
  import('./ExpeditionModal').then((m) => ({ default: m.ExpeditionModal }))
);

export function ExpeditionDraftCard({
  draftId,
  workspaceId,
}: { draftId: string; workspaceId: string }) {
  const view = usePolledFetch<ExpeditionDraftView>(draftUrl(draftId, workspaceId), 0);
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
        {issues > 0 && ` · ${issues} ${issues === 1 ? 'issue' : 'issues'}`}
      </span>
      <div className="ui-row expedition-draft-card-actions">
        <button type="button" className="expedition-button" onClick={() => setInfo(true)}>
          Info
        </button>
        <DraftLaunchButton d={d} refetch={view.refetch} onOpen={() => setInfo(false)} />
      </div>
      {info && (
        <DraftInfo draftId={draftId} workspaceId={workspaceId} onClose={() => setInfo(false)} />
      )}
    </section>
  );
}

/** Info: the expedition modal on this draft (a sheet at phone width). */
function DraftInfo({
  draftId,
  workspaceId,
  onClose,
}: { draftId: string; workspaceId: string; onClose(): void }) {
  return (
    <Suspense fallback={null}>
      <ExpeditionModal target={{ t: 'draft', draftId, workspaceId }} onClose={onClose} />
    </Suspense>
  );
}

// Pattern: one-definition (docs/patterns.md#one-definition)
/** Launch, its blocked reason, or "Launched →": one control for the card and the modal.
 * `onOpen` runs before "Launched →" opens the live modal: the draft modal closes first, so the
 * live one never stacks over it (closing it would show the stale draft again). */
export function DraftLaunchButton({
  d,
  refetch,
  onOpen,
}: { d: ExpeditionDraftView; refetch(): Promise<void>; onOpen(): void }) {
  const { state, run: launch } = useHostAction(
    () => buddyWrite('expedition.launch', { draftId: d.id }, { workspaceId: d.workspaceId }),
    refetch
  );
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

function LaunchControl({ state, launch }: { state: ActionState; launch(): void }) {
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
