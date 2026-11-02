import type {
  ExpeditionAttempt,
  ExpeditionCharterView,
  ExpeditionDefault,
  ExpeditionDraftView,
  ExpeditionQuestion,
  ExpeditionRetiredView,
  ExpeditionValidation,
  ExpeditionView,
} from '@unleashd/shared';
import { useAtomValue } from 'jotai';
import {
  type ReactNode,
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { listField } from '../../atoms/conversations';
import { invalidateBuddyResources, invalidateChannelResources } from '../../atoms/resources';
import { COPY_LABEL, useCopyAction } from '../../hooks/useCopyAction';
import { type PolledState, usePolledFetch } from '../../hooks/usePolledFetch';
import { MOBILE_QUERY } from '../../mobile/hooks/useDeviceKind';
import { ChannelComposer } from './ChannelComposer';
import { ChannelFeed, useChannelTimeline } from './ChannelFeed';
import { ChannelMarkdown } from './ChannelMarkdown';
import type { RowContext } from './ChannelRows';
import { ActionButton, DraftLaunchButton } from './ExpeditionCards';
import { ModalDialog } from './ModalDialog';
import { buddyWrite } from './api';
import { type WorkspaceDirectory, useWorkspaceDirectory, useWorkspaceInbox } from './channel-data';
import { channelsHref } from './channels-view';
import {
  DRAFT_PILL,
  FOCI,
  type Focus,
  PHASE_LOOK,
  type Pill,
  QUESTION_GLYPH,
  SCOPE_LABEL,
  STAGE_TONE,
  attemptCostLine,
  draftUrl,
  expeditionPill,
  expeditionRead,
  expeditionUrl,
  limitItems,
  ownerActions,
  pollMsOf,
  shortTime,
  summaryOf,
  timeLine,
  validationsOf,
} from './expedition-view';
import '../FilePreview.css';
import './Expedition.css';

// Pattern: one-definition (docs/patterns.md#one-definition): the ONE modal, live or draft.

export type ExpeditionTarget =
  | { t: 'live'; id: string }
  | { t: 'draft'; draftId: string; workspaceId: string };

export function ExpeditionModal(p: { target: ExpeditionTarget; onClose(): void }) {
  const frame: Frame = { presentation: usePresentation(), onClose: p.onClose };
  switch (p.target.t) {
    case 'live':
      return <LiveModal id={p.target.id} frame={frame} />;
    case 'draft':
      return (
        <DraftModal draftId={p.target.draftId} workspaceId={p.target.workspaceId} frame={frame} />
      );
  }
}

// Follows the viewport while open (2026-11-01: a widened window kept the phone sheet).
type Presentation = 'dialog' | 'sheet';
type Frame = { presentation: Presentation; onClose(): void };
const subscribeViewport = (onChange: () => void) => {
  const query = window.matchMedia(MOBILE_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};
const usePresentation = (): Presentation =>
  useSyncExternalStore(
    subscribeViewport,
    () => (window.matchMedia(MOBILE_QUERY).matches ? 'sheet' : 'dialog'),
    () => 'dialog'
  );
const FRAME_CLASS: Record<Presentation, string> = { dialog: '', sheet: 'ui-sheet ui-sheet--full' };

type Kind = 'live' | 'draft' | 'notice';

type ShellProps = {
  label: string;
  kind: Kind;
  frame: Frame;
  title: ReactNode;
  children: ReactNode;
};
function Shell(p: ShellProps) {
  const { presentation, onClose } = p.frame;
  return (
    <ModalDialog
      className={`${FRAME_CLASS[presentation]} channel-task-overlay ui-card ui-stack expedition-modal expedition-modal--${presentation} expedition-modal--${p.kind}`}
      label={p.label}
      onClose={onClose}
    >
      <header className="channel-task-overlay-header ui-row expedition-modal-header">
        {p.title}
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
      {p.children}
    </ModalDialog>
  );
}

const titleOf = (name: string, pill: Pill) => (
  <>
    <strong className="expedition-modal-title ui-truncate">⛺ {name}</strong>
    <span className={`expedition-pill expedition-tone-${pill.tone}`}>{pill.label}</span>
  </>
);

/** A failed read is a compact notice (2026-11-02: it filled the 86vh dialog with "HTTP 404"). */
function Pending(p: { label: string; kind: Kind; frame: Frame; view: PolledState<unknown> }) {
  return p.view.kind === 'failed' ? (
    <Shell
      label={p.label}
      kind="notice"
      frame={p.frame}
      title={<strong>{`⛺ This ${p.label} could not be opened`}</strong>}
    >
      <p className="ui-muted">
        {`It may have been deleted, or the link is wrong (${p.view.error.message}).`}
      </p>
    </Shell>
  ) : (
    <Shell label={p.label} kind={p.kind} frame={p.frame} title={<strong>⛺</strong>}>
      <output className="buddy-panel__empty">{`Loading ${p.label}…`}</output>
    </Shell>
  );
}

function DraftModal(p: { draftId: string; workspaceId: string; frame: Frame }) {
  const view = usePolledFetch<ExpeditionDraftView>(draftUrl(p.draftId, p.workspaceId), 0);
  if (!view.data) return <Pending label="draft" kind="draft" frame={p.frame} view={view} />;
  const d = view.data;
  return (
    <Shell
      label={`Draft expedition ${d.charter.name}`}
      kind="draft"
      frame={p.frame}
      title={titleOf(d.charter.name, DRAFT_PILL[d.state.t])}
    >
      <WithDirectory workspaceId={d.workspaceId}>
        <Goal goal={d.charter.goal} />
        <div className="expedition-columns">
          <div className="expedition-pane expedition-stack">
            <CharterPane charter={d.charter} lessons={[]} defaults={new Set(d.defaulted)} />
          </div>
          <aside className="expedition-pane expedition-stack" aria-label="Before launch">
            {d.issues.length > 0 && (
              <section className="expedition-callout expedition-tone-bad ui-stack">
                <strong>Launch is blocked until these are fixed</strong>
                <Bullets items={d.issues} />
              </section>
            )}
            <Section title="Advice">
              {d.advice.length > 0 ? (
                <Bullets items={d.advice} />
              ) : (
                <p className="ui-muted">Nothing to add: the charter is checkable as written.</p>
              )}
            </Section>
            {d.defaulted.length > 0 && (
              <p className="ui-muted">
                <DefaultMark on /> marks a value the request left out; the default applies.
              </p>
            )}
            {d.resolved.length > 0 && (
              <Section title="Model names resolved">
                <Bullets items={d.resolved} />
              </Section>
            )}
          </aside>
        </div>
      </WithDirectory>
      <footer className="expedition-footer ui-row">
        <DraftLaunchButton d={d} refetch={view.refetch} onOpen={p.frame.onClose} />
        <button type="button" className="expedition-button" onClick={p.frame.onClose}>
          Close
        </button>
      </footer>
    </Shell>
  );
}

const POLL_MS = 5_000;

function LiveModal({ id, frame }: { id: string; frame: Frame }) {
  const [pollMs, setPollMs] = useState(POLL_MS);
  const view = usePolledFetch<ExpeditionView | ExpeditionRetiredView>(expeditionUrl(id), pollMs);
  const read = view.data ? expeditionRead(view.data) : null;
  const nextPollMs = read ? pollMsOf(summaryOf(read), POLL_MS) : POLL_MS;
  if (nextPollMs !== pollMs) setPollMs(nextPollMs);
  if (!read) return <Pending label="expedition" kind="live" frame={frame} view={view} />;
  const summary = summaryOf(read);
  const refetch = async () => {
    invalidateBuddyResources(); // the rail, index and Home rows move with the footer action
    await view.refetch();
  };
  return (
    <Shell
      label={`Expedition ${summary.name}`}
      kind="live"
      frame={frame}
      title={titleOf(summary.name, expeditionPill(summary))}
    >
      <WithDirectory workspaceId={summary.workspaceId}>
        {read.t === 'live' ? (
          <LiveBody
            v={read.view}
            presentation={frame.presentation}
            stale={view.kind === 'stale' ? view.error : null}
          />
        ) : (
          <RetiredBody r={read.view} />
        )}
      </WithDirectory>
      {read.t === 'live' && <OwnerFooter v={read.view} refetch={refetch} />}
    </Shell>
  );
}

/** `share` adds a bar (2026-11-01 review: the native <meter> read as full at 0/4). */
const Stat = (p: { label: string; value: string; title?: string; share?: number }) => (
  <span className="expedition-stat" title={p.title}>
    <span className="expedition-stat-label">{p.label}</span>
    <span className="expedition-stat-value">{p.value}</span>
    {p.share !== undefined && (
      <span className="expedition-bar" aria-hidden="true">
        <span style={{ width: `${p.share * 100}%` }} />
      </span>
    )}
  </span>
);

const meter = (label: string, value: number, max: number) => (
  <Stat
    label={label}
    value={`${value}/${max}`}
    title={`${label}: ${value} of ${max}`}
    share={max > 0 ? Math.min(1, value / max) : 0}
  />
);

function BranchChip({ branch, head }: { branch: string; head: string }) {
  const { state, copy } = useCopyAction(branch);
  return (
    <button
      type="button"
      className="expedition-chip expedition-chip--mono"
      onClick={copy}
      title={`${COPY_LABEL[state]} ${branch}`}
    >
      <span className="ui-truncate">{branch}</span>
      <span className="expedition-chip-tail">
        @ {head.slice(0, 7)} · {COPY_LABEL[state]}
      </span>
    </button>
  );
}

const RetiredBody = ({ r: { summary: s, report } }: { r: ExpeditionRetiredView }) => (
  <div className="expedition-pane ui-stack">
    <div className="expedition-meters">
      <Stat label="Attempts" value={`${s.counts.attempts}/${s.counts.maxAttempts}`} />
      <Stat label="Verified" value={String(s.counts.verified)} />
      <Stat label="Cost" value={s.cost.short} />
    </div>
    <Section title="Last status report">
      <ExpeditionMarkdown text={report} />
    </Section>
  </div>
);

function OwnerFooter({ v, refetch }: { v: ExpeditionView; refetch(): Promise<void> }) {
  const action = ownerActions(v);
  switch (action.t) {
    case 'none':
      return null;
    case 'retire':
    case 'stop_and_retire':
      return <RetireControl id={v.id} mode={action.t} refetch={refetch} />;
  }
}

const RETIRE_COPY = {
  retire: {
    ask: 'Retire',
    confirm: 'Archive its branches to tags, remove its worktrees and archive the crew and chats?',
  },
  stop_and_retire: {
    ask: 'Stop and retire',
    confirm: 'Stop it now, then archive its branches to tags, remove its worktrees and the crew?',
  },
} as const;

type RetireProps = { id: string; mode: keyof typeof RETIRE_COPY; refetch(): Promise<void> };
function RetireControl(p: RetireProps) {
  const [asked, setAsked] = useState(false);
  const copy = RETIRE_COPY[p.mode];
  return (
    <footer className="expedition-footer ui-row">
      {asked ? (
        <span className="ui-row expedition-launch">
          <span className="ui-muted">{copy.confirm}</span>
          <ActionButton
            act={() => buddyWrite('expedition.retire', { id: p.id }, { mode: p.mode })}
            refetch={p.refetch}
            label={`Yes, ${copy.ask.toLowerCase()}`}
            busy="Retiring…"
            primary
          />
          <button type="button" className="expedition-button" onClick={() => setAsked(false)}>
            Cancel
          </button>
        </span>
      ) : (
        <button type="button" className="expedition-button" onClick={() => setAsked(true)}>
          {copy.ask}
        </button>
      )}
    </footer>
  );
}

/** A focus the layout lacks ('chat' from an outgrown sheet) shows the workers. */
const LAYOUT: Record<
  Presentation,
  { foci: typeof FOCI; arrange(main: ReactNode, chat: ReactNode): ReactNode }
> = {
  dialog: {
    foci: FOCI.filter((f) => f.focus !== 'chat'),
    arrange: (main, chat) => (
      <div className="expedition-columns">
        {main}
        {chat}
      </div>
    ),
  },
  sheet: { foci: FOCI, arrange: (main) => main },
};

const NO_DEFAULTS: ReadonlySet<ExpeditionDefault> = new Set();

const PANE: Record<Focus, (v: ExpeditionView, chat: ReactNode) => ReactNode> = {
  workers: (v) => <Workers v={v} />,
  tasks: (v) => <Tasks v={v} />,
  reflections: (v) => <Reflections v={v} />,
  charter: (v) => (
    <CharterPane charter={v.charter} lessons={v.lessons} defaults={NO_DEFAULTS}>
      {v.validations.length > 0 && (
        <Section title="Validations">
          <Bullets items={[...v.validations].reverse().map((x) => x.label)} />
        </Section>
      )}
    </CharterPane>
  ),
  chat: (_v, chat) => chat,
};

function LiveBody(p: { v: ExpeditionView; presentation: Presentation; stale: Error | null }) {
  const { v } = p;
  const [focus, setFocus] = useState<Focus>('workers');
  const chatRef = useRef<HTMLDivElement>(null);
  const { foci, arrange } = LAYOUT[p.presentation];
  const pane = foci.some((f) => f.focus === focus) ? focus : 'workers';
  const reply = () => {
    setFocus('chat');
    requestAnimationFrame(() => chatRef.current?.querySelector('textarea')?.focus());
  };
  // WAI-ARIA tabs: arrow keys move between tabs.
  const step = (by: number) => {
    const next = foci[(foci.findIndex((f) => f.focus === pane) + by + foci.length) % foci.length];
    setFocus(next.focus);
    document.getElementById(`expedition-tab-${next.focus}`)?.focus();
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
          aria-controls="expedition-panel"
          tabIndex={pane === f.focus ? 0 : -1}
          className="expedition-tab"
          onClick={() => setFocus(f.focus)}
        >
          {f.label}
          {f.count && <span className="expedition-tab-count">{f.count(v)}</span>}
        </button>
      ))}
    </div>
  );
  const chat = (
    <div ref={chatRef} className="expedition-chat-column">
      <ChatPane v={v} />
    </div>
  );
  const { counts: c } = v;
  return (
    <>
      <div className="expedition-meters">
        {meter('Attempts', c.attempts, c.maxAttempts)}
        {meter('Decisions', c.decisions, c.maxDecisions)}
        <Stat
          label="Now"
          value={`${c.running} running · ${c.queued} queued · ${c.verified} verified`}
        />
        <Stat
          label="Time"
          value={timeLine(v)}
          title={`Deadline ${new Date(v.deadline).toLocaleString()}`}
        />
        <Stat label="Cost" value={v.cost.short} title={v.cost.line} />
      </div>
      <div className="ui-row">
        <BranchChip branch={v.integration.branch} head={v.integration.head} />
      </div>
      {p.stale && <p role="alert">{p.stale.message}</p>}
      <RunHead v={v} onReply={reply} />
      {arrange(
        <div className="expedition-main ui-stack">
          {tabs}
          <div
            id="expedition-panel"
            role="tabpanel"
            aria-labelledby={`expedition-tab-${pane}`}
            className="expedition-pane"
          >
            {PANE[pane](v, chat)}
          </div>
        </div>,
        chat
      )}
    </>
  );
}

