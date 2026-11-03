import {
  ALLOWED,
  type Act,
  type Attempt,
  type Done,
  type Expedition,
  type Launch,
  type State,
  attemptResult,
  counted,
  stateLabel,
} from '@unleashd/shared';
import { useAtomValue } from 'jotai';
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { listField } from '../../atoms/conversations';
import { useScrollActivity } from '../../hooks/useScrollActivity';
import { ChannelComposer, type ComposerSubmit } from './ChannelComposer';
import { ChannelLoader } from './ChannelLoader';
import { ChannelMarkdown } from './ChannelMarkdown';
import { Replying, type RowContext, renderRow } from './ChannelRows';
import {
  type WorkspaceDirectory,
  channelFeed,
  useChannelFeed,
  useThreadView,
  useWorkspaceDirectory,
} from './channel-data';
import { channelsHref } from './channels-view';
import { useAct, useExpedition, useRetired } from './expedition-api';
import './Expedition.css';

// One expedition in the Channels main pane (owner 2026-11-03 on the old modal: "ugly bad no
// white space balance" and "No chat log to discuss with the running manager"). Desktop: the
// overview where a channel sits and the manager chat where a thread sits. Phone: Overview | Chat.
// The chat is the expedition's one thread in the owner<->crew DM (server host.ts chatRoot); the
// crew answers there as manager (brief.ts CREW_ROLE).

