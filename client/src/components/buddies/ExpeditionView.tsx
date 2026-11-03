import {
  ALLOWED,
  type Act,
  type Expedition,
  type State,
  counted,
  needsOwner,
  stateLabel,
} from '@unleashd/shared';
import { type ReactNode, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChannelLoader } from './ChannelLoader';
import { type ChatMode, ExpeditionChat } from './ExpeditionChat';
import { Overview } from './ExpeditionOverview';
import { type WorkspaceDirectory, useWorkspaceDirectory } from './channel-data';
import { channelsHref } from './channels-view';
import { useAct, useExpedition, useRetired } from './expedition-api';
import './Expedition.css';

// One expedition in the Channels main pane (owner 2026-11-03 on the old modal: "ugly bad no
// white space balance" and "No chat log to discuss with the running manager"). Desktop: the
// overview where a channel sits and the manager chat where a thread sits (ExpeditionChat.tsx).
// Phone: the mobile channel header, then Overview | Chat tabs.

export type Frame = 'desktop' | 'mobile';
type Props = { id: string; workspaceId: string; frame: Frame };
/** The pill: the record's state, `needs-you` while an attempt waits on the owner's verdict, or
 * `retired` (review 2026-11-03: the pill said "Running" in green while the owner was awaited). */
type Tone = State['t'] | 'needs-you' | 'retired';
/** A launched record has a chat; a draft (or a never-launched retired one) has none, so the
 * overview takes the full width (review 2026-11-03: 440px of empty column). */
type Chat = { t: 'pane'; mode: ChatMode } | { t: 'none' };
/** What the frame lays out: the same overview and chat for a live or a retired record. */
type Parts = {
  x: Expedition;
  tone: Tone;
  pill: string;
  /** What the attempts list says while it is empty. */
  noAttempts: string;
  meta: string;
  controls: ReactNode;
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
  return FRAME[frame](
    {
      x,
      directory,
      tone,
      noAttempts: NO_ATTEMPTS[x.state.t],
      pill: PILL[tone](x),
      meta: META[x.state.t](x as never, now),
      controls: <Controls x={x} workspaceId={workspaceId} />,
      chat: CHAT[x.state.t]('live'),
    },
    workspaceId
  );
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
    noAttempts: 'No attempt ran.',
    pill: 'Retired',
    meta: `${stateLabel(x)} · retired ${when(filed.at)}`,
    controls: (
      <span className="expedition-controls ui-row">
        <Relaunch id={id} workspaceId={workspaceId} />
      </span>
    ),
    chat: CHAT[x.state.t]('retired'),
  };
  return FRAME[frame](parts, workspaceId);
}

const missingText = (error: string) =>
  error === 'HTTP 404'
    ? 'This expedition is no longer listed. Retired ones are under Retired.'
    : error;

const CHAT: Record<State['t'], (mode: ChatMode) => Chat> = {
  draft: () => ({ t: 'none' }),
  running: (mode) => ({ t: 'pane', mode }),
  paused: (mode) => ({ t: 'pane', mode }),
  finished: (mode) => ({ t: 'pane', mode }),
};

// ---- Frames: desktop two panes, phone tabs ----

const FRAME: Record<Frame, (p: Parts, workspaceId: string) => ReactNode> = {
  desktop: (p) => (
    <div className="channel-browser-panes expedition">
      <section className="channel-browser-pane ui-stack" aria-label={p.x.charter.name}>
        <header className="channel-browser-pane-header expedition-head ui-row">
          <h2 className="ui-truncate">⛺ {p.x.charter.name}</h2>
          <Pill p={p} />
          <span className="expedition-head-meta ui-truncate ui-muted">· {p.meta}</span>
          {p.controls}
        </header>
        <Overview x={p.x} directory={p.directory} noAttempts={p.noAttempts} top={null} />
      </section>
      {DESKTOP_CHAT[p.chat.t](p.chat as never, p)}
    </div>
  ),
  mobile: (p, workspaceId) => <Phone p={p} workspaceId={workspaceId} />,
};
const DESKTOP_CHAT: { [K in Chat['t']]: (c: Extract<Chat, { t: K }>, p: Parts) => ReactNode } = {
  pane: (c, p) => (
    <ExpeditionChat id={p.x.id} mode={c.mode} frame="desktop" directory={p.directory} />
  ),
  none: () => null,
};

const Pill = ({ p }: { p: Parts }) => (
  <span className="expedition-pill" data-state={p.tone}>
    {p.pill}
  </span>
);

/** The mobile channel header (shared back button), then the overview's meta and controls at its
 * top (review 2026-11-03: ~145px of chrome before the tabs). */
function Phone({ p, workspaceId }: { p: Parts; workspaceId: string }) {
  const top = (
    <div className="expedition-phone-top ui-stack">
      <span className="ui-muted">{p.meta}</span>
      {p.controls}
    </div>
  );
  const overview = <Overview x={p.x} directory={p.directory} noAttempts={p.noAttempts} top={top} />;
  return (
    <section className="expedition ui-stack" data-frame="mobile" aria-label={p.x.charter.name}>
      <header className="mobile-channel-header ui-row">
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
      </header>
      {PHONE_BODY[p.chat.t](p.chat as never, p, overview)}
    </section>
  );
}
const PHONE_BODY: {
  [K in Chat['t']]: (c: Extract<Chat, { t: K }>, p: Parts, overview: ReactNode) => ReactNode;
} = {
  pane: (c, p, overview) => <PhoneTabs chat={c} p={p} overview={overview} />,
  none: (_c, _p, overview) => overview,
};

