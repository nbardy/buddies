import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { mobileConversationRouteState } from '../../utils/conversation-route-state';
import type { CreateKind } from '../../views/new-conversation/create';
import {
  type DirectoryStart,
  NewConversationForm,
} from '../../views/new-conversation/NewConversationForm';

/**
 * NewConversationSheet — the mobile container for the shared
 * NewConversationForm ("+ New" on Chats and Swarms). The form is the same one
 * the desktop modal shows; this file is only the sheet around it.
 *
 * Native <dialog> + showModal() rather than a div overlay: focus trapping,
 * inertness of the page behind, and Esc-to-close come from the platform.
 * Clicks on ::backdrop are dispatched with target === the dialog element,
 * which is how backdrop-dismiss is detected below.
 */

const DEFAULT_START: DirectoryStart = { t: 'default' };
const TITLE: Record<CreateKind, string> = { chat: 'New chat', swarm: 'New swarm' };

export function NewConversationSheet({ kind, onClose }: { kind: CreateKind; onClose: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const chatRouteState = useMemo(() => mobileConversationRouteState(location), [location]);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialog.open) return;
    dialog.showModal();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="ui-sheet ui-card"
      aria-label={TITLE[kind]}
      onCancel={(event) => {
        // Esc while a create is in flight would strand the pending request.
        if (busy) event.preventDefault();
        else onClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current && !busy) onClose();
      }}
    >
      <div className="ui-sheet__inner ui-stack">
        <div className="ui-sheet__grabber" aria-hidden="true" />
        <div className="ui-sheet__header ui-row">
          <h2 className="ui-sheet__title">{TITLE[kind]}</h2>
          <button
            type="button"
            className="ui-sheet__close ui-inline-row ui-card ui-muted"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <NewConversationForm
          layout="sheet"
          start={DEFAULT_START}
          primary={kind}
          onBusyChange={setBusy}
          onCreated={(conversationId) => {
            onClose();
            navigate(`/chat/${conversationId}`, { state: chatRouteState });
          }}
        />
      </div>
    </dialog>
  );
}
