import type {
  ExpeditionAttempt,
  ExpeditionCharterView,
  ExpeditionDefault,
  ExpeditionDraftView,
  ExpeditionQuestion,
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
  useSyncExternalStore,
} from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { listField } from '../../atoms/conversations';
import { invalidateChannelResources } from '../../atoms/resources';
import { COPY_LABEL, useCopyAction } from '../../hooks/useCopyAction';
import { type PolledState, usePolledFetch } from '../../hooks/usePolledFetch';
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
  DRAFT_PILL,
  FOCI,
  type Focus,
  type Pane,
  QUESTION_GLYPH,
  SCOPE_LABEL,
  STAGE_TONE,
  attemptCostLine,
  attemptOutcome,
  attemptState,
  attemptTone,
  draftUrl,
  expeditionPollMs,
  expeditionUrl,
  limitItems,
  nowLine,
  runLabel,
  runTone,
  shortTime,
  timeLine,
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

// The sheet/dialog choice follows the viewport while the modal is open (2026-11-01 review: a
// window resized from phone to desktop width kept a full-bleed sheet). The shell's own choice is
// sticky per load (useDeviceKind); the modal is short-lived, so re-laying it out loses nothing.
// Same breakpoint as useDeviceKind.
const SHEET_QUERY = '(max-width: 768px)';
const subscribeViewport = (onChange: () => void) => {
  const query = window.matchMedia(SHEET_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};
const viewportPresentation = (): Presentation =>
  window.matchMedia(SHEET_QUERY).matches ? 'sheet' : 'dialog';
/** A static render (tests) has no viewport: it renders the dialog. */
const staticPresentation = (): Presentation => 'dialog';

export function ExpeditionModal({
  target,
  onClose,
}: { target: ExpeditionTarget; onClose(): void }) {
  const presentation = useSyncExternalStore(
    subscribeViewport,
    viewportPresentation,
    staticPresentation
  );
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

/** Which modal: the live one is a fixed-height workspace; a draft and a notice (an expedition or
 * draft that could not be read) size to their content. */
type Kind = 'live' | 'draft' | 'notice';

function Shell({
  label,
  kind,
  presentation,
  onClose,
  title,
  children,
}: {
  label: string;
  kind: Kind;
  presentation: Presentation;
  onClose(): void;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <ModalDialog
      className={`channel-task-overlay ui-card ui-stack expedition-modal expedition-modal--${presentation} expedition-modal--${kind}`}
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

/** The first read of an expedition or draft: still loading (the shell with one line, so Esc still
 * closes), or it failed. */
type FirstRead = { t: 'loading' } | { t: 'failed'; error: Error };

const firstRead = (view: PolledState<unknown>): FirstRead =>
  view.kind === 'failed' ? { t: 'failed', error: view.error } : { t: 'loading' };

/** δ over the first read: a loading shell at the modal's own size, or a compact notice. A failed
 * read used to fill the 86vh live dialog with a lone tent and "HTTP 404" (2026-11-02 visual
 * pass of /expeditions/nope). */
function Pending({
  label,
  kind,
  presentation,
  onClose,
  read,
}: {
  label: string;
  kind: Kind;
  presentation: Presentation;
  onClose(): void;
  read: FirstRead;
}) {
  switch (read.t) {
    case 'loading':
      return (
        <Shell
          label={label}
          kind={kind}
          presentation={presentation}
          onClose={onClose}
          title={<strong>⛺</strong>}
        >
          <output className="buddy-panel__empty">{`Loading ${label}…`}</output>
        </Shell>
      );
    case 'failed':
      return (
        <Shell
          label={label}
          kind="notice"
          presentation={presentation}
          onClose={onClose}
          title={<strong>{`⛺ This ${label} could not be opened`}</strong>}
        >
          <p className="ui-muted">
            {`It may have been deleted, or the link is wrong (${read.error.message}).`}
          </p>
        </Shell>
      );
  }
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
    <ul className="expedition-bullets">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

/** A labelled count with its own bar: a track and a distinct fill (2026-11-01 review: the native
 * <meter> read as full at 0/4). */
function Meter({ label, value, max }: { label: string; value: number; max: number }) {
  const share = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <span className="expedition-stat" title={`${label}: ${value} of ${max}`}>
      <span className="expedition-stat-label">{label}</span>
      <span className="expedition-stat-value">
        {value}/{max}
      </span>
      <span className="expedition-bar" aria-hidden="true">
        <span style={{ width: `${share * 100}%` }} />
      </span>
    </span>
  );
}

function Stat({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <span className="expedition-stat" title={title}>
      <span className="expedition-stat-label">{label}</span>
      <span className="expedition-stat-value">{value}</span>
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
      <span className="ui-truncate">{branch}</span>
      <span className="expedition-chip-tail">
        @ {head.slice(0, 7)} · {COPY_LABEL[state]}
      </span>
    </button>
  );
}

/** The small "default" marker on a value the host filled in for the draft. */
function DefaultMark({ on }: { on: boolean }) {
  return on ? (
    <span className="expedition-default" title="Not stated in the request; the default applies">
      default
    </span>
  ) : null;
}

function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="expedition-section ui-stack">
      <h3 className="ui-section__title">{title}</h3>
      {children}
    </section>
  );
}

// ---------- Live ----------

function LiveModal({
  id,
  presentation,
  onClose,
}: { id: string; presentation: Presentation; onClose(): void }) {
  const [pollMs, setPollMs] = useState(POLL_MS);
  const view = usePolledFetch<ExpeditionView>(expeditionUrl(id), pollMs);
  // A finished expedition stops polling (audit #8); derived from the last response.
  const nextPollMs = expeditionPollMs(view.data, POLL_MS);
  if (nextPollMs !== pollMs) setPollMs(nextPollMs);
  if (!view.data)
    return (
      <Pending
        label="expedition"
        kind="live"
        presentation={presentation}
        onClose={onClose}
        read={firstRead(view)}
      />
    );
  const v = view.data;
  return (
    <Shell
      label={`Expedition ${v.charter.name}`}
      kind="live"
      presentation={presentation}
      onClose={onClose}
      title={
        <>
          <strong className="expedition-modal-title ui-truncate">⛺ {v.charter.name}</strong>
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
  // Totals (2026-11-01 review: "Workers 0" beside four finished workers read as broken).
  const counts: Record<Focus, number | null> = {
    workers: v.attempts.length,
    tasks: v.questions.length,
    reflections: v.reflections.length,
    charter: null,
    chat: null,
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
          {counts[f.focus] !== null && (
            <span className="expedition-tab-count">{counts[f.focus]}</span>
          )}
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
      <div className="expedition-meters">
        <Meter label="Attempts" value={v.counts.attempts} max={v.counts.maxAttempts} />
        <Meter label="Decisions" value={v.counts.decisions} max={v.counts.maxDecisions} />
        <Stat label="Now" value={nowLine(v)} />
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
      {stale && <p role="alert">{stale.message}</p>}
      <RunCallout v={v} onReply={reply} />
      <GoalOf v={v} />
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

/** δ over the run: while it runs the goal stays in view; once finished it folds under the
 * result (2026-11-01 visual pass: result + goal took ~330px above the tabs at 1440x900). */
function GoalOf({ v }: { v: ExpeditionView }) {
  switch (v.run.t) {
    case 'running':
    case 'paused':
    case 'waiting_owner':
      return <Goal goal={v.charter.goal} />;
    case 'finished':
      return (
        <details className="expedition-goal-folded">
          <summary className="expedition-link">Goal</summary>
          <Goal goal={v.charter.goal} />
        </details>
      );
  }
}

const PANEL_ID = 'expedition-panel';
const panelProps = (pane: Focus) => ({
  id: PANEL_ID,
  role: 'tabpanel',
  'aria-labelledby': `expedition-tab-${pane}`,
  className: 'expedition-pane',
});

/** The owner's attention line: an open question, or the result; nothing while it runs. The
 * status itself is the header pill only (2026-11-01 review: it was repeated three times). */
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
          <strong>Result</strong>
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
        <CharterPane charter={v.charter} lessons={v.lessons} defaults={NO_DEFAULTS}>
          {v.validations.length > 0 && (
            <Section title="Validations">
              <Bullets items={[...v.validations].reverse().map((x) => x.label)} />
            </Section>
          )}
        </CharterPane>
      );
  }
}

/** A live expedition's charter is as launched: nothing is marked as a draft default. */
const NO_DEFAULTS: ReadonlySet<ExpeditionDefault> = new Set();

function WorkerCard({
  a,
  validations,
}: { a: ExpeditionAttempt; validations: ExpeditionValidation[] }) {
  const tree = worktreeLine(a.worktree);
  const cost = attemptCostLine(a.cost);
  const outcome = attemptOutcome(a);
  return (
    <article className="expedition-card ui-stack">
      <div className="ui-row expedition-card-head">
        <span className={`expedition-dot expedition-tone-${attemptTone(a)}`} aria-hidden="true" />
        <strong
          className="ui-truncate expedition-card-title"
          title={`${a.label} (attempt ${a.id})`}
        >
          {a.label}
        </strong>
        <span className="expedition-chip expedition-chip--small">{a.kind}</span>
      </div>
      {outcome.t === 'outcome' && (
        <p className="expedition-outcome">
          <span className="expedition-outcome-verdict">{outcome.verdict}</span> {outcome.summary}
        </p>
      )}
      {validations.map((x) => (
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
        <span>{a.seat}</span>
        <span>{attemptState(a)}</span>
        {tree && <code>{tree}</code>}
        {cost && <span title={cost.title}>{cost.text}</span>}
      </div>
      {/* Collapsed by default (2026-11-01 review: the open crew prompt read as debug output). */}
      <div className="ui-row expedition-disclosures">
        {a.ask !== null && (
          <details>
            <summary className="expedition-link">Brief</summary>
            <ExpeditionMarkdown text={a.ask} />
          </details>
        )}
        {a.brief !== null && (
          <details>
            <summary className="expedition-link">Full instructions</summary>
            <ExpeditionMarkdown text={a.brief} />
          </details>
        )}
      </div>
    </article>
  );
}

function Workers({ v }: { v: ExpeditionView }) {
  const active = v.attempts.filter((a) => a.phase.t !== 'ended');
  const ended = v.attempts.filter((a) => a.phase.t === 'ended').reverse();
  const card = (a: ExpeditionAttempt) => (
    <WorkerCard key={a.id} a={a} validations={validationsOf(v.validations, a.id)} />
  );
  return (
    <div className="expedition-stack" aria-label="Workers">
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
  const card = (q: ExpeditionQuestion) => (
    <article key={q.id} className="expedition-card ui-stack">
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
          {q.paths.map((p) => (
            <code key={p} className="expedition-path">
              {p}
            </code>
          ))}
          {q.after.length > 0 && (
            <span>after {q.after.map((dep) => `“${dep.title}”`).join(', ')} is verified</span>
          )}
          {q.attempts.length > 0 && (
            <span>
              {q.attempts.length} {q.attempts.length === 1 ? 'attempt' : 'attempts'}
            </span>
          )}
        </div>
      )}
      <details>
        <summary className="expedition-link">Detail</summary>
        <ExpeditionMarkdown text={q.detail} />
      </details>
    </article>
  );
  return (
    <div className="expedition-stack" aria-label="Tasks">
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
}

/** Repo paths (or plain scope words) as chips; the empty list says so, marked when defaulted. */
function ScopeList({ items, defaulted }: { items: string[]; defaulted: boolean }) {
  return items.length === 0 ? (
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
}

/** The Charter tab: identical for a draft and a live expedition; a draft marks its defaults. */
function CharterPane({
  charter,
  lessons,
  defaults,
  children,
}: {
  charter: ExpeditionCharterView;
  lessons: string[];
  defaults: ReadonlySet<ExpeditionDefault>;
  children?: ReactNode;
}) {
  const { roster, limits } = charter;
  return (
    <div className="expedition-stack" aria-label="Charter">
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
      <Section
        title={
          <>
            Crew <DefaultMark on={defaults.has('crew')} />
          </>
        }
      >
        {/* One labelled row per role (2026-11-01 visual pass: "manager claude work claude codex
            check codex claude" ran labels and values together). */}
        <dl className="expedition-crew">
          <dt>Manager</dt>
          <dd>
            <span className="expedition-chip">{roster.manager}</span>
          </dd>
          <dt>Work seats</dt>
          <dd>
            {roster.work.map((seat, i) => (
              <span key={`w${i}-${seat}`} className="expedition-chip">
                {seat}
              </span>
            ))}
          </dd>
          <dt>Checks</dt>
          <dd>
            {roster.check.map((seat, i) => (
              <span key={`c${i}-${seat}`} className="expedition-chip">
                {seat}
              </span>
            ))}
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
      {/* The same DM, full size in the channels view, the way Slack opens one. */}
      <div className="expedition-chat-head ui-row">
        <h3 className="ui-section__title">Chat</h3>
        <Link
          className="expedition-chat-open ui-muted"
          to={channelsHref(workspaceId, { kind: 'channel', channelId })}
        >
          Open as DM ↗
        </Link>
      </div>
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
        kind="draft"
        presentation={presentation}
        onClose={onClose}
        read={firstRead(view)}
      />
    );
  const d = view.data;
  const pill = DRAFT_PILL[d.state.t];
  return (
    <Shell
      label={`Draft expedition ${d.charter.name}`}
      kind="draft"
      presentation={presentation}
      onClose={onClose}
      title={
        <>
          <strong className="expedition-modal-title ui-truncate">⛺ {d.charter.name}</strong>
          <span className={`expedition-pill expedition-tone-${pill.tone}`}>{pill.label}</span>
        </>
      }
    >
      <WithDirectory workspaceId={d.workspaceId}>
        {/* The live dialog's layout (2026-11-01 visual pass): the charter on the left, what
            needs attention before launch in the right column where the live chat sits. */}
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
        <DraftLaunchButton d={d} refetch={view.refetch} onOpen={onClose} />
        <button type="button" className="expedition-button" onClick={onClose}>
          Close
        </button>
      </footer>
    </Shell>
  );
}