type Tab = 'overview' | 'chat';
function PhoneTabs({
  chat,
  p,
  overview,
}: { chat: Extract<Chat, { t: 'pane' }>; p: Parts; overview: ReactNode }) {
  const [tab, setTab] = useState<Tab>('overview');
  const panel: Record<Tab, ReactNode> = {
    overview,
    chat: <ExpeditionChat id={p.x.id} mode={chat.mode} frame="mobile" directory={p.directory} />,
  };
  return (
    <>
      <div className="expedition-tabs ui-row" role="tablist">
        {(['overview', 'chat'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            data-alert={t === 'chat' && p.tone === 'needs-you' ? '' : undefined}
            onClick={() => setTab(t)}
          >
            {t === 'overview' ? 'Overview' : 'Chat'}
          </button>
        ))}
      </div>
      {panel[tab]}
    </>
  );
}

// ---- Header text per state ----

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
const tally = (x: Expedition) => `${counted(x)} of ${x.charter.maxAttempts} attempts`;
const META: {
  [K in State['t']]: (x: Expedition & { state: Extract<State, { t: K }> }, now: number) => string;
} = {
  draft: (x) => `Up to ${x.charter.maxAttempts} attempts over ${x.charter.hours} h once launched`,
  running: (x, now) => `${tally(x)} · ${timeLeft(x.state.launch.deadline, now)}`,
  paused: (x, now) => `${tally(x)} · ${timeLeft(x.state.launch.deadline, now)}`,
  finished: (x) => `${tally(x)} · ended ${when(x.state.at)}`,
};
function timeLeft(deadline: string, now: number): string {
  const minutes = Math.round((Date.parse(deadline) - now) / 60_000);
  if (minutes <= 0) return 'deadline reached';
  const h = Math.floor(minutes / 60);
  return `${h > 0 ? `${h} h ` : ''}${minutes % 60} min left`;
}
const when = (iso: string) =>
  new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
/** Re-renders the time left every 30 s; the record polls only when it changes. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

// ---- Controls, from the one guard table ----

function Controls({ x, workspaceId }: { x: Expedition; workspaceId: string }) {
  const act = useAct(x.id);
  const navigate = useNavigate();
  const can = (d: Act['do']) => ALLOWED[d].includes(x.state.t);
  const open = (id: string) => navigate(channelsHref(workspaceId, { kind: 'expedition', id }));
  const retired = () => navigate(channelsHref(workspaceId, { kind: 'retired', id: x.id }));
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
  return (
    <div className="expedition-controls ui-row">
      {act.state.t === 'failed' && (
        <span className="expedition-error ui-truncate" title={act.state.error}>
          {act.state.error}
        </span>
      )}
      {can('launch') && button('Launch', { do: 'launch' })}
      {can('resume') && button('Resume', { do: 'resume' })}
      {can('pause') && button('Pause', { do: 'pause' })}
      {can('extend') && (
        <select
          className="expedition-button"
          aria-label="Extend the deadline"
          value=""
          disabled={act.state.t === 'pending'}
          onChange={(e) => act.run({ do: 'extend', hours: Number(e.target.value) })}
        >
          <option value="" disabled>
            Extend
          </option>
          {[1, 2, 4, 8, 24].map((h) => (
            <option key={h} value={h}>
              +{h} h
            </option>
          ))}
        </select>
      )}
      {can('stop') && (
        <Confirm label="Stop" sure="Stop for good" run={() => act.run({ do: 'stop' })} />
      )}
      {can('relaunch') && button('Relaunch', { do: 'relaunch' }, (next) => open(next.id))}
      {can('retire') && (
        <Confirm
          label="Retire"
          sure="Confirm retire"
          run={() => act.run({ do: 'retire' }, retired)}
        />
      )}
    </div>
  );
}
/** The main next step in its state (review 2026-11-03: Relaunch on a finished record was plain). */
const PRIMARY: ReadonlySet<Act['do']> = new Set(['launch', 'resume', 'relaunch']);

/** An act that cannot be undone takes two clicks. */
function Confirm({ label, sure, run }: { label: string; sure: string; run(): void }) {
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

function Relaunch({ id, workspaceId }: { id: string; workspaceId: string }) {
  const act = useAct(id);
  const navigate = useNavigate();
  return (
    <>
      {act.state.t === 'failed' && <span className="expedition-error">{act.state.error}</span>}
      <button
        type="button"
        className="expedition-button"
        data-tone="primary"
        disabled={act.state.t === 'pending'}
        onClick={() =>
          act.run({ do: 'relaunch' }, (next) =>
            navigate(channelsHref(workspaceId, { kind: 'expedition', id: next.id }))
          )
        }
      >
        Relaunch
      </button>
    </>
  );
}

function Gone({ frame, workspaceId, text }: { frame: Frame; workspaceId: string; text: string }) {
  return (
    <div className="channel-browser-empty expedition-gone ui-muted ui-row" data-frame={frame}>
      <strong>Expedition</strong>
      <span>{text}</span>
      <Link to={channelsHref(workspaceId, { kind: 'home' })}>Back to channels</Link>
    </div>
  );
}
