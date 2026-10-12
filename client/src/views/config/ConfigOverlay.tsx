import type { ConversationConfig } from '@unleashd/shared';
import { type ReactNode, useEffect, useRef } from 'react';
import { useProviderCatalog } from '../../hooks/useProviderCatalog';
import { useVisibleViewport } from '../../hooks/useVisibleViewport';
import {
  type ConfigEditOrigin,
  ConversationConfigPicker,
  type ConversationConfigPickerProps,
} from './ConversationConfigPicker';

/**
 * A conversation's harness settings in an overlay. The content (catalog
 * states, option groups, notes) is one view; the shell picks how it is
 * presented:
 * - `popover`: desktop header. Non-modal, stays open while choices save;
 *   click outside or Escape closes.
 * - `sheet`: mobile. Bottom-anchored modal <dialog>; a choice applies and
 *   closes, the backdrop or the system back gesture (cancel) closes.
 */
export type OverlayPresentation = 'popover' | 'sheet';

export interface ConfigNote {
  tone: 'info' | 'error';
  text: string;
}

type PickerOptions = Pick<
  ConversationConfigPickerProps,
  'disabled' | 'providerDisabled' | 'defaults' | 'providerFilter'
>;

export interface ConfigOverlayProps {
  presentation: OverlayPresentation;
  /** null: the conversation's saved config has not arrived. */
  value: ConversationConfig | null;
  onChange: (config: ConversationConfig) => void;
  onClose: () => void;
  picker?: PickerOptions;
  notes?: readonly ConfigNote[];
  /** Rendered under the notes (e.g. a confirm button for a change that needs one). */
  actions?: ReactNode;
  /** Keep a sheet open after a pick: the pick is a draft the caller still has to confirm. */
  holdOpen?: boolean;
}

const NO_NOTES: readonly ConfigNote[] = [];

function Content({
  value,
  onPick,
  picker,
  notes,
  actions,
}: {
  value: ConversationConfig | null;
  onPick: (config: ConversationConfig, origin: ConfigEditOrigin) => void;
  picker: PickerOptions;
  notes: readonly ConfigNote[];
  actions: ReactNode;
}) {
  const { catalog, isLoading, error, retry } = useProviderCatalog();
  if (!catalog) {
    return (
      <div className="config-overlay__note ui-muted" role={error ? 'alert' : 'status'}>
        {isLoading || !error ? (
          'Loading harness options…'
        ) : (
          <>
            Could not load harness options.{' '}
            <button type="button" className="config-overlay__retry" onClick={retry}>
              Retry
            </button>
          </>
        )}
      </div>
    );
  }
  if (!value) {
    return (
      <output className="config-overlay__note ui-muted">
        Conversation settings are unavailable. Reload the conversation to try again.
      </output>
    );
  }
  return (
    <div className="config-overlay__options ui-stack">
      <ConversationConfigPicker value={value} catalog={catalog} onChange={onPick} {...picker} />
      {notes.map((note) => (
        <p
          key={note.text}
          className={`config-overlay__note config-overlay__note--${note.tone} ui-muted`}
          role={note.tone === 'error' ? 'alert' : undefined}
        >
          {note.text}
        </p>
      ))}
      {actions}
    </div>
  );
}

function Header({ onClose }: { onClose: () => void }) {
  return (
    <div className="config-overlay__header ui-row ui-muted">
      <span>Conversation settings</span>
      <button
        type="button"
        className="config-overlay__close ui-control ui-muted"
        aria-label="Close harness settings"
        onClick={onClose}
      >
        ✕
      </button>
    </div>
  );
}

function Popover({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);
  return (
    <div className="config-overlay-backdrop">
      <dialog
        open
        ref={ref}
        className="config-overlay config-overlay--popover ui-stack"
        aria-label="Conversation harness settings"
      >
        <Header onClose={onClose} />
        {children}
      </dialog>
    </div>
  );
}

function Sheet({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useVisibleViewport(ref);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="config-overlay config-overlay--sheet ui-sheet ui-card"
      aria-label="Model settings"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="ui-sheet__inner ui-stack">
        <div className="ui-sheet__grabber" aria-hidden="true" />
        <Header onClose={onClose} />
        {children}
      </div>
    </dialog>
  );
}

const PRESENTATIONS = {
  popover: { Frame: Popover, closeOnPick: false },
  sheet: { Frame: Sheet, closeOnPick: true },
} satisfies Record<OverlayPresentation, unknown>;

export function ConfigOverlay({
  presentation,
  value,
  onChange,
  onClose,
  picker = {},
  notes = NO_NOTES,
  actions = null,
  holdOpen = false,
}: ConfigOverlayProps) {
  const { Frame, closeOnPick } = PRESENTATIONS[presentation];
  const onPick = (config: ConversationConfig, origin: ConfigEditOrigin) => {
    onChange(config);
    // Typing a custom model id must not close the sheet on the first keystroke.
    if (closeOnPick && origin === 'choice' && !holdOpen) onClose();
  };
  return (
    <Frame onClose={onClose}>
      <Content value={value} onPick={onPick} picker={picker} notes={notes} actions={actions} />
    </Frame>
  );
}
