import type { ConversationConfig, ProviderCatalog } from '@unleashd/shared';
import { type ReactNode, useRef } from 'react';
import { useVisibleViewport } from '../../hooks/useVisibleViewport';
import {
  ConversationConfigPicker,
  type ConversationConfigPickerProps,
} from '../../views/config/ConversationConfigPicker';

// Pattern: one-type-source (docs/patterns.md#one-type-source)
// Retry and mention settings share the same controls; only options scroll so confirmation
// stays reachable on short screens. Guard: channel-model-picker browser geometry check.
// Mobile Threads keeps navigation visible at layer 100; the shell's picker layer
// puts both confirmation and backdrop above it. Guard: mobile keyboard/navigation probe.
export function ChannelModelPicker({
  label,
  header,
  note,
  catalog,
  value,
  providerFilter,
  onChange,
  onClose,
  actions,
  unavailable = 'Loading harness options…',
}: {
  label: string;
  header?: ReactNode;
  note: string;
  catalog: ProviderCatalog | null;
  value: ConversationConfig | null;
  providerFilter: ConversationConfigPickerProps['providerFilter'];
  onChange(config: ConversationConfig): void;
  onClose(): void;
  actions: ReactNode;
  unavailable?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useVisibleViewport(ref);
  return (
    <>
      <button
        type="button"
        className="channel-composer-model-backdrop"
        style={{ zIndex: 'calc(var(--channel-picker-layer, 20) - 1)' }}
        aria-label="Close model picker"
        tabIndex={-1}
        onClick={onClose}
      />
      <dialog
        ref={ref}
        open
        className="channel-composer-model ui-stack"
        style={{ zIndex: 'var(--channel-picker-layer, 20)' }}
        aria-label={label}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          onClose();
        }}
      >
        {header}
        <div className="channel-composer-model-options ui-stack">
          {catalog && value ? (
            <ConversationConfigPicker
              value={value}
              catalog={catalog}
              reasoningControl="slider"
              providerFilter={providerFilter}
              onChange={onChange}
            />
          ) : (
            <p className="channel-composer-model-note ui-muted">{unavailable}</p>
          )}
          <p className="channel-composer-model-note ui-muted">{note}</p>
        </div>
        <div className="channel-composer-model-actions">{actions}</div>
      </dialog>
    </>
  );
}
