import type { ExpeditionAttempt, ExpeditionView } from '@unleashd/shared';
import { useAtomValue } from 'jotai';
import { type CSSProperties, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { listField } from '../../atoms/conversations';
import { invalidateChannelResources } from '../../atoms/resources';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { ChannelComposer } from './ChannelComposer';
import { type RowContext, renderRows } from './ChannelRows';
import {
  channelFeed,
  channelRows,
  useChannelFeed,
  useWithOutbox,
  useWorkspaceDirectory,
} from './channel-data';
import { channelsHref } from './channels-view';
import {
  FOCI,
  type Focus,
  QUESTION_GLYPH,
  attemptState,
  expeditionUrl,
  runLabel,
} from './expedition-view';
import './ChannelBrowser.css';
import './TaskPage.css';

// The expedition page: lean by design. A header says what it is and how it is going; ONE focus
// pane (workers, tasks, reflections or goal) sits beside the expedition chat, where every update
// lands and where the owner talks to the crew. Narrow layouts show one pane at a time.
// Styles reuse existing classes plus token inline styles (client CSS is at its G8 ceiling).

const POLL_MS = 5_000;
const pre: CSSProperties = {
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  margin: 0,
  fontSize: 'var(--fs-2)',
  color: 'var(--text-secondary)',
};
const column: CSSProperties = { minWidth: 0, overflowY: 'auto', height: '100%' };

export function ExpeditionPage({ layout }: { layout: 'wide' | 'narrow' }) {
  const { id = '' } = useParams();
  const view = usePolledFetch<ExpeditionView>(expeditionUrl(id), POLL_MS);
  const [focus, setFocus] = useState<Focus>(layout === 'wide' ? 'workers' : 'chat');
  if (!view.data)
    return (
      <output className="buddy-panel__empty">
        {view.kind === 'failed' ? view.error.message : 'Loading expedition…'}
      </output>
    );
  const v = view.data;
  const foci = layout === 'wide' ? FOCI.filter((f) => f.focus !== 'chat') : FOCI;
  const chat = v.crew.t === 'ready' && (
    <ExpeditionChat channelId={v.crew.chatChannelId} workspaceId={v.workspaceId} />
  );
  return (
    <section
      className="task-page ui-stack"
      aria-label={`Expedition ${v.name}`}
      style={{ height: '100%', minHeight: 0, padding: 'var(--sp-4)', boxSizing: 'border-box' }}
    >
      <Header v={v} />
      <nav className="ui-row" aria-label="Focus">
        {foci.map((f) => (
          <button
            key={f.focus}
            type="button"
            className={focus === f.focus ? 'ui-badge ui-badge--active' : 'ui-choice'}
            aria-pressed={focus === f.focus}
            onClick={() => setFocus(f.focus)}
          >
            {f.label}
            {f.focus === 'workers'
              ? ` · ${v.attempts.filter((a) => a.phase !== 'ended').length}`
              : ''}
            {f.focus === 'tasks' ? ` · ${v.questions.length}` : ''}
          </button>
        ))}
      </nav>
      {view.kind === 'stale' && <p role="alert">{view.error.message}</p>}
      {layout === 'wide' ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
            gap: 'var(--sp-4)',
            flex: 1,
            minHeight: 0,
          }}
        >
          <div style={column}>
            <FocusPane focus={focus} v={v} />
          </div>
          <div style={{ minWidth: 0, minHeight: 0, height: '100%' }}>{chat}</div>
        </div>
      ) : (
        <div style={{ ...column, flex: 1 }}>
          {focus === 'chat' ? chat : <FocusPane focus={focus} v={v} />}
        </div>
      )}
    </section>
  );
}

function Header({ v }: { v: ExpeditionView }) {
  return (
    <header className="task-page-section ui-stack">
      <h1 className="task-page-heading">⛺ {v.name}</h1>
      <div className="task-page-actions ui-row">
        <span className="ui-badge">{runLabel(v.run)}</span>
        <span className="ui-muted">
          {v.counts.live} live · {v.counts.queued} queued · {v.counts.verified} verified ·{' '}
          {v.counts.attempts}/{v.counts.maxAttempts} attempts
        </span>
      </div>
      <p className="ui-muted" style={{ margin: 0 }}>
        {v.goal}
      </p>
      {v.run.t === 'waiting_owner' && (
        <output className="task-page-next ui-surface ui-card" style={{ margin: 0 }}>
          Needs you: {v.run.question} Reply in the chat.
        </output>
      )}
      {v.run.t === 'finished' && (
        <p className="ui-surface ui-card" style={{ margin: 0 }}>
          {v.run.summary}
        </p>
      )}
    </header>
  );
}

function FocusPane({ focus, v }: { focus: Focus; v: ExpeditionView }) {
  switch (focus) {
    case 'workers':
      return <Workers v={v} />;
    case 'tasks':
      return <Tasks v={v} />;
    case 'reflections':
      return <Reflections v={v} />;
    case 'charter':
      return <Charter v={v} />;
    case 'chat':
      return null;
  }
}

function AttemptRow({ a }: { a: ExpeditionAttempt }) {
  return (
    <details className="ui-surface ui-card">
      <summary className="ui-choice">
        {a.id} · {a.label} · {attemptState(a)}
      </summary>
      <p className="ui-muted">Instructions</p>
      <pre style={pre}>{a.brief ?? 'Not briefed yet (queued).'}</pre>
    </details>
  );
}

