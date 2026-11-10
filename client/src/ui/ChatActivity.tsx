import type { BuddyWorkerThread } from '@unleashd/shared';
import { type ReactNode, useState } from 'react';
import { BuddyWorkerThreadBadge } from '../components/buddies/BuddyWorkerThreadBadge';
import './chat-activity.css';

// Lives in ui/ (not components/) so the channel views, which the mobile tree
// imports, reuse the chat's tool-call disclosure instead of a second one.

/** One disclosure for live tool runs and saved activity groups. */
export function ChatActivity({
  label,
  children,
  workerThreads,
}: {
  label: string;
  children: ReactNode;
  workerThreads?: BuddyWorkerThread[];
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="chat-activity">
      <button
        type="button"
        className="chat-activity-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        {label}
      </button>
      {workerThreads?.map((thread) => (
        <BuddyWorkerThreadBadge key={thread.conversationId} thread={thread} />
      ))}
      {expanded && <div className="chat-activity-history">{children}</div>}
    </div>
  );
}