/** The status is the header pill only (2026-11-01: shown 3x); the goal folds under a result. */
function RunHead({ v, onReply }: { v: ExpeditionView; onReply(): void }) {
  const goal = <Goal goal={v.charter.goal} />;
  switch (v.run.t) {
    case 'running':
    case 'paused':
      return goal;
    case 'waiting_owner':
      return (
        <>
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
          {goal}
        </>
      );
    case 'finished':
      return (
        <>
          <section className="expedition-callout ui-stack" aria-label="Result">
            <strong>Result</strong>
            <ExpeditionMarkdown text={v.run.summary} />
          </section>
          <details className="expedition-goal-folded">
            <summary className="expedition-link">Goal</summary>
            {goal}
          </details>
        </>
      );
  }
}

function PhaseOutcome({ phase }: { phase: ExpeditionAttempt['phase'] }) {
  switch (phase.t) {
    case 'planned':
    case 'admitted':
    case 'posting':
    case 'posted':
      return null;
    case 'dropped':
      return <Outcome verdict="Not started" text={phase.reason} />;
    case 'ended':
      return <Outcome verdict={phase.verdict} text={phase.summary} />;
  }
}

const Outcome = ({ verdict, text }: { verdict: string; text: string }) => (
  <p className="expedition-outcome">
    <span className="expedition-outcome-verdict">{verdict}</span> {text}
  </p>
);

