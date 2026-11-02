import { type ReactNode, useSyncExternalStore } from 'react';
import type { PolledState } from '../../hooks/usePolledFetch';
import { MOBILE_QUERY } from '../../mobile/hooks/useDeviceKind';
import { ModalDialog } from './ModalDialog';
import './Expedition.css';

// The expedition modal's frame: `dialog` is the desktop's wide dialog with the chat as a right
// column; `sheet` is the phone's full-height sheet (`.ui-sheet--full`) with the chat a tab.
export type Presentation = 'dialog' | 'sheet';

// The sheet/dialog choice follows the viewport while the modal is open (2026-11-01 review: a
// window resized from phone to desktop width kept a full-bleed sheet). The shell's own choice is
// sticky per load (useDeviceKind); the modal is short-lived, so re-laying it out loses nothing.
const subscribeViewport = (onChange: () => void) => {
  const query = window.matchMedia(MOBILE_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};
const viewportPresentation = (): Presentation =>
  window.matchMedia(MOBILE_QUERY).matches ? 'sheet' : 'dialog';
/** A static render (tests) has no viewport: it renders the dialog. */
const staticPresentation = (): Presentation => 'dialog';

/** The sheet is the shared full-height sheet frame (ui/primitives.css), the dialog needs none. */
const FRAME: Record<Presentation, string> = { dialog: '', sheet: 'ui-sheet ui-sheet--full' };

export const usePresentation = (): Presentation =>
  useSyncExternalStore(subscribeViewport, viewportPresentation, staticPresentation);

/** Which modal: the live one is a fixed-height workspace; a draft and a notice (an expedition or
 * draft that could not be read) size to their content. */
export type Kind = 'live' | 'draft' | 'notice';

export function Shell({
  label,
  kind,
  presentation,
  onClose,
  title,
  children,
}: {
  label: string;
  kind: Kind;
  presentation: Presentation;
  onClose(): void;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <ModalDialog
      className={`${FRAME[presentation]} channel-task-overlay ui-card ui-stack expedition-modal expedition-modal--${presentation} expedition-modal--${kind}`}
      label={label}
      onClose={onClose}
    >
      <header className="channel-task-overlay-header ui-row expedition-modal-header">
        {title}
        <button
          type="button"
          className="expedition-modal-close"
          onClick={onClose}
          aria-label="Close expedition"
          title="Close (Esc)"
        >
          ✕
        </button>
      </header>
      {children}
    </ModalDialog>
  );
}

/** The first read of an expedition or draft: still loading (the shell with one line, so Esc still
 * closes), or it failed. */
type FirstRead = { t: 'loading' } | { t: 'failed'; error: Error };

export const firstRead = (view: PolledState<unknown>): FirstRead =>
  view.kind === 'failed' ? { t: 'failed', error: view.error } : { t: 'loading' };

/** δ over the first read: a loading shell at the modal's own size, or a compact notice. A failed
 * read used to fill the 86vh live dialog with a lone tent and "HTTP 404" (2026-11-02 visual
 * pass of /expeditions/nope). */
export function Pending({
  label,
  kind,
  presentation,
  onClose,
  read,
}: {
  label: string;
  kind: Kind;
  presentation: Presentation;
  onClose(): void;
  read: FirstRead;
}) {
  switch (read.t) {
    case 'loading':
      return (
        <Shell
          label={label}
          kind={kind}
          presentation={presentation}
          onClose={onClose}
          title={<strong>⛺</strong>}
        >
          <output className="buddy-panel__empty">{`Loading ${label}…`}</output>
        </Shell>
      );
    case 'failed':
      return (
        <Shell
          label={label}
          kind="notice"
          presentation={presentation}
          onClose={onClose}
          title={<strong>{`⛺ This ${label} could not be opened`}</strong>}
        >
          <p className="ui-muted">
            {`It may have been deleted, or the link is wrong (${read.error.message}).`}
          </p>
        </Shell>
      );
  }
}
