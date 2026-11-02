import type { ExpeditionDraftView } from '@unleashd/shared';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import {
  Bullets,
  CharterPane,
  DefaultMark,
  Goal,
  Section,
  WithDirectory,
} from './ExpeditionCharter';
import { DraftLaunchButton } from './ExpeditionDraftLaunch';
import { LiveModal } from './ExpeditionLive';
import { Pending, type Presentation, Shell, firstRead, usePresentation } from './ExpeditionShell';
import { DRAFT_PILL, draftUrl } from './expedition-view';
import './Expedition.css';

// Pattern: one-definition (docs/patterns.md#one-definition)
// The ONE expedition modal, for a live expedition and for a draft (2026-11-01 owner request: a
// modal, not a page that replaces the conversation pane). Built on the Task overlay's dialog
// (ModalDialog + .channel-task-overlay) and the file preview's markdown surface
// (.file-preview-markdown), so it reads as their sibling. The frame is ExpeditionShell; the live
// body is ExpeditionLive, the charter ExpeditionCharter and the crew chat ExpeditionChat.

export type ExpeditionTarget =
  | { t: 'live'; id: string }
  | { t: 'draft'; draftId: string; workspaceId: string };

export function ExpeditionModal({
  target,
  onClose,
}: { target: ExpeditionTarget; onClose(): void }) {
  const presentation = usePresentation();
  switch (target.t) {
    case 'live':
      return <LiveModal id={target.id} presentation={presentation} onClose={onClose} />;
    case 'draft':
      return (
        <DraftModal
          draftId={target.draftId}
          workspaceId={target.workspaceId}
          presentation={presentation}
          onClose={onClose}
        />
      );
  }
}

// ---------- Draft ----------

function DraftModal({
  draftId,
  workspaceId,
  presentation,
  onClose,
}: { draftId: string; workspaceId: string; presentation: Presentation; onClose(): void }) {
  const view = usePolledFetch<ExpeditionDraftView>(draftUrl(draftId, workspaceId), 0);
  if (!view.data)
    return (
      <Pending
        label="draft"
        kind="draft"
        presentation={presentation}
        onClose={onClose}
        read={firstRead(view)}
      />
    );
  const d = view.data;
  const pill = DRAFT_PILL[d.state.t];
  return (
    <Shell
      label={`Draft expedition ${d.charter.name}`}
      kind="draft"
      presentation={presentation}
      onClose={onClose}
      title={
        <>
          <strong className="expedition-modal-title ui-truncate">⛺ {d.charter.name}</strong>
          <span className={`expedition-pill expedition-tone-${pill.tone}`}>{pill.label}</span>
        </>
      }
    >
      <WithDirectory workspaceId={d.workspaceId}>
        {/* The live dialog's layout (2026-11-01 visual pass): the charter on the left, what
            needs attention before launch in the right column where the live chat sits. */}
        <Goal goal={d.charter.goal} />
        <div className="expedition-columns">
          <div className="expedition-pane expedition-stack">
            <CharterPane charter={d.charter} lessons={[]} defaults={new Set(d.defaulted)} />
          </div>
          <aside className="expedition-pane expedition-stack" aria-label="Before launch">
            {d.issues.length > 0 && (
              <section className="expedition-callout expedition-tone-bad ui-stack">
                <strong>Launch is blocked until these are fixed</strong>
                <Bullets items={d.issues} />
              </section>
            )}
            <Section title="Advice">
              {d.advice.length > 0 ? (
                <Bullets items={d.advice} />
              ) : (
                <p className="ui-muted">Nothing to add: the charter is checkable as written.</p>
              )}
            </Section>
            {d.defaulted.length > 0 && (
              <p className="ui-muted">
                <DefaultMark on /> marks a value the request left out; the default applies.
              </p>
            )}
            {d.resolved.length > 0 && (
              <Section title="Model names resolved">
                <Bullets items={d.resolved} />
              </Section>
            )}
          </aside>
        </div>
      </WithDirectory>
      <footer className="expedition-footer ui-row">
        <DraftLaunchButton d={d} refetch={view.refetch} onOpen={onClose} />
        <button type="button" className="expedition-button" onClick={onClose}>
          Close
        </button>
      </footer>
    </Shell>
  );
}