function WorkerCard(p: { a: ExpeditionAttempt; validations: ExpeditionValidation[] }) {
  const cost = attemptCostLine(p.a.cost);
  const look = PHASE_LOOK[p.a.phase.t];
  return (
    <article className="expedition-card ui-stack">
      <div className="ui-row expedition-card-head">
        <span className={`expedition-dot expedition-tone-${look.tone}`} aria-hidden="true" />
        <strong
          className="ui-truncate expedition-card-title"
          title={`${p.a.label} (attempt ${p.a.id})`}
        >
          {p.a.label}
        </strong>
        <span className="expedition-chip expedition-chip--small">{p.a.kind}</span>
      </div>
      <PhaseOutcome phase={p.a.phase} />
      {p.validations.map((x) => (
        <div key={x.id} className="expedition-validation">
          <span className="expedition-chip expedition-chip--small">checks {x.verdict}</span>
          {x.checks.map((c) => (
            <div key={c.checkIndex}>
              {c.passed ? '✓' : '✗'} check {c.checkIndex + 1}: {c.outcome}
            </div>
          ))}
        </div>
      ))}
      <div className="expedition-card-meta ui-muted">
        <span>{p.a.seat}</span>
        <span>{look.state}</span>
        {p.a.worktree.t === 'tree' && <code>branch {p.a.worktree.branch}</code>}
        {cost && <span title={cost.title}>{cost.text}</span>}
      </div>
      {/* Collapsed (2026-11-01 review: the open crew prompt read as debug output). */}
      <div className="ui-row expedition-disclosures">
        {p.a.kind === 'work' && <Disclosure label="Brief" text={p.a.ask} />}
        {p.a.briefing.t !== 'unbriefed' && (
          <Disclosure label="Full instructions" text={p.a.briefing.brief} />
        )}
      </div>
    </article>
  );
}

