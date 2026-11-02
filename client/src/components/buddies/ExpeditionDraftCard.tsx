import type { ExpeditionDraftView } from '@unleashd/shared';
import { Suspense, lazy, useState } from 'react';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { DraftLaunchButton } from './ExpeditionDraftLaunch';
import { DRAFT_PILL, budgetLine, draftUrl } from './expedition-view';
import './BuddyWorkerThreadBadge.css';
import './Expedition.css';

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
