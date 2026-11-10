import type { ConversationRow as Row, RowKind } from '@unleashd/shared';
import { useAtomValue } from 'jotai';
import { memo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { setConversationDone } from '../../atoms/actions';
import { rowFamily, unreadFamily } from '../../atoms/conversations';
import { promoteWorker } from '../../atoms/ui';
import { useTimeTick } from '../../hooks/useTimeTick';
import { isRowRunning } from '../../utils/conversation-row';
import { normalizeFolderDirectory, shortenHomePath } from '../../utils/directories';
import { getProjectColor } from '../../utils/projectColors';
import { formatTimeAgo, getConversationLastActivity, getMinutesElapsed } from '../../utils/time';
import './ConversationRow.css';

/**
 * ConversationRow — the one conversation row, shared by the desktop Sidebar
 * (`sidebar`), the desktop Gallery (`card`) and the mobile lists (`list`).
 *
 * One subscription path for every variant: the row reads only its own
 * `rowFamily(id)` + `unreadFamily(id)` and the shared 30 s tick, and is
 * memoized, so an event for another conversation re-renders nothing here.
 * `rowFamily(id)` being absent IS the availability check (AGENTS.md "open this
 * conversation"): a row the client no longer holds renders nothing, so every
 * `<Link to=/chat/:id>` below points at a thread the client can open.
 *
 * The variant is chosen by the caller (the shell), never by the device.
 */

/** Null while disconnected: the command would be dropped, so Done is disabled. */
export type RowDoneHandler = ((id: string) => void) | null;

export type ConversationRowProps =
  | {
      variant: 'sidebar';
      id: string;
      active: boolean;
      /** Grouped sidebar views hide the badge; the group header already names the folder. */
      folder: 'badge' | 'hidden';
      onDone: RowDoneHandler;
    }
  | {
      variant: 'card';
      id: string;
      worker: boolean;
      doneView: boolean;
      workersView: boolean;
      connected: boolean;
    }
  | { variant: 'list'; id: string; routeState: Record<string, unknown> };

type RowStatus = 'running' | 'queued' | 'unread' | 'idle';

const STATUS_LABEL: Record<RowStatus, string> = {
  running: 'Conversation is running',
  queued: 'Conversation has queued work',
  unread: 'Conversation finished with unread messages',
  idle: 'Conversation idle',
};

/** What every variant shows, derived once from the canonical row. */
interface RowFacts {
  conv: Row;
  status: RowStatus;
  unread: boolean;
  lastActivity: Date;
  timeAgo: string;
  dirDisplay: string;
  folderName: string;
  href: string;
}

function rowStatus(conv: Row, unread: boolean): RowStatus {
  if (isRowRunning(conv)) return 'running';
  if (conv.run === 'queued') return 'queued';
  return unread ? 'unread' : 'idle';
}

function rowFacts(conv: Row, unread: boolean): RowFacts {
  const directory = normalizeFolderDirectory(conv.cwd);
  const dirDisplay = shortenHomePath(directory);
  const lastActivity = getConversationLastActivity(conv);
  return {
    conv,
    status: rowStatus(conv, unread),
    unread,
    lastActivity,
    timeAgo: formatTimeAgo(lastActivity),
    dirDisplay,
    folderName: directory.split('/').filter(Boolean).pop() ?? dirDisplay,
    href: `/chat/${encodeURIComponent(conv.id)}`,
  };
}

function StatusDot({ status }: { status: RowStatus }) {
  return (
    <span
      className="conversation-row__dot"
      data-status={status}
      role="img"
      aria-label={STATUS_LABEL[status]}
    />
  );
}

export const ConversationRow = memo(function ConversationRow(props: ConversationRowProps) {
  const conv = useAtomValue(rowFamily(props.id));
  const unread = useAtomValue(unreadFamily(props.id));
  useTimeTick();
  if (!conv) return null;
  const facts = rowFacts(conv, unread);
  switch (props.variant) {
    case 'sidebar':
      return <SidebarRow facts={facts} {...props} />;
    case 'card':
      return <CardRow facts={facts} {...props} />;
    case 'list':
      return <ListRow facts={facts} {...props} />;
  }
});

// ── sidebar: ONE line — [folder] title — time [dot], Done as a hover overlay ──

/**
 * Exponential decay for time-ago brightness: 100% bright at 0 min, ~40% at
 * 30 min, ~15% at 60 min (half-life ~23 min), blending --text-bright into
 * --text-muted.
 */
function timeAgoColor(minutesElapsed: number): string {
  const brightPct = Math.round(100 * Math.exp(-0.03 * minutesElapsed));
  return `color-mix(in oklch, var(--text-bright) ${brightPct}%, var(--text-muted))`;
}

const FOLDER_LABEL: Record<RowKind['t'], (folderName: string) => string> = {
  chat: (folderName) => folderName,
  worker: (folderName) => folderName,
  buddy: () => 'Buddies',
  builder: () => 'Builder',
};

function SidebarRow({
  facts,
  active,
  folder,
  onDone,
}: { facts: RowFacts } & Extract<ConversationRowProps, { variant: 'sidebar' }>) {
  const { conv } = facts;
  return (
    <div
      className={`conversation-row conversation-row--sidebar ui-row${active ? ' conversation-row--active' : ''}`}
    >
      <Link
        to={facts.href}
        className="conversation-row__line ui-row"
        title={`${conv.label} — ${facts.timeAgo}`}
      >
        {folder === 'badge' && (
          <span
            className="conversation-row__folder ui-truncate"
            style={{ color: getProjectColor(normalizeFolderDirectory(conv.cwd)) }}
            title={facts.dirDisplay}
          >
            {FOLDER_LABEL[conv.kind.t](facts.folderName)}
          </span>
        )}
        <span className="conversation-row__title">{conv.label}</span>
        <span className="conversation-row__sep ui-muted" aria-hidden="true">
          —
        </span>
        <span
          className="conversation-row__time ui-muted"
          style={{ color: timeAgoColor(getMinutesElapsed(facts.lastActivity)) }}
        >
          {facts.timeAgo}
        </span>
        <StatusDot status={facts.status} />
      </Link>
      <button
        type="button"
        className="conversation-row__done ui-card"
        disabled={onDone === null}
        title={onDone === null ? 'Reconnecting to the server' : undefined}
        onClick={() => onDone?.(conv.id)}
      >
        Done
      </button>
    </div>
  );
}

// ── card: the Gallery tile — id + provider, state, Restore/Promote, label ──

function CardAction({
  conv,
  worker,
  connected,
}: {
  conv: Row;
  worker: boolean;
  connected: boolean;
}) {
  const navigate = useNavigate();
  if (conv.done) {
    return (
      <button
        type="button"
        className="conversation-row__card-action ui-card"
        disabled={!connected}
        title={connected ? undefined : 'Reconnecting to the server'}
        onClick={() => {
          // Restore opens the thread as well as un-marking it. Un-marking alone
          // makes the card vanish from the Done view with no visible
          // destination, which reads as "Restore did nothing".
          setConversationDone(conv.id, false);
          navigate(`/chat/${encodeURIComponent(conv.id)}`);
        }}
      >
        Restore
      </button>
    );
  }
  if (!worker) return null;
  return (
    <button
      type="button"
      className="conversation-row__card-action ui-card"
      onClick={() => promoteWorker(conv.id)}
    >
      Promote
    </button>
  );
}

function CardRow({
  facts,
  worker,
  doneView,
  workersView,
  connected,
}: { facts: RowFacts } & Extract<ConversationRowProps, { variant: 'card' }>) {
  const { conv } = facts;
  const dimmed = (conv.done && !doneView) || (worker && !workersView && !conv.done);
  const running = facts.status === 'running';
  return (
    <div
      className={`conversation-row conversation-row--card${dimmed ? ' conversation-row--dimmed' : ''}`}
      style={{ borderTopColor: getProjectColor(conv.cwd) }}
    >
      {/* Stretched link: the whole card opens the thread; the action buttons
          sit above it (z-index) so a <button> never nests inside an <a>. */}
      <Link to={facts.href} className="conversation-row__open" aria-label={conv.label} />
      <div className="conversation-row__card-header ui-row">
        <div className="conversation-row__card-id ui-row">
          {conv.id.substring(0, 8)}
          <span className={`provider-badge provider-${worker ? 'worker' : conv.provider}`}>
            {worker ? 'worker' : conv.provider}
          </span>
        </div>
        <div className="conversation-row__card-status ui-row">
          <CardAction conv={conv} worker={worker} connected={connected} />
          <span className="conversation-row__state ui-inline-row ui-muted">
            <StatusDot status={facts.status} />
            {running ? 'Running' : `Idle · ${facts.timeAgo}`}
          </span>
        </div>
      </div>
      <div>{conv.messageCount} messages</div>
      {/* Cards show the row label: lists carry no message bodies (protocol v3). */}
      <div className="conversation-row__card-label ui-card">
        {conv.messageCount === 0 ? 'No messages yet' : conv.label}
      </div>
    </div>
  );
}

// ── list: the mobile two-line card — folder, badges, time, dot / label / path ──

function ListRow({
  facts,
  routeState,
}: { facts: RowFacts } & Extract<ConversationRowProps, { variant: 'list' }>) {
  const { conv } = facts;
  return (
    <Link
      to={facts.href}
      state={routeState}
      className="conversation-row conversation-row--list ui-card ui-stack"
    >
      <div className="conversation-row__top ui-row">
        <span className="conversation-row__list-title ui-truncate" title={facts.dirDisplay}>
          {facts.folderName}
        </span>
        <span className="conversation-row__meta ui-row">
          {conv.done && <span className="conversation-row__badge ui-card ui-muted">Done</span>}
          {facts.unread && (
            <span className="conversation-row__badge conversation-row__badge--accent ui-card">
              New
            </span>
          )}
          <span className="conversation-row__time ui-muted">{facts.timeAgo}</span>
          <StatusDot status={facts.status} />
        </span>
      </div>
      <div className="conversation-row__preview ui-truncate" title={conv.label}>
        {conv.label}
      </div>
      <span className="conversation-row__path ui-truncate ui-muted">{facts.dirDisplay}</span>
    </Link>
  );
}
