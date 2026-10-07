import { Link } from 'react-router-dom';
import { TypingDots } from './ChannelMarkdown';
import { useWakePhase } from './buddy-direct-actions';

// Wake progress next to a Buddy: dots while it checks the channels, then a
// check linking to the DM where its summary landed. Shared by the desktop rail,
// the desktop sidebar and mobile; each passes its own class for placement.
export function WakeIndicator({
  conversationId,
  name,
  className,
  doneClassName,
  linkState,
}: {
  conversationId: string;
  name: string;
  className: string;
  doneClassName: string;
  linkState?: unknown;
}) {
  const phase = useWakePhase(conversationId);
  switch (phase.kind) {
    case 'waiting':
    case 'running':
      return (
        <span className={className} title={`${name} is checking the channels`} aria-live="polite">
          <TypingDots />
        </span>
      );
    case 'done':
      return phase.available ? (
        <Link
          className={`${className} ${doneClassName}`}
          to={`/chat/${encodeURIComponent(conversationId)}`}
          state={linkState}
          title={`${name} finished checking — read the summary`}
        >
          ✓
        </Link>
      ) : null;
  }
}

export function DmIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function WakeIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle cx="8" cy="8" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}
