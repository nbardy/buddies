import type {
  ExpeditionAttempt,
  ExpeditionCharterView,
  ExpeditionDraftState,
  ExpeditionDraftView,
  ExpeditionValidation,
  ExpeditionView,
} from '@unleashd/shared';
import { useAtomValue } from 'jotai';
import {
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { listField } from '../../atoms/conversations';
import { invalidateChannelResources } from '../../atoms/resources';
import { COPY_LABEL, useCopyAction } from '../../hooks/useCopyAction';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { ChannelComposer } from './ChannelComposer';
import { ChannelMarkdown } from './ChannelMarkdown';
import { type RowContext, renderRows } from './ChannelRows';
import { DraftLaunchButton } from './ExpeditionDraftLaunch';
import { ModalDialog } from './ModalDialog';
import {
  type WorkspaceDirectory,
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
  type Pane,
  QUESTION_GLYPH,
  STAGE_TONE,
  attemptCostLine,
  attemptState,
  attemptTone,
  budgetLine,
  doneLines,
  draftUrl,
  durationLabel,
  expeditionUrl,
  runLabel,
  runTone,
  validationsOf,
  worktreeLine,
} from './expedition-view';
import '../FilePreview.css';
import './ChannelBrowser.css';
import './Expedition.css';

// Pattern: one-definition (docs/patterns.md#one-definition)
// The ONE expedition modal, for a live expedition and for a draft (2026-11-01 owner request: a
// modal, not a page that replaces the conversation pane). Built on the Task overlay's dialog
// (ModalDialog + .channel-task-overlay) and the file preview's markdown surface
// (.file-preview-markdown), so it reads as their sibling. `dialog` is the desktop's wide dialog
// with the chat as a right column; `sheet` is the phone's full-height sheet with the chat a tab.

export type ExpeditionTarget =
  | { t: 'live'; id: string }
  | { t: 'draft'; draftId: string; workspaceId: string };
export type Presentation = 'dialog' | 'sheet';

const POLL_MS = 5_000;

export function ExpeditionModal({
  target,
  presentation,
  onClose,
}: { target: ExpeditionTarget; presentation: Presentation; onClose(): void }) {
  switch (target.t) {
    case 'live':
      return <LiveModal id={target.id} presentation={presentation} onClose={onClose} />;
    case 'draft':
      return (
        <DraftModal
          draftId={target.draftId}
          workspaceId={target.workspaceId}
          presentation={presentation}
          onClose={onClose}
        />
      );
  }
}

/** The workspace directory the modal's markdown resolves Buddy mentions and Task refs against.
 * Provided once per modal body (WithDirectory); a markdown block outside one is a bug, named. */
const DirectoryContext = createContext<WorkspaceDirectory | null>(null);

function WithDirectory({ workspaceId, children }: { workspaceId: string; children: ReactNode }) {
  const directory = useWorkspaceDirectory(workspaceId);
  return <DirectoryContext.Provider value={directory}>{children}</DirectoryContext.Provider>;
}

/** Markdown exactly as the chat renders it (ChannelMarkdown: line breaks, buddy:/task: links,
 * highlighted code), on the file preview's document surface (FilePreview.css). */
function ExpeditionMarkdown({ text }: { text: string }) {
  const directory = useContext(DirectoryContext);
  const body = useMemo(() => ({ t: 'text' as const, text }), [text]);
  if (!directory) throw new Error('ExpeditionMarkdown outside an expedition modal body');
  return (
    <div className="file-preview-markdown expedition-markdown">
      <ChannelMarkdown body={body} buddyNames={directory.buddyNames} tasks={directory.taskById} />
    </div>
  );
}

function Shell({
  label,
  presentation,
  onClose,
  title,
  children,
}: {
  label: string;
  presentation: Presentation;
  onClose(): void;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <ModalDialog
      className={`channel-task-overlay ui-card ui-stack expedition-modal expedition-modal--${presentation}`}
      label={label}
      onClose={onClose}
    >
      <header className="channel-task-overlay-header ui-row expedition-modal-header">
        {title}
        <button
          type="button"
          className="expedition-modal-close"
          onClick={onClose}
          aria-label="Close expedition"
          title="Close (Esc)"
        >
          ✕
        </button>
      </header>
      {children}
    </ModalDialog>
  );
}

/** Waiting for the first read, or it failed: the shell with one line, so Esc still closes. */
function Pending({
  label,
  presentation,
  onClose,
  error,
}: { label: string; presentation: Presentation; onClose(): void; error: Error | null }) {
  return (
    <Shell label={label} presentation={presentation} onClose={onClose} title={<strong>⛺</strong>}>
      <output className="buddy-panel__empty">{error ? error.message : `Loading ${label}…`}</output>
    </Shell>
  );
}

/** The goal, rendered, clamped to a few lines until "Show more". */
function Goal({ goal }: { goal: string }) {
  const [open, setOpen] = useState(false);
  // About what the clamp shows (~3 lines); a shorter goal has nothing more to show.
  const long = goal.length > 240 || goal.trim().split('\n').length > 3;
  return (
    <section
      className={open || !long ? 'expedition-goal' : 'expedition-goal expedition-goal--clamped'}
      aria-label="Goal"
    >
      <ExpeditionMarkdown text={goal} />
      {long && (
        <button type="button" className="expedition-link" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </section>
  );
}

/** A plain list; keyed by position, since two entries may read the same. */
function Bullets({ items }: { items: readonly string[] }) {
  return (
    <ul>
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

function Meter({ label, value, max }: { label: string; value: number; max: number }) {
  return (
    <span className="expedition-chip" title={`${label}: ${value} of ${max}`}>
      <span className="ui-muted">{label}</span> {value}/{max}
      <meter min={0} max={max} value={value} />
    </span>
  );
}

function BranchChip({ branch, head }: { branch: string; head: string }) {
  const { state, copy } = useCopyAction(branch);
  return (
    <button
      type="button"
      className="expedition-chip expedition-chip--mono"
      onClick={copy}
      title={`${COPY_LABEL[state]} ${branch}`}
    >
      {branch} @ {head.slice(0, 7)} · {COPY_LABEL[state]}
    </button>
  );
}

// ---------- Live ----------

function LiveModal({
  id,
  presentation,
  onClose,
}: { id: string; presentation: Presentation; onClose(): void }) {
  const view = usePolledFetch<ExpeditionView>(expeditionUrl(id), POLL_MS);
  if (!view.data)
    return (
      <Pending
        label="expedition"
        presentation={presentation}
        onClose={onClose}
        error={view.kind === 'failed' ? view.error : null}
      />
    );
  const v = view.data;
  return (
    <Shell
      label={`Expedition ${v.charter.name}`}
      presentation={presentation}
      onClose={onClose}
      title={
        <>
          <strong className="expedition-modal-title">⛺ {v.charter.name}</strong>
          <span className={`expedition-pill expedition-tone-${runTone(v.run)}`}>
            {runLabel(v.run)}
          </span>
        </>
      }
    >
      <WithDirectory workspaceId={v.workspaceId}>
        <LiveBody
          v={v}
          presentation={presentation}
          stale={view.kind === 'stale' ? view.error : null}
        />
      </WithDirectory>
    </Shell>
  );
}

function LiveBody({
  v,
  presentation,
  stale,
}: { v: ExpeditionView; presentation: Presentation; stale: Error | null }) {
  const [focus, setFocus] = useState<Focus>('workers');
  const chatRef = useRef<HTMLDivElement>(null);
  const foci = presentation === 'dialog' ? FOCI.filter((f) => f.focus !== 'chat') : FOCI;
  // The dialog always shows the chat beside the tabs, so a 'chat' focus shows the workers.
  const pane: Focus = presentation === 'dialog' && focus === 'chat' ? 'workers' : focus;
  const reply = () => {
    setFocus('chat');
    requestAnimationFrame(() => chatRef.current?.querySelector('textarea')?.focus());
  };
  const counts: Record<Focus, string> = {
    workers: ` ${v.attempts.filter((a) => a.phase.t !== 'ended').length}`,
    tasks: ` ${v.questions.length}`,
    reflections: ` ${v.reflections.length}`,
    charter: '',
    chat: '',
  };
  // Arrow keys move between tabs (the WAI-ARIA tabs pattern); the pane is their tabpanel.
  const step = (by: number) => {
    const at = foci.findIndex((f) => f.focus === pane);
    const next = foci[(at + by + foci.length) % foci.length].focus;
    setFocus(next);
    document.getElementById(`expedition-tab-${next}`)?.focus();
  };
  const tabs = (
    <div
      className="expedition-tabs ui-row"
      role="tablist"
      aria-label="Expedition"
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault();
          step(event.key === 'ArrowRight' ? 1 : -1);
        }
      }}
    >
      {foci.map((f) => (
        <button
          key={f.focus}
          id={`expedition-tab-${f.focus}`}
          type="button"
          role="tab"
          aria-selected={pane === f.focus}
          aria-controls={PANEL_ID}
          tabIndex={pane === f.focus ? 0 : -1}
          className="expedition-tab"
          onClick={() => setFocus(f.focus)}
        >
          {f.label}
          <span className="ui-muted">{counts[f.focus]}</span>
        </button>
      ))}
    </div>
  );
  const chat = (
    <div ref={chatRef} className="expedition-chat-column">
      <ChatPane v={v} />
    </div>
  );
  return (
    <>
      <div className="expedition-meters ui-row">
        <Meter label="Attempts" value={v.counts.attempts} max={v.counts.maxAttempts} />
        <Meter label="Decisions" value={v.counts.decisions} max={v.counts.maxDecisions} />
        <span className="expedition-chip">
          {v.counts.live} live · {v.counts.queued} queued · {v.counts.verified} verified
        </span>
        <span
          className="expedition-chip"
          title={`Deadline ${new Date(v.deadline).toLocaleString()}`}
        >
          {durationLabel(v.launchedAt, v.now)} elapsed · {durationLabel(v.now, v.deadline)} left
        </span>
        <span className="expedition-chip" title={v.cost.line}>
          {v.cost.short}
        </span>
        <BranchChip branch={v.integration.branch} head={v.integration.head} />
      </div>
      {stale && <p role="alert">{stale.message}</p>}
      <RunCallout v={v} onReply={reply} />
      <Goal goal={v.charter.goal} />
      {presentation === 'dialog' ? (
        <div className="expedition-columns">
          <div className="expedition-main ui-stack">
            {tabs}
            <div {...panelProps(pane)}>
              <LivePane pane={pane as Pane} v={v} />
            </div>
          </div>
          {chat}
        </div>
      ) : (
        <div className="expedition-main ui-stack">
          {tabs}
          {pane === 'chat' ? (
            <div {...panelProps(pane)}>{chat}</div>
          ) : (
            <div {...panelProps(pane)}>
              <LivePane pane={pane} v={v} />
            </div>
          )}
        </div>
      )}
    </>
  );
}

const PANEL_ID = 'expedition-panel';
const panelProps = (pane: Focus) => ({
  id: PANEL_ID,
  role: 'tabpanel',
  'aria-labelledby': `expedition-tab-${pane}`,
  className: 'expedition-pane',
});

/** The owner's attention line: an open question, or how it finished; nothing while it runs. */
function RunCallout({ v, onReply }: { v: ExpeditionView; onReply(): void }) {
  switch (v.run.t) {
    case 'running':
    case 'paused':
      return null;
    case 'waiting_owner':
      return (
        <section
          className="expedition-callout expedition-tone-warn ui-stack"
          aria-label="Needs you"
        >
          <strong>Needs you</strong>
          <ExpeditionMarkdown text={v.run.question} />
          <button type="button" className="expedition-button" onClick={onReply}>
            Reply in chat
          </button>
        </section>
      );
    case 'finished':
      return (
        <section className="expedition-callout ui-stack" aria-label="Result">
          <strong>{runLabel(v.run)}</strong>
          <ExpeditionMarkdown text={v.run.summary} />
        </section>
      );
  }
}

function LivePane({ pane, v }: { pane: Pane; v: ExpeditionView }) {
  switch (pane) {
    case 'workers':
      return <Workers v={v} />;
    case 'tasks':
      return <Tasks v={v} />;
    case 'reflections':
      return <Reflections v={v} />;
    case 'charter':
      return (
        <CharterPane charter={v.charter} lessons={v.lessons}>
          {v.validations.length > 0 && (
            <Section title="Validations">
              <ul>
                {[...v.validations].reverse().map((x) => (
                  <li key={x.id}>{x.label}</li>
                ))}
              </ul>
            </Section>
          )}
        </CharterPane>
      );
  }
}

function WorkerCard({
  a,
  validations,
}: { a: ExpeditionAttempt; validations: ExpeditionValidation[] }) {
  const tree = worktreeLine(a.worktree);
  const cost = attemptCostLine(a.cost);
  return (
    <article className="expedition-card ui-stack">
      <div className="ui-row expedition-card-head">
        <span className={`expedition-dot expedition-tone-${attemptTone(a)}`} aria-hidden="true" />
        <span className="expedition-chip">{a.kind}</span>
        <strong className="ui-truncate">{a.label}</strong>
        <span className="ui-muted expedition-card-id">{a.id}</span>
      </div>
      <div className="ui-row expedition-card-meta ui-muted">
        <code>{a.seat}</code>
        <span>{attemptState(a)}</span>
        {tree && <code>{tree}</code>}
        {cost && <span>Cost: {cost}</span>}
      </div>
      {validations.map((x) => (
        <div key={x.id} className="expedition-card-meta ui-muted">
          <span className="expedition-chip">validation {x.verdict}</span>
          {x.checks.map((c) => (
            <div key={c.checkIndex}>
              {c.passed ? '✓' : '✗'} {x.id} check {c.checkIndex}: {c.outcome}
            </div>
          ))}
        </div>
      ))}
      <details open={a.live}>
        <summary className="expedition-link">Instructions</summary>
        {a.brief === null ? (
          <p className="ui-muted">Not briefed yet (queued).</p>
        ) : (
          <ExpeditionMarkdown text={a.brief} />
        )}
      </details>
    </article>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="expedition-section ui-stack">
      <h3 className="ui-section__title">{title}</h3>
      {children}
    </section>
  );
}

function Workers({ v }: { v: ExpeditionView }) {
  const active = v.attempts.filter((a) => a.phase.t !== 'ended');
  const ended = v.attempts.filter((a) => a.phase.t === 'ended').reverse();
  const card = (a: ExpeditionAttempt) => (
    <WorkerCard key={a.id} a={a} validations={validationsOf(v.validations, a.id)} />
  );
  return (
    <div className="ui-stack" aria-label="Workers">
      {v.integration.lastRefusal.t === 'refused' && (
        <p className="expedition-callout ui-muted">
          {v.integration.integrated} integrated · last refusal: {v.integration.lastRefusal.label}
        </p>
      )}
      <Section title={`Running and queued · ${active.length}`}>
        {active.length === 0 ? (
          <p className="buddy-panel__empty">Nothing running right now.</p>
        ) : (
          active.map(card)
        )}
      </Section>
      {ended.length > 0 && (
        <Section title={`Finished · ${ended.length}`}>{ended.map(card)}</Section>
      )}
    </div>
  );
}

function Tasks({ v }: { v: ExpeditionView }) {
  const open = v.questions.filter((q) => q.status === 'open');
  const closed = v.questions.filter((q) => q.status !== 'open');
  const card = (q: ExpeditionView['questions'][number]) => (
    <article key={q.id} className="expedition-card ui-stack">
      <div className="ui-row expedition-card-head">
        <span aria-hidden="true">{QUESTION_GLYPH[q.status]}</span>
        <strong>{q.title}</strong>
        <span className={`expedition-chip expedition-tone-${STAGE_TONE[q.stage]}`}>{q.stage}</span>
        <span className="ui-muted">{q.scope}</span>
      </div>
      <div className="ui-row expedition-card-meta ui-muted">
        {q.paths.map((p) => (
          <code key={p}>{p}</code>
        ))}
        {q.after.length > 0 && <span>after {q.after.join(', ')} verified</span>}
        {q.attempts.length > 0 && <span>attempts {q.attempts.join(', ')}</span>}
      </div>
      <details>
        <summary className="expedition-link">Detail</summary>
        <ExpeditionMarkdown text={q.detail} />
      </details>
    </article>
  );
  return (
    <div className="ui-stack" aria-label="Tasks">
      <Section title={`Open · ${open.length}`}>
        {open.length === 0 ? (
          <p className="buddy-panel__empty">No open tasks; the manager plans them.</p>
        ) : (
          open.map(card)
        )}
      </Section>
      {closed.length > 0 && (
        <Section title={`Verified or dropped · ${closed.length}`}>{closed.map(card)}</Section>
      )}
    </div>
  );
}

function Reflections({ v }: { v: ExpeditionView }) {
  return (
    <div className="ui-stack" aria-label="Reflections">
      {v.reflections.length === 0 ? (
        <p className="buddy-panel__empty">No reflections yet.</p>
      ) : (
        <ol className="expedition-timeline">
          {[...v.reflections].reverse().map((r, i) => (
            <li key={`${v.reflections.length - i}-${r.at}`}>
              <time dateTime={r.at} className="ui-muted">
                {new Date(r.at).toLocaleString()}
              </time>
              <ExpeditionMarkdown text={r.text} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** The Charter tab: identical for a draft and a live expedition. */
function CharterPane({
  charter,
  lessons,
  children,
}: { charter: ExpeditionCharterView; lessons: string[]; children?: ReactNode }) {
  const list = (items: string[]) =>
    items.length === 0 ? <p className="ui-muted">Not listed.</p> : <Bullets items={items} />;
  const { roster, limits } = charter;
  return (
    <div className="ui-stack" aria-label="Charter">
      <Section title="Done when">
        <ul className="expedition-checks">
          {charter.done.t === 'checks' ? (
            charter.done.checks.map((check, i) =>
              check.kind === 'command' ? (
                <li key={`${i}-command`}>
                  <code>$ {check.argv.join(' ')}</code>{' '}
                  <span className="ui-muted">run by the host · {check.timeoutSeconds}s limit</span>
                </li>
              ) : (
                <li key={`${i}-judged`}>
                  {check.text} <span className="ui-muted">· judged by a blind check panel</span>
                </li>
              )
            )
          ) : (
            <li>{doneLines(charter.done)[0]}</li>
          )}
        </ul>
      </Section>
      <div className="expedition-scope">
        <Section title="In scope">{list(charter.inScope)}</Section>
        <Section title="Out of scope">{list(charter.outOfScope)}</Section>
      </div>
      <Section title="Crew">
        <div className="ui-row expedition-card-meta">
          <span className="ui-muted">manager</span> <code>{roster.manager}</code>
          <span className="ui-muted">work</span>
          {roster.work.map((s, i) => (
            <code key={`w${i}-${s}`}>{s}</code>
          ))}
          <span className="ui-muted">check</span>
          {roster.check.map((s, i) => (
            <code key={`c${i}-${s}`}>{s}</code>
          ))}
        </div>
      </Section>
      <Section title="Limits">
        <p className="ui-muted">
          {budgetLine(limits)} · explore share {Math.round(limits.exploreShare * 100)}%
        </p>
      </Section>
      {lessons.length > 0 && (
        <Section title="Your lessons (in every brief)">{list(lessons)}</Section>
      )}
      {children}
    </div>
  );
}

function ChatPane({ v }: { v: ExpeditionView }) {
  switch (v.crew.t) {
    case 'ready':
      return <ExpeditionChat channelId={v.crew.chatChannelId} workspaceId={v.workspaceId} />;
    case 'pending':
      return <p className="buddy-panel__empty">Starting the crew… its chat opens here.</p>;
  }
}

/** The owner↔crew DM: every update lands here; a post wakes the crew to answer or steer. */
function ExpeditionChat({ channelId, workspaceId }: { channelId: string; workspaceId: string }) {
  const navigate = useNavigate();
  const directory = useWorkspaceDirectory(workspaceId);
  const feed = useChannelFeed(channelFeed(channelId));
  const posts = useWithOutbox(channelId, null, feed.posts);
  const availableConversationIds = useAtomValue(listField('idSet'));
  const listRef = useRef<HTMLOListElement>(null);
  const count = posts?.length ?? 0;
  // Newest at the bottom, in view: on open and whenever a post arrives.
  useEffect(() => {
    if (count > 0 && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [count]);
  const context: RowContext = {
    workspaceId,
    directory,
    availableConversationIds,
    linkedPostId: null,
    openDm: (conversationId) => navigate(channelsHref(workspaceId, { kind: 'dm', conversationId })),
    place: { kind: 'thread' },
  };
  return (
    <section className="expedition-chat ui-stack" aria-label="Expedition chat">
      <h3 className="ui-section__title">Chat</h3>
      {posts === null ? (
        <p className="buddy-panel__empty">Loading chat…</p>
      ) : (
        <ol ref={listRef} className="channel-browser-messages expedition-chat-messages">
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

// ---------- Draft ----------

function DraftModal({
  draftId,
  workspaceId,
  presentation,
  onClose,
}: { draftId: string; workspaceId: string; presentation: Presentation; onClose(): void }) {
  const view = usePolledFetch<ExpeditionDraftView>(draftUrl(draftId, workspaceId), 0);
  if (!view.data)
    return (
      <Pending
        label="draft"
        presentation={presentation}
        onClose={onClose}
        error={view.kind === 'failed' ? view.error : null}
      />
    );
  const d = view.data;
  return (
    <Shell
      label={`Draft expedition ${d.charter.name}`}
      presentation={presentation}
      onClose={onClose}
      title={
        <>
          <strong className="expedition-modal-title">⛺ Draft · {d.charter.name}</strong>
          <span className={`expedition-pill expedition-tone-${DRAFT_PILL[d.state.t].tone}`}>
            {DRAFT_PILL[d.state.t].label}
          </span>
          <span className="ui-muted">{budgetLine(d.charter.limits)}</span>
        </>
      }
    >
      <WithDirectory workspaceId={d.workspaceId}>
        <div className="expedition-pane ui-stack">
          <Goal goal={d.charter.goal} />
          {d.issues.length > 0 && (
            <section className="expedition-callout expedition-tone-bad ui-stack">
              <strong>Launch is blocked until these are fixed</strong>
              <Bullets items={d.issues} />
            </section>
          )}
          {d.advice.length > 0 && (
            <Section title="Advice">
              <Bullets items={d.advice} />
            </Section>
          )}
          {d.defaulted.length + d.resolved.length > 0 && (
            <Section title="Filled in for you">
              <Bullets items={[...d.defaulted, ...d.resolved]} />
            </Section>
          )}
          <CharterPane charter={d.charter} lessons={[]} />
        </div>
      </WithDirectory>
      <DraftFooter d={d} refetch={view.refetch} onClose={onClose} />
    </Shell>
  );
}

const DRAFT_PILL: Record<ExpeditionDraftState['t'], { label: string; tone: string }> = {
  open: { label: 'draft', tone: 'info' },
  launched: { label: 'launched', tone: 'ok' },
  superseded: { label: 'replaced', tone: 'muted' },
};

function DraftFooter({
  d,
  refetch,
  onClose,
}: { d: ExpeditionDraftView; refetch(): Promise<void>; onClose(): void }) {
  return (
    <footer className="expedition-footer ui-row">
      <DraftLaunchButton d={d} refetch={refetch} onOpen={onClose} />
      <button type="button" className="expedition-button" onClick={onClose}>
        Close
      </button>
    </footer>
  );
}
