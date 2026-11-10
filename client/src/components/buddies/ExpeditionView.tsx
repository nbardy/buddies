import {
  ALLOWED,
  type Act,
  type Expedition,
  type State,
  counted,
  needsOwner,
  stateLabel,
} from '@unleashd/shared';
import { type KeyboardEvent, type ReactNode, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ChannelLoader } from './ChannelLoader';
import { type WorkspaceDirectory, useWorkspaceDirectory } from './channel-data';
import { channelsHref } from './channels-view';
import { type ChatMode, ExpeditionChat, useChatUnread } from './ExpeditionChat';
import { AttemptsPanel, DetailsPanel, GoalPanel, when } from './ExpeditionPanels';
import { useAct, useExpedition, useRetired } from './expedition-api';
import './Expedition.css';

// One expedition in the Channels main pane, laid out like a channel: a one-line header (name,
// pill, attempts, time left, the run's controls), then Chat | Attempts | Goal | Details. Owner
// 2026-11-03: "it should be a full chat thread and maybe some tabs for other info". The tab is
// the URL's `tab` param, so a deep link opens it and Back returns to the previous tab. Desktop
// and phone differ only in the header (the phone's is the mobile channel header).

export type Frame = 'desktop' | 'mobile';
type Props = { id: string; workspaceId: string; frame: Frame };
/** The pill: the record's state, `needs-you` while an attempt waits on the owner's verdict, or
 * `retired` (review 2026-11-03: the pill said "Running" in green while the owner was awaited). */
type Tone = State['t'] | 'needs-you' | 'retired';
/** A launched record has a chat thread; an unlaunched one says why not (and offers Launch). */
export type Chat =
  | { t: 'thread'; mode: ChatMode }
  | { t: 'unlaunched'; text: string; launch: ReactNode };
/** What the frame lays out: the same tabs for a live or a retired record. */
type Parts = {
  x: Expedition;
  tone: Tone;
  pill: string;
  meta: string;
  /** The run's controls in the header: launch, pause/resume, stop, relaunch. */
  controls: ReactNode;
  /** Details' own acts (extend, retire), or a retired record's filing line. */
  manage: ReactNode;
  noAttempts: string;
  chat: Chat;
  directory: WorkspaceDirectory;
};

export function ExpeditionView({ id, workspaceId, frame }: Props) {
  const read = useExpedition(id, 5_000);
  const directory = useWorkspaceDirectory(workspaceId);
  const now = useNow();
  if (read.data === null)
    return read.kind === 'failed' ? (
      <Gone frame={frame} workspaceId={workspaceId} text={missingText(read.error.message)} />
    ) : (
      <ChannelLoader label="Loading expedition…" />
    );
  const x = read.data;
  const tone: Tone = needsOwner(x) ? 'needs-you' : x.state.t;
  const parts: Parts = {
    x,
    directory,
    tone,
    pill: PILL[tone](x),
    meta: META[x.state.t](x as never, now),
    controls: <Controls x={x} workspaceId={workspaceId} />,
    manage: <Manage x={x} workspaceId={workspaceId} />,
    noAttempts: NO_ATTEMPTS[x.state.t],
    chat:
      x.state.t === 'draft'
        ? {
            t: 'unlaunched',
            text: 'The chat with the manager starts at launch. Read the goal, then launch.',
            launch: <Controls x={x} workspaceId={workspaceId} />,
          }
        : { t: 'thread', mode: 'live' },
  };
  return <Frame p={parts} frame={frame} workspaceId={workspaceId} />;
}

/** A retired record (`?retired=`): read-only, with Relaunch. */
export function RetiredExpeditionView({ id, workspaceId, frame }: Props) {
  const retired = useRetired(workspaceId);
  const directory = useWorkspaceDirectory(workspaceId);
  const filed = retired?.find((r) => r.record.id === id);
  if (retired === null) return <ChannelLoader label="Loading expedition…" />;
  if (!filed) return <Gone frame={frame} workspaceId={workspaceId} text="No such expedition." />;
  const x = filed.record;
  const parts: Parts = {
    x,
    directory,
    tone: 'retired',
    pill: 'Retired',
    meta: stateLabel(x),
    controls: <Relaunch x={x} workspaceId={workspaceId} />,
    manage: <p className="expedition-plain ui-muted">Retired {when(filed.at)}. Read-only.</p>,
    noAttempts: 'No attempt ran.',
    chat:
      x.state.t === 'draft'
        ? { t: 'unlaunched', text: 'This expedition was retired before it launched.', launch: null }
        : { t: 'thread', mode: 'retired' },
  };
  return <Frame p={parts} frame={frame} workspaceId={workspaceId} />;
}