const Disclosure = ({ label, text }: { label: string; text: string }) => (
  <details>
    <summary className="expedition-link">{label}</summary>
    <ExpeditionMarkdown text={text} />
  </details>
);

function Groups<T>(p: {
  label: string;
  open: [string, T[]];
  closed: [string, T[]];
  empty: string;
  card(item: T): ReactNode;
  children?: ReactNode;
}) {
  const [[openTitle, open], [closedTitle, closed]] = [p.open, p.closed];
  return (
    <div className="expedition-stack" aria-label={p.label}>
      {p.children}
      <Section title={`${openTitle} · ${open.length}`}>
        {open.length === 0 ? <p className="buddy-panel__empty">{p.empty}</p> : open.map(p.card)}
      </Section>
      {closed.length > 0 && (
        <Section title={`${closedTitle} · ${closed.length}`}>{closed.map(p.card)}</Section>
      )}
    </div>
  );
}

const Workers = ({ v: { attempts, validations, integration: x } }: { v: ExpeditionView }) => (
  <Groups
    label="Workers"
    open={['Running and queued', attempts.filter((a) => a.phase.t !== 'ended')]}
    closed={['Finished', attempts.filter((a) => a.phase.t === 'ended').reverse()]}
    empty="Nothing running right now."
    card={(a) => <WorkerCard key={a.id} a={a} validations={validationsOf(validations, a.id)} />}
  >
    {x.lastRefusal.t === 'refused' && (
      <p className="expedition-callout ui-muted">
        {x.integrated} integrated · last refusal: {x.lastRefusal.label}
      </p>
    )}
  </Groups>
);

