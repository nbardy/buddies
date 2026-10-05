import type { CSSProperties } from 'react';
import { COPY_LABEL, useCopyAction } from '../../hooks/useCopyAction';

// Shared by the Setup dialog's sections (DependenciesPrompt, ConnectMobile).
export const SURFACE = {
  text: '#f2f4f8',
  muted: '#9da8b5',
  border: '#ffffff14',
};
export const buttonStyle: CSSProperties = {
  padding: 'var(--sp-6) var(--sp-7)',
  border: 'none',
  borderRadius: 0,
  background: 'transparent',
  color: SURFACE.text,
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 'var(--fs-4)',
};

export function DependencyCommand({ command, label }: { command: string; label: string }) {
  const copy = useCopyAction(command);
  return (
    <div
      className="ui-row"
      style={{
        gap: 'var(--sp-4)',
        marginTop: 'var(--sp-6)',
        borderBottom: `1px solid ${SURFACE.border}`,
        background: '#ffffff04',
      }}
    >
      <input
        aria-label={label}
        readOnly
        value={command}
        onFocus={(event) => event.currentTarget.select()}
        style={{
          minWidth: 0,
          width: 0,
          flex: 1,
          fontFamily: 'monospace',
          fontSize: 'var(--fs-3)',
          padding: 'var(--sp-4)',
          color: SURFACE.text,
          background: 'transparent',
          border: 'none',
          borderRadius: 0,
        }}
      />
      <button
        type="button"
        style={{ ...buttonStyle, color: '#a6c7ff', fontSize: 'var(--fs-3)' }}
        onClick={copy.copy}
        aria-label={`${COPY_LABEL[copy.state]} ${label}`}
      >
        {COPY_LABEL[copy.state]}
      </button>
    </div>
  );
}
