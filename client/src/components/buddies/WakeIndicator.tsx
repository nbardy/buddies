import { TypingDots } from './ChannelMarkdown';

// A wake is a DM post (buddy-direct-actions.ts), so there is no chat to watch for progress: the
// mark says the post went out, and the Buddy's catch-up summary lands in its DM. Shared by the
// desktop rail, the desktop sidebar and mobile; each passes its own class for placement.
export function WakeIndicator({
  name,
  className,
}: {
  name: string;
  className: string;
}) {
  return (
    <span
      className={className}
      title={`${name} was woken: its catch-up summary lands in your DM`}
      aria-live="polite"
    >
      <TypingDots />
    </span>
  );
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