const missingText = (error: string) =>
  error === 'HTTP 404'
    ? 'This expedition is no longer listed. Retired ones are under Retired.'
    : error;

// ---- Tabs ----

const TABS = ['chat', 'attempts', 'goal', 'details'] as const;
type Tab = (typeof TABS)[number];
const LABEL: Record<Tab, string> = {
  chat: 'Chat',
  attempts: 'Attempts',
  goal: 'Goal',
  details: 'Details',
};
/** With no `tab` in the URL: a draft opens on its goal (there is no chat yet), the rest on chat. */
const OPENS: Record<State['t'], Tab> = {
  draft: 'goal',
  running: 'chat',
  paused: 'chat',
  finished: 'chat',
};
const tabOf = (raw: string | null, x: Expedition): Tab =>
  TABS.find((t) => t === raw) ?? OPENS[x.state.t];

function Frame({ p, frame, workspaceId }: { p: Parts; frame: Frame; workspaceId: string }) {
  const [params, setParams] = useSearchParams();
  const tab = tabOf(params.get('tab'), p.x);
  const unread = useChatUnread(p.x.id, tab === 'chat');
  // Pushes, so Back returns to the previous tab.
  const open = (t: Tab) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', t);
      return next;
    });
  const waiting = p.tone === 'needs-you' ? p.x.attempts.filter((a) => a.phase.t === 'judging') : [];
  const badge: Record<Tab, ReactNode> = {
    chat: unread && <span className="expedition-tab-dot" role="img" aria-label="new messages" />,
    attempts: waiting.length > 0 && (
      <span
        className="expedition-tab-count"
        role="img"
        aria-label={`${waiting.length} need your verdict`}
      >
        {waiting.length}
      </span>
    ),
    goal: null,
    details: null,
  };
  const panel: Record<Tab, () => ReactNode> = {
    chat: () => <ChatPanel chat={p.chat} x={p.x} frame={frame} directory={p.directory} />,
    attempts: () => <AttemptsPanel x={p.x} empty={p.noAttempts} />,
    goal: () => <GoalPanel x={p.x} directory={p.directory} />,
    details: () => <DetailsPanel x={p.x} directory={p.directory} manage={p.manage} />,
  };
  return (
    <section
      className="channel-browser-pane expedition ui-stack"
      data-frame={frame}
      aria-label={p.x.charter.name}
    >
      {HEADER[frame](p, workspaceId)}
      <TabBar tab={tab} open={open} badge={badge} />
      <div
        className="expedition-panel ui-stack"
        role="tabpanel"
        id={`expedition-panel-${tab}`}
        aria-labelledby={`expedition-tab-${tab}`}
      >
        {panel[tab]()}
      </div>
    </section>
  );
}

type ChatProps = { x: Expedition; frame: Frame; directory: WorkspaceDirectory };
const ChatPanel = ({ chat, ...rest }: ChatProps & { chat: Chat }) =>
  CHAT_PANEL[chat.t](chat as never, rest);
const CHAT_PANEL: { [K in Chat['t']]: (c: Extract<Chat, { t: K }>, p: ChatProps) => ReactNode } = {
  thread: (c, p) => (
    <ExpeditionChat id={p.x.id} mode={c.mode} frame={p.frame} directory={p.directory} />
  ),
  unlaunched: (c) => (
    <div className="expedition-chat-empty ui-stack">
      <p className="ui-muted">{c.text}</p>
      {c.launch}
    </div>
  ),
};

