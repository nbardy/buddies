import type { ConversationConfig, ProviderCatalog } from '@unleashd/shared';
import type { ReactNode } from 'react';
import {
  ConversationConfigPicker,
  type ConversationConfigPickerProps,
} from '../../views/config/ConversationConfigPicker';

// Pattern: one-type-source (docs/patterns.md#one-type-source)
// Retry and mention settings share the same controls; only options scroll so confirmation
// stays reachable on short screens. Guard: channel-model-picker browser geometry check.
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
  return (
    <>
      <button
        type="button"
        className="channel-composer-model-backdrop"
        aria-label="Close model picker"
        tabIndex={-1}
        onClick={onClose}
      />
      <dialog
        open
        className="channel-composer-model ui-stack"
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