function Workers({ v }: { v: ExpeditionView }) {
  const active = v.attempts.filter((a) => a.phase !== 'ended');
  const ended = v.attempts.filter((a) => a.phase === 'ended').reverse();
  return (
    <section className="ui-stack" aria-label="Workers">
      <h2 className="ui-section__title">Running and queued · {active.length}</h2>
      {active.length === 0 ? (
        <p className="buddy-panel__empty">Nothing running right now.</p>
      ) : (
        active.map((a) => <AttemptRow key={a.id} a={a} />)
      )}
      {ended.length > 0 && (
        <details className="ui-stack">
          <summary className="ui-choice">Finished · {ended.length}</summary>
          {ended.map((a) => (
            <AttemptRow key={a.id} a={a} />
          ))}
        </details>
      )}
    </section>
  );
}

function Tasks({ v }: { v: ExpeditionView }) {
  const open = v.questions.filter((q) => q.status === 'open');
  const closed = v.questions.filter((q) => q.status !== 'open');
  const row = (q: ExpeditionView['questions'][number]) => (
    <details key={q.id} className="ui-surface ui-card">
      <summary className="ui-choice">
        {QUESTION_GLYPH[q.status]} {q.title} · {q.scope} · {q.attempts.length} attempts
      </summary>
      <pre style={pre}>{q.detail}</pre>
      {q.attempts.length > 0 && <p className="ui-muted">Attempts: {q.attempts.join(', ')}</p>}
    </details>
  );
  return (
    <section className="ui-stack" aria-label="Tasks">
      <h2 className="ui-section__title">Open · {open.length}</h2>
      {open.length === 0 ? (
        <p className="buddy-panel__empty">No open tasks; the manager plans them.</p>
      ) : (
        open.map(row)
      )}
      {closed.length > 0 && (
        <details className="ui-stack">
          <summary className="ui-choice">Verified or dropped · {closed.length}</summary>
          {closed.map(row)}
        </details>
      )}
    </section>
  );
}

function Reflections({ v }: { v: ExpeditionView }) {
  return (
    <section className="ui-stack" aria-label="Reflections">
      {v.lessons.length > 0 && (
        <section className="ui-surface ui-card ui-stack">
          <h2 className="ui-section__title">Your lessons (in every brief)</h2>
          {v.lessons.map((lesson) => (
            <p key={lesson} style={{ margin: 0 }}>
              {lesson}
            </p>
          ))}
        </section>
      )}
      <h2 className="ui-section__title">Manager reflections · {v.reflections.length}</h2>
      {v.reflections.length === 0 ? (
        <p className="buddy-panel__empty">No reflections yet.</p>
      ) : (
        [...v.reflections].reverse().map((r) => (
          <article key={r.at} className="ui-surface ui-card">
            <p className="ui-muted" style={{ margin: 0 }}>
              {new Date(r.at).toLocaleString()}
            </p>
            <pre style={pre}>{r.text}</pre>
          </article>
        ))
      )}
    </section>
  );
}

function Charter({ v }: { v: ExpeditionView }) {
  const list = (items: string[]) =>
    items.length === 0 ? (
      <p className="buddy-panel__empty">Not listed.</p>
    ) : (
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    );
  return (
    <section className="ui-stack" aria-label="Goal">
      <h2 className="ui-section__title">Goal</h2>
      <pre style={pre}>{v.goal}</pre>
      <h2 className="ui-section__title">Done when</h2>
      {list(v.done)}
      <h2 className="ui-section__title">In scope</h2>
      {list(v.inScope)}
      <h2 className="ui-section__title">Out of scope</h2>
      {list(v.outOfScope)}
      <h2 className="ui-section__title">Crew</h2>
      <p className="ui-muted">
        Manager {v.roster.manager} · work {v.roster.work.join(', ')} · checks{' '}
        {v.roster.check.join(', ')}
      </p>
      <p className="ui-muted">
        Up to {v.counts.maxLive} live · explore budget {v.counts.exploreCap} attempts · deadline{' '}
        {new Date(v.deadline).toLocaleString()}
      </p>
    </section>
  );
}

/** The owner↔crew DM: every update lands here; a post wakes the crew to answer or steer. */
function ExpeditionChat({ channelId, workspaceId }: { channelId: string; workspaceId: string }) {
  const navigate = useNavigate();
  const directory = useWorkspaceDirectory(workspaceId);
  const feed = useChannelFeed(channelFeed(channelId));
  const posts = useWithOutbox(channelId, null, feed.posts);
  const availableConversationIds = useAtomValue(listField('idSet'));
  const context: RowContext = {
    workspaceId,
    directory,
    availableConversationIds,
    linkedPostId: null,
    openDm: (conversationId) => navigate(channelsHref(workspaceId, { kind: 'dm', conversationId })),
    place: { kind: 'thread' },
  };
  return (
    // The chat fills its column: messages scroll, the composer stays pinned below them.
    <section
      className="ui-stack"
      aria-label="Expedition chat"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <h2 className="ui-section__title">Chat</h2>
      {posts === null ? (
        <p className="buddy-panel__empty">Loading chat…</p>
      ) : (
        <ol
          className="channel-browser-messages"
          style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}
        >
          {renderRows(channelRows(posts), context, null)}
        </ol>
      )}
      <ChannelComposer
        channelId={channelId}
        rootId={null}
        placeholder="Ask the expedition, or give it a lesson…"
        references={directory.references}
        submit="enter"
        onPosted={() => invalidateChannelResources(channelId, [])}
      />
    </section>
  );
}