const TaskCard = ({ q }: { q: ExpeditionQuestion }) => (
  <article className="expedition-card ui-stack">
    <div className="ui-row expedition-card-head">
      <span aria-hidden="true">{QUESTION_GLYPH[q.status]}</span>
      <strong className="expedition-card-title">{q.title}</strong>
      <span
        className={`expedition-chip expedition-chip--small expedition-tone-${STAGE_TONE[q.stage]}`}
      >
        {q.stage}
      </span>
      <span className="expedition-chip expedition-chip--small">{SCOPE_LABEL[q.scope]}</span>
    </div>
    {(q.paths.length > 0 || q.after.length > 0) && (
      <div className="expedition-card-meta ui-muted">
        {q.paths.map((path) => (
          <code key={path} className="expedition-path">
            {path}
          </code>
        ))}
        {q.after.length > 0 && (
          <span>after {q.after.map((dep) => `“${dep.title}”`).join(', ')} is verified</span>
        )}
        {q.attempts.length > 0 && (
          <span>{`${q.attempts.length} ${q.attempts.length === 1 ? 'attempt' : 'attempts'}`}</span>
        )}
      </div>
    )}
    <Disclosure label="Detail" text={q.detail} />
  </article>
);

const Tasks = ({ v }: { v: ExpeditionView }) => (
  <Groups
    label="Tasks"
    open={['Open', v.questions.filter((q) => q.status === 'open')]}
    closed={['Verified or dropped', v.questions.filter((q) => q.status !== 'open')]}
    empty="No open tasks; the manager plans them."
    card={(q) => <TaskCard key={q.id} q={q} />}
  />
);