/** WAI-ARIA tabs: one tab in the tab order, arrows/Home/End move and select. */
function TabBar({
  tab,
  open,
  badge,
}: {
  tab: Tab;
  open(t: Tab): void;
  badge: Record<Tab, ReactNode>;
}) {
  const key = (event: KeyboardEvent) => {
    const i = TABS.indexOf(tab);
    const moves: Record<string, number> = {
      ArrowRight: (i + 1) % TABS.length,
      ArrowLeft: (i + TABS.length - 1) % TABS.length,
      Home: 0,
      End: TABS.length - 1,
    };
    if (!(event.key in moves)) return;
    event.preventDefault();
    const next = TABS[moves[event.key]];
    open(next);
    document.getElementById(`expedition-tab-${next}`)?.focus();
  };
  return (
    <div className="expedition-tabs ui-row" role="tablist" aria-label="Expedition" onKeyDown={key}>
      {TABS.map((t) => (
        <button
          key={t}
          id={`expedition-tab-${t}`}
          type="button"
          role="tab"
          aria-selected={tab === t}
          aria-controls={`expedition-panel-${t}`}
          tabIndex={tab === t ? 0 : -1}
          onClick={() => open(t)}
        >
          {LABEL[t]}
          {badge[t]}
        </button>
      ))}
    </div>
  );
}

// ---- Header: one 60px line on desktop, the mobile channel header on a phone ----

const HEADER: Record<Frame, (p: Parts, workspaceId: string) => ReactNode> = {
  desktop: (p) => (
    <header className="channel-browser-pane-header expedition-head ui-row">
      <h2 className="ui-truncate">⛺ {p.x.charter.name}</h2>
      <Pill p={p} />
      <span className="expedition-head-meta ui-truncate ui-muted">{p.meta}</span>
      {p.controls}
    </header>
  ),
  mobile: (p, workspaceId) => (
    <header className="mobile-channel-header expedition-head ui-row">
      <Link
        className="mobile-channel-header__back"
        to={channelsHref(workspaceId, { kind: 'home' })}
        aria-label="Back"
      >
        ‹
      </Link>
      <div className="mobile-channel-header__heading expedition-phone-title">
        <h1>⛺ {p.x.charter.name}</h1>
      </div>
      <Pill p={p} />
      <div className="expedition-phone-line ui-row">
        <span className="ui-muted ui-truncate">{p.meta}</span>
        {p.controls}
      </div>
    </header>
  ),
};

const Pill = ({ p }: { p: Parts }) => (
  <span className="expedition-pill" data-state={p.tone}>
    {p.pill}
  </span>
);

const PILL: { [K in Tone]: (x: Expedition) => string } = {
  draft: () => 'Draft',
  running: () => 'Running',
  paused: () => 'Paused',
  finished: stateLabel,
  'needs-you': () => 'Needs your verdict',
  retired: () => 'Retired',
};
const NO_ATTEMPTS: Record<State['t'], string> = {
  draft: 'The first attempt starts at launch.',
  running: 'The first attempt is starting.',
  paused: 'No attempt ran before the pause.',
  finished: 'No attempt ran.',
};
const tally = (x: Expedition) => `${counted(x)}/${x.charter.maxAttempts} attempts`;
const META: {
  [K in State['t']]: (x: Expedition & { state: Extract<State, { t: K }> }, now: number) => string;
} = {
  draft: (x) => `Up to ${x.charter.maxAttempts} attempts over ${x.charter.hours} h`,
  running: (x, now) => `${tally(x)} · ${timeLeft(x.state.launch.deadline, now)}`,
  paused: (x, now) => `${tally(x)} · ${timeLeft(x.state.launch.deadline, now)}`,
  finished: (x) => `${tally(x)} · ended ${when(x.state.at)}`,
};
export function timeLeft(deadline: string, now: number): string {
  const minutes = Math.round((Date.parse(deadline) - now) / 60_000);
  if (minutes <= 0) return 'deadline reached';
  const h = Math.floor(minutes / 60);
  return `${h > 0 ? `${h} h ` : ''}${minutes % 60} min left`;
}
/** Re-renders the time left every 30 s; the record polls only when it changes. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

// ---- Acts, from the one guard table ----

function useActButton(x: Expedition) {
  const act = useAct(x.id);
  const button = (label: string, send: Act, then?: (next: Expedition) => void) => (
    <button
      type="button"
      className="expedition-button"
      data-tone={PRIMARY.has(send.do) ? 'primary' : 'plain'}
      disabled={act.state.t === 'pending'}
      onClick={() => act.run(send, then)}
    >
      {label}
    </button>
  );
  const error = act.state.t === 'failed' && (
    <span className="expedition-error ui-truncate" title={act.state.error}>
      {act.state.error}
    </span>
  );
  return { act, button, error, can: (d: Act['do']) => ALLOWED[d].includes(x.state.t) };
}
/** The main next step in its state (review 2026-11-03: Relaunch on a finished record was plain). */
const PRIMARY: ReadonlySet<Act['do']> = new Set(['launch', 'resume', 'relaunch']);

