import { type ReactNode, useState } from 'react';
import { errorText } from './api';
import { TypingDots } from './ChannelMarkdown';
import './ReplyStatus.css';

// Pattern: one-definition (docs/patterns.md#one-definition)
// One operational status in DMs and channel replies, on both shells. Transport errors replace
// its detail rather than creating more transcript rows. Guard: channel-dm retry lifecycle.
export function ReplyStatus({
  message,
  pending,
  retry,
  children,
}: {
  message: string;
  pending: boolean;
  retry?: () => Promise<unknown>;
  children?: ReactNode;
}) {
  const [action, setAction] = useState<
    { kind: 'idle' | 'pending' } | { kind: 'failed'; message: string }
  >({ kind: 'idle' });
  const busy = pending || action.kind === 'pending';
  return (
    <div
      className="channel-reply-status ui-card ui-stack ui-muted"
      data-pending={busy || undefined}
      role={busy ? 'status' : 'alert'}
    >
      <div className="channel-reply-status__heading ui-row">
        {busy && <TypingDots />}
        <span>{busy ? 'Retrying…' : 'Couldn’t reply'}</span>
        {!busy && retry && (
          <button
            type="button"
            className="channel-inline-action"
            onClick={() => {
              setAction({ kind: 'pending' });
              retry().then(
                () => setAction({ kind: 'idle' }),
                (cause: unknown) => setAction({ kind: 'failed', message: errorText(cause) })
              );
            }}
          >
            Retry
          </button>
        )}
        {!busy && children}
      </div>
      <div className="channel-reply-status__detail">
        {action.kind === 'failed' ? action.message : message}
      </div>
    </div>
  );
}