export type Frame = 'desktop' | 'mobile';
type Props = { id: string; workspaceId: string; frame: Frame };
/** What the frame lays out: the same overview and chat for a live or a retired record. */
type Parts = {
  x: Expedition;
  /** The pill's tone: the record's state, or `retired`. */
  tone: State['t'] | 'retired';
  pill: string;
  /** What the attempts list says while it is empty. */
  noAttempts: string;
  meta: string;
  controls: ReactNode;
  chat: ReactNode;
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
  return FRAME[frame](
    {
      x,
      directory,
      tone: x.state.t,
      noAttempts: NO_ATTEMPTS[x.state.t],
      pill: PILL[x.state.t](x),
      meta: META[x.state.t](x as never, now),
      controls: <Controls x={x} workspaceId={workspaceId} />,
      chat: CHAT[x.state.t](x as never, frame, directory, 'live'),
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
    chat: CHAT[x.state.t](x as never, frame, directory, 'retired'),
  };
  return FRAME[frame](parts, workspaceId);
}

const missingText = (error: string) =>
  error === 'HTTP 404'
    ? 'This expedition is no longer listed. Retired ones are under Retired.'
    : error;

// ---- Frames: desktop two panes, phone tabs ----

const FRAME: Record<Frame, (p: Parts, workspaceId: string) => ReactNode> = {
  desktop: (p) => (
    <div className="channel-browser-panes expedition">
      <section className="channel-browser-pane ui-stack" aria-label={p.x.charter.name}>
        <Header p={p} back={null} />
        <Overview p={p} />
      </section>
      {p.chat}
    </div>
  ),
  mobile: (p, workspaceId) => <PhoneTabs p={p} workspaceId={workspaceId} />,
};

type Tab = 'overview' | 'chat';
function PhoneTabs({ p, workspaceId }: { p: Parts; workspaceId: string }) {
  const [tab, setTab] = useState<Tab>('overview');
  const panel: Record<Tab, ReactNode> = { overview: <Overview p={p} />, chat: p.chat };
  return (
    <section className="expedition ui-stack" data-frame="mobile" aria-label={p.x.charter.name}>
      <Header p={p} back={channelsHref(workspaceId, { kind: 'home' })} />
      <div className="expedition-tabs ui-row" role="tablist">
        {(['overview', 'chat'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
          >
            {t === 'overview' ? 'Overview' : 'Chat'}
          </button>
        ))}
      </div>
      {panel[tab]}
    </section>
  );
}

function Header({ p, back }: { p: Parts; back: string | null }) {
  return (
    <header className="channel-browser-pane-header expedition-head ui-row">
      {back && (
        <Link className="expedition-back" to={back} aria-label="Back to channels">
          ‹
        </Link>
      )}
      <div className="expedition-head-text ui-stack">
        <div className="expedition-head-title ui-row">
          <h2 className="ui-truncate">⛺ {p.x.charter.name}</h2>
          <span className="expedition-pill" data-state={p.tone}>
            {p.pill}
          </span>
        </div>
        <p className="expedition-head-meta ui-truncate ui-muted">{p.meta}</p>
      </div>
      {p.controls}
    </header>
  );
}

// ---- Header text per state ----

const PILL: { [K in State['t']]: (x: Expedition) => string } = {
  draft: () => 'Draft',
  running: () => 'Running',
  paused: () => 'Paused',
  finished: stateLabel,
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
  const button = (label: string, send: Act, tone: 'primary' | 'plain' = 'plain') => (
    <button
      type="button"
      className="expedition-button"
      data-tone={tone}
      disabled={act.state.t === 'pending'}
      onClick={() => act.run(send)}
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
      {can('launch') && button('Launch', { do: 'launch' }, 'primary')}
      {can('resume') && button('Resume', { do: 'resume' }, 'primary')}
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
      {can('relaunch') && (
        <button
          type="button"
          className="expedition-button"
          disabled={act.state.t === 'pending'}
          onClick={() => act.run({ do: 'relaunch' }, (next) => open(next.id))}
        >
          Relaunch
        </button>
      )}
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

// ---- Overview ----

function Overview({ p }: { p: Parts }) {
  const { x } = p;
  const scroll = useScrollActivity();
  return (
    <div
      className="channel-browser-scroll ui-scroll-quiet expedition-overview"
      data-scrolling={scroll['data-scrolling']}
      onScroll={scroll.onScroll}
    >
      {x.state.t === 'draft' && x.state.issues.length > 0 && (
        <section className="expedition-issues ui-stack" aria-label="Launch is blocked">
          <strong>Launch is blocked until these are fixed</strong>
          <ul>
            {x.state.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        </section>
      )}
      <Section title="Goal">
        <Goal text={x.charter.goal} directory={p.directory} />
      </Section>
      <Section title="Done when">{DONE[x.charter.done.t](x.charter.done as never)}</Section>
      <Section title="Attempts">
        <Attempts x={x} empty={p.noAttempts} />
      </Section>
      {x.notes.length > 0 && (
        <Section title="Notes for the crew">
          <ul className="expedition-notes">
            {x.notes.map((n) => (
              <li key={`${n.at}-${n.text}`}>{n.text}</li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function Section({ title, meta, children }: { title: string; meta?: string; children: ReactNode }) {
  return (
    <section className="expedition-section ui-stack">
      <header className="ui-section__header">
        <h3 className="ui-section__title">{title}</h3>
        {meta && <span className="ui-section__meta">{meta}</span>}
      </header>
      {children}
    </section>
  );
}

/** The goal's markdown, clamped to a few lines until "Show more". */
function Goal({ text, directory }: { text: string; directory: WorkspaceDirectory }) {
  const body = useMemo(() => ({ t: 'text' as const, text }), [text]);
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [clipped, setClipped] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the goal changes
  useLayoutEffect(() => {
    const node = ref.current;
    if (node && !open) setClipped(node.scrollHeight > node.clientHeight + 1);
  }, [text, open]);
  return (
    <div className="expedition-goal ui-stack">
      <div ref={ref} className="expedition-goal-text" data-open={open}>
        <ChannelMarkdown body={body} buddyNames={directory.buddyNames} tasks={directory.taskById} />
      </div>
      {(clipped || open) && (
        <button type="button" className="expedition-more" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

const DONE: { [K in Done['t']]: (d: Extract<Done, { t: K }>) => ReactNode } = {
  checks: (d) => (
    <ul className="expedition-checks ui-stack">
      {d.checks.map((argv) => (
        <li key={argv.join('\0')}>
          <code title={argv.join(' ')}>{argv.join(' ')}</code>
        </li>
      ))}
    </ul>
  ),
  owner: () => <p className="expedition-plain">You judge each attempt: pass or fail.</p>,
};

type Tone = 'pass' | 'fail' | 'live' | 'waiting' | 'quiet';
function toneOf(a: Attempt): Tone {
  const p = a.phase;
  switch (p.t) {
    case 'starting':
    case 'running':
      return 'live';
    case 'interrupted':
      return 'quiet';
    case 'judging':
      return 'waiting';
    case 'judged':
      return p.verdict.t === 'skipped' ? 'quiet' : p.verdict.pass ? 'pass' : 'fail';
  }
}

function Attempts({ x, empty }: { x: Expedition; empty: string }) {
  const act = useAct(x.id);
  if (x.attempts.length === 0) return <p className="expedition-plain ui-muted">{empty}</p>;
  const verdict = x.charter.done.t === 'owner' && ALLOWED.verdict.includes(x.state.t);
  return (
    <>
      <ol className="expedition-attempts">
        {[...x.attempts].reverse().map((a) => {
          const p = a.phase;
          const lesson = 'end' in p && p.end.lesson.t === 'lesson' ? p.end.lesson.text : null;
          return (
            <li key={a.n} className="expedition-attempt">
              <span className="expedition-attempt-n">a{a.n}</span>
              <div className="expedition-attempt-body ui-stack">
                <div className="ui-row expedition-attempt-line">
                  <span className="expedition-attempt-result" data-tone={toneOf(a)}>
                    {attemptResult(a, x.charter.done)}
                  </span>
                  <span className="ui-muted">{when(a.startedAt)}</span>
                </div>
                {lesson && <p className="expedition-attempt-lesson">{lesson}</p>}
                <code className="expedition-attempt-branch ui-truncate" title={a.branch}>
                  {a.branch}
                </code>
              </div>
              {verdict && p.t === 'judging' && (
                <span className="expedition-verdict ui-row">
                  <button
                    type="button"
                    className="expedition-button"
                    data-tone="primary"
                    disabled={act.state.t === 'pending'}
                    onClick={() => act.run({ do: 'verdict', n: a.n, pass: true })}
                  >
                    Pass
                  </button>
                  <button
                    type="button"
                    className="expedition-button"
                    disabled={act.state.t === 'pending'}
                    onClick={() => act.run({ do: 'verdict', n: a.n, pass: false })}
                  >
                    Fail
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ol>
      {act.state.t === 'failed' && <p className="expedition-error">{act.state.error}</p>}
    </>
  );
}

// ---- The manager chat ----

/** A live record's chat takes posts; a retired one's is history. */
type ChatMode = 'live' | 'retired';
const UNLAUNCHED: Record<ChatMode, string> = {
  live: "The manager's chat opens when you launch the expedition.",
  retired: 'This expedition was never launched, so it has no chat.',
};
const launched = (
  x: { state: { launch: Launch } },
  frame: Frame,
  d: WorkspaceDirectory,
  m: ChatMode
) => <ManagerChat launch={x.state.launch} frame={frame} directory={d} writable={m === 'live'} />;
const CHAT: {
  [K in State['t']]: (
    x: Expedition & { state: Extract<State, { t: K }> },
    frame: Frame,
    directory: WorkspaceDirectory,
    mode: ChatMode
  ) => ReactNode;
} = {
  draft: (_x, frame, _d, mode) => <QuietChat frame={frame} text={UNLAUNCHED[mode]} />,
  running: launched,
  paused: launched,
  finished: launched,
};
const SUBMIT: Record<Frame, ComposerSubmit> = { desktop: 'enter', mobile: 'button' };

function ChatFrame({ frame, children }: { frame: Frame; children: ReactNode }) {
  return (
    <aside className="channel-thread ui-stack expedition-chat" data-frame={frame} aria-label="Chat">
      <header className="channel-thread-header ui-row">
        <div>
          <h2>Manager</h2>
          <p>Ask about attempts, steer, or relaunch</p>
        </div>
      </header>
      {children}
    </aside>
  );
}

function QuietChat({ frame, text }: { frame: Frame; text: string }) {
  return (
    <ChatFrame frame={frame}>
      <p className="expedition-chat-empty ui-muted">{text}</p>
    </ChatFrame>
  );
}

/** Finds the chat thread's root (the host's `expedition_chat` post) in the owner<->crew DM. */
function ManagerChat({
  launch,
  frame,
  directory,
  writable,
}: { launch: Launch; frame: Frame; directory: WorkspaceDirectory; writable: boolean }) {
  const feed = useChannelFeed(channelFeed(launch.chatChannelId));
  const root = feed.posts?.find((p) => p.purpose === 'expedition_chat');
  return (
    <ChatFrame frame={frame}>
      {root ? (
        <ChatThread
          channelId={launch.chatChannelId}
          rootId={root.id}
          frame={frame}
          directory={directory}
          writable={writable}
        />
      ) : (
        <ChannelLoader label="Opening the chat…" />
      )}
    </ChatFrame>
  );
}

function ChatThread({
  channelId,
  rootId,
  frame,
  directory,
  writable,
}: {
  channelId: string;
  rootId: string;
  frame: Frame;
  directory: WorkspaceDirectory;
  writable: boolean;
}) {
  const navigate = useNavigate();
  const availableConversationIds = useAtomValue(listField('idSet'));
  const scroll = useScrollActivity();
  const view = useThreadView(channelId, rootId, null, directory.buddyNames);
  const context: RowContext = {
    workspaceId: directory.workspaceId,
    directory,
    availableConversationIds,
    linkedPostId: null,
    openDm: (conversationId) =>
      navigate(channelsHref(directory.workspaceId, { kind: 'dm', conversationId })),
    place: { kind: 'thread' },
  };
  return (
    <>
      <div
        className="channel-browser-scroll ui-stack ui-scroll-quiet"
        data-scrolling={scroll['data-scrolling']}
        ref={view.follow.scrollRef}
        onScroll={(event) => {
          view.follow.onScroll(event);
          scroll.onScroll();
        }}
      >
        {view.replyRows.length === 0 && view.replying === undefined ? (
          <p className="expedition-chat-empty ui-muted">
            Ask the manager anything: what an attempt learned, which branch to look at. Short
            commands apply at once: pause, resume, stop, extend 2h, pass, fail, note: …
          </p>
        ) : (
          <ol className="channel-browser-messages">
            {view.replyRows.map((row) => renderRow(row, context))}
          </ol>
        )}
        {view.replying !== undefined && (
          <div className="channel-thread-replying">
            <Replying text={view.replying} />
          </div>
        )}
      </div>
      {writable && (
        <ChannelComposer
          channelId={channelId}
          rootId={rootId}
          placeholder="Message the manager"
          references={directory.references}
          submit={SUBMIT[frame]}
          onPosted={view.onPosted}
        />
      )}
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
