import { useAtomValue } from 'jotai';
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { emojiUsageAtom } from '../../atoms/emoji-usage';
import { rankEmoji } from './emoji-completion';

// Pattern: one-definition (docs/patterns.md#one-definition)
// One searchable picker for reactions; the colon menu uses the same catalog and frequency rank.
export function EmojiPicker({ onPick, onClose }: { onPick(emoji: string): void; onClose(): void }) {
  const [query, setQuery] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const previous = document.activeElement;
    dialogRef.current?.showModal();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  const usage = useAtomValue(emojiUsageAtom);
  const matches = rankEmoji(query.replace(/^:/, ''), usage);
  return createPortal(
    <dialog
      ref={dialogRef}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          onClose();
      }}
      aria-modal="true"
      aria-label="Emoji reactions"
      className="ui-stack"
      style={{
        position: 'fixed',
        inset: '50% auto auto 50%',
        transform: 'translate(-50%, -50%)',
        margin: 0,
        color: 'var(--text-bright)',
        width: 'min(360px, calc(100vw - 2 * var(--sp-6)))',
        padding: 'var(--sp-5)',
        background: 'var(--bg-panel)',
        border: '1px solid var(--border-subtle)',
        borderRadius: '10px',
        gap: 'var(--sp-4)',
      }}
    >
      <div className="ui-row" style={{ justifyContent: 'space-between' }}>
        <strong>{query ? 'Emoji' : 'Frequently used'}</strong>
        <button type="button" onClick={onClose} aria-label="Close emoji picker">
          ×
        </button>
      </div>
      <input
        autoFocus
        style={{
          width: '100%',
          boxSizing: 'border-box',
          padding: 'var(--sp-3) var(--sp-4)',
          border: '1px solid var(--border-subtle)',
          borderRadius: '6px',
          background: 'var(--bg-deep)',
          color: 'var(--text-bright)',
          font: 'inherit',
        }}
        aria-label="Search emoji"
        placeholder="Search emoji…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && matches[0]) {
            event.preventDefault();
            onPick(matches[0].emoji);
          }
        }}
      />
      <ul className="channel-composer-picker" style={{ position: 'static', boxShadow: 'none' }}>
        {matches.map((choice) => (
          <li key={choice.name}>
            <button type="button" onClick={() => onPick(choice.emoji)}>
              <span aria-hidden="true">{choice.emoji}</span>
              <span>:{choice.name}:</span>
            </button>
          </li>
        ))}
      </ul>
      {matches.length === 0 && <span className="ui-muted">No matching emoji</span>}
    </dialog>,
    document.body
  );
}