/** The header's run controls. Extend and Retire live under Details. */
function Controls({ x, workspaceId }: { x: Expedition; workspaceId: string }) {
  const { act, button, error, can } = useActButton(x);
  const navigate = useNavigate();
  const open = (id: string) => navigate(channelsHref(workspaceId, { kind: 'expedition', id }));
  return (
    <div className="expedition-controls ui-row">
      {error}
      {can('launch') && button('Launch', { do: 'launch' })}
      {can('resume') && button('Resume', { do: 'resume' })}
      {can('pause') && button('Pause', { do: 'pause' })}
      {can('stop') && (
        <Confirm label="Stop" sure="Stop for good" run={() => act.run({ do: 'stop' })} />
      )}
      {can('relaunch') && button('Relaunch', { do: 'relaunch' }, (next) => open(next.id))}
    </div>
  );
}

/** Details' acts: extend the deadline, retire the record. */
function Manage({ x, workspaceId }: { x: Expedition; workspaceId: string }) {
  const { act, error, can } = useActButton(x);
  const navigate = useNavigate();
  const retired = () => navigate(channelsHref(workspaceId, { kind: 'retired', id: x.id }));
  return (
    <div className="expedition-manage ui-row">
      {can('extend') && (
        <select
          className="expedition-button"
          aria-label="Extend the deadline"
          value=""
          disabled={act.state.t === 'pending'}
          onChange={(e) => act.run({ do: 'extend', hours: Number(e.target.value) })}
        >
          <option value="" disabled>
            Extend deadline
          </option>
          {[1, 2, 4, 8, 24].map((h) => (
            <option key={h} value={h}>
              +{h} h
            </option>
          ))}
        </select>
      )}
      {can('retire') && (
        <Confirm
          label="Retire"
          sure="Confirm retire"
          run={() => act.run({ do: 'retire' }, retired)}
        />
      )}
      {error}
    </div>
  );
}

/** An act that cannot be undone takes two clicks. */
export function Confirm({ label, sure, run }: { label: string; sure: string; run(): void }) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      type="button"
      className="expedition-button"
      data-tone={armed ? 'danger' : 'plain'}
      onClick={() => (armed ? run() : setArmed(true))}
      onBlur={() => setArmed(false)}
    >
      {armed ? sure : label}
    </button>
  );
}

/** A retired record's one act: a new draft with its charter, which the view opens. */
function Relaunch({ x, workspaceId }: { x: Expedition; workspaceId: string }) {
  const { button, error } = useActButton(x);
  const navigate = useNavigate();
  const open = (next: Expedition) =>
    navigate(channelsHref(workspaceId, { kind: 'expedition', id: next.id }));
  return (
    <div className="expedition-controls ui-row">
      {error}
      {button('Relaunch', { do: 'relaunch' }, open)}
    </div>
  );
}

export function Gone({
  frame,
  workspaceId,
  text,
}: {
  frame: Frame;
  workspaceId: string;
  text: string;
}) {
  return (
    <div className="channel-browser-empty expedition-gone ui-muted ui-row" data-frame={frame}>
      <strong>Expedition</strong>
      <span>{text}</span>
      <Link to={channelsHref(workspaceId, { kind: 'home' })}>Back to channels</Link>
    </div>
  );
}