const Reflections = ({ v }: { v: ExpeditionView }) => (
  <div className="expedition-stack" aria-label="Reflections">
    {v.reflections.length === 0 ? (
      <p className="buddy-panel__empty">No reflections yet.</p>
    ) : (
      <ol className="expedition-timeline">
        {[...v.reflections].reverse().map((r, i) => (
          <li key={`${v.reflections.length - i}-${r.at}`} className="ui-stack">
            <time
              dateTime={r.at}
              className="expedition-time"
              title={new Date(r.at).toLocaleString()}
            >
              {shortTime(r.at, v.now)}
            </time>
            <ExpeditionMarkdown text={r.text} />
          </li>
        ))}
      </ol>
    )}
  </div>
);

// Charter and markdown, shared by the live and draft bodies.

/** The directory modal markdown resolves Buddy mentions and Task refs against (one per body). */
const DirectoryContext = createContext<WorkspaceDirectory | null>(null);

function WithDirectory(p: { workspaceId: string; children: ReactNode }) {
  const directory = useWorkspaceDirectory(p.workspaceId);
  return <DirectoryContext.Provider value={directory}>{p.children}</DirectoryContext.Provider>;
}

/** Markdown exactly as the chat renders it, on the file preview's surface (FilePreview.css). */
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

/** The goal, clamped to ~3 lines until "Show more". */
function Goal({ goal }: { goal: string }) {
  const [open, setOpen] = useState(false);
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

const Bullets = ({ items }: { items: readonly string[] }) => (
  <ul className="expedition-bullets">
    {items.map((item, i) => (
      <li key={i}>{item}</li>
    ))}
  </ul>
);

const DefaultMark = ({ on }: { on: boolean }) =>
  on && (
    <span className="expedition-default" title="Not stated in the request; the default applies">
      default
    </span>
  );

const Section = ({ title, children }: { title: ReactNode; children: ReactNode }) => (
  <section className="expedition-section ui-stack">
    <h3 className="ui-section__title">{title}</h3>
    {children}
  </section>
);

const ScopeList = ({ items, defaulted }: { items: string[]; defaulted: boolean }) =>
  items.length === 0 ? (
    <p className="ui-muted">
      None stated <DefaultMark on={defaulted} />
    </p>
  ) : (
    <div className="expedition-card-meta">
      {items.map((item, i) => (
        <code key={`${i}-${item}`} className="expedition-path">
          {item}
        </code>
      ))}
      <DefaultMark on={defaulted} />
    </div>
  );

/** The Charter tab: identical for a draft and a live expedition; a draft marks its defaults. */
type Defaults = { defaults: ReadonlySet<ExpeditionDefault> };
type CharterProps = { charter: ExpeditionCharterView; lessons: string[]; children?: ReactNode };
function CharterPane({ charter, lessons, defaults, children }: CharterProps & Defaults) {
  const { roster, limits } = charter;
  return (
    <div className="expedition-stack" aria-label="Charter">
      <Section title="Done when">
        <ul className="expedition-checks">
          {charter.done.t === 'checks' ? (
            charter.done.checks.map((check, i) => (
              <li key={`${i}-${check.kind}`}>{checkLine(check)}</li>
            ))
          ) : (
            <li>The owner judges completion.</li>
          )}
        </ul>
      </Section>
      <div className="expedition-scope">
        <Section title="In scope">
          <ScopeList items={charter.inScope} defaulted={defaults.has('inScope')} />
        </Section>
        <Section title="Out of scope">
          <ScopeList items={charter.outOfScope} defaulted={defaults.has('outOfScope')} />
        </Section>
      </div>
      <Section title={['Crew ', <DefaultMark key="d" on={defaults.has('crew')} />]}>
        {/* One labelled row per role (2026-11-01: labels and values ran together). */}
        <dl className="expedition-crew">
          <dt>Manager</dt>
          <dd>{chips([roster.manager])}</dd>
          <dt>Work seats</dt>
          <dd>{chips(roster.work)}</dd>
          <dt>Checks</dt>
          <dd>
            {chips(roster.check)}
            <span className="ui-muted">never the claim author's model</span>
          </dd>
        </dl>
      </Section>
      <Section title="Limits">
        <div className="expedition-card-meta">
          {limitItems(limits, defaults).map((item) => (
            <span key={item.text} className="expedition-chip">
              {item.text}
              <DefaultMark on={item.defaulted} />
            </span>
          ))}
        </div>
      </Section>
      {lessons.length > 0 && (
        <Section title="Your lessons (in every brief)">
          <Bullets items={lessons} />
        </Section>
      )}
      {children}
    </div>
  );
}

type Check = Extract<ExpeditionCharterView['done'], { t: 'checks' }>['checks'][number];
const checkLine = (check: Check) =>
  check.kind === 'command' ? (
    <>
      <code>$ {check.argv.join(' ')}</code>{' '}
      <span className="ui-muted">run by the host · {check.timeoutSeconds}s limit</span>
    </>
  ) : (
    <>
      {check.text} <span className="ui-muted">· judged by a blind check panel</span>
    </>
  );

const chips = (seats: readonly string[]) =>
  seats.map((seat, i) => (
    <span key={`${i}-${seat}`} className="expedition-chip">
      {seat}
    </span>
  ));

function ChatPane({ v }: { v: ExpeditionView }) {
  switch (v.crew.t) {
    case 'ready':
      return (
        <ExpeditionChat
          channelId={v.crew.chatChannelId}
          workspaceId={v.workspaceId}
          // A retiring expedition's crew is being archived: its chat is history.
          writable={v.retirement.t === 'active'}
        />
      );
    case 'pending':
      return <p className="buddy-panel__empty">Starting the crew… its chat opens here.</p>;
  }
}

function ExpeditionChat(p: { channelId: string; workspaceId: string; writable: boolean }) {
  const navigate = useNavigate();
  const directory = useWorkspaceDirectory(p.workspaceId);
  const inbox = useWorkspaceInbox(p.workspaceId);
  const unread = inbox.data?.channels.find((e) => e.channel.id === p.channelId)?.unread ?? 0;
  const timeline = useChannelTimeline(p.channelId, unread);
  const availableConversationIds = useAtomValue(listField('idSet'));
  const context: RowContext = {
    workspaceId: p.workspaceId,
    directory,
    availableConversationIds,
    linkedPostId: null,
    openDm: (id) => navigate(channelsHref(p.workspaceId, { kind: 'dm', conversationId: id })),
    place: { kind: 'thread' },
  };
  return (
    <section className="expedition-chat ui-stack" aria-label="Expedition chat">
      <div className="expedition-chat-head ui-row">
        <h3 className="ui-section__title">Chat</h3>
        <Link
          className="expedition-chat-open ui-muted"
          to={channelsHref(p.workspaceId, { kind: 'channel', channelId: p.channelId })}
        >
          Open as DM ↗
        </Link>
      </div>
      <ChannelFeed
        timeline={timeline}
        context={context}
        firstUnread={null}
        label="chat"
        density="column"
      />
      {p.writable && (
        <ChannelComposer
          channelId={p.channelId}
          rootId={null}
          placeholder="Ask the expedition, or give it a lesson…"
          references={directory.references}
          submit="enter"
          onPosted={() => {
            timeline.follow.pin();
            invalidateChannelResources(p.channelId, []);
          }}
        />
      )}
    </section>
  );
}
