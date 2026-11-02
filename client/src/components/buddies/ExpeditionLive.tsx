import type {
  ExpeditionAttempt,
  ExpeditionDefault,
  ExpeditionQuestion,
  ExpeditionRetiredView,
  ExpeditionValidation,
  ExpeditionView,
} from '@unleashd/shared';
import { type ReactNode, useRef, useState } from 'react';
import { invalidateBuddyResources } from '../../atoms/resources';
import { COPY_LABEL, useCopyAction } from '../../hooks/useCopyAction';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import {
  Bullets,
  CharterPane,
  ExpeditionMarkdown,
  Goal,
  Section,
  WithDirectory,
} from './ExpeditionCharter';
import { ChatPane } from './ExpeditionChat';
import { Pending, type Presentation, Shell, firstRead } from './ExpeditionShell';
import { buddyWrite } from './api';
import { useHostAction } from './expedition-action';
import {
  FOCI,
  type Focus,
  QUESTION_GLYPH,
  SCOPE_LABEL,
  STAGE_TONE,
  attemptCostLine,
  attemptOutcome,
  attemptState,
  attemptTone,
  expeditionPill,
  expeditionRead,
  expeditionUrl,
  nowLine,
  ownerActions,
  pollMsOf,
  shortTime,
  summaryOf,
  timeLine,
  validationsOf,
  worktreeLine,
} from './expedition-view';
import './Expedition.css';

const POLL_MS = 5_000;

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

export function LiveModal({
  id,
  presentation,
  onClose,
}: { id: string; presentation: Presentation; onClose(): void }) {
  const [pollMs, setPollMs] = useState(POLL_MS);
  const view = usePolledFetch<ExpeditionView | ExpeditionRetiredView>(expeditionUrl(id), pollMs);
  const read = view.data ? expeditionRead(view.data) : null;
  // A finished expedition stops polling (audit #8), a retired one is frozen; derived from the
  // last response.
  const nextPollMs = read ? pollMsOf(summaryOf(read), POLL_MS) : POLL_MS;
  if (nextPollMs !== pollMs) setPollMs(nextPollMs);
  if (!read)
    return (
      <Pending
        label="expedition"
        kind="live"
        presentation={presentation}
        onClose={onClose}
        read={firstRead(view)}
      />
    );
  const summary = summaryOf(read);
  const pill = expeditionPill(summary);
  const refetch = async () => {
    // The list's rows (rail, index, Home) move with the modal's footer action.
    invalidateBuddyResources();
    await view.refetch();
  };
  return (
    <Shell
      label={`Expedition ${summary.name}`}
      kind="live"
      presentation={presentation}
      onClose={onClose}
      title={
        <>
          <strong className="expedition-modal-title ui-truncate">⛺ {summary.name}</strong>
          <span className={`expedition-pill expedition-tone-${pill.tone}`}>{pill.label}</span>
        </>
      }
    >
      <WithDirectory workspaceId={summary.workspaceId}>
        {read.t === 'live' ? (
          <LiveBody
            v={read.view}
            presentation={presentation}
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

/** A retired expedition: its frozen last report and counts, read-only (no chat, no tabs). */
function RetiredBody({ r }: { r: ExpeditionRetiredView }) {
  const s = r.summary;
  return (
    <div className="expedition-pane ui-stack">
      <div className="expedition-meters">
        <Stat label="Attempts" value={`${s.counts.attempts}/${s.counts.maxAttempts}`} />
        <Stat label="Verified" value={String(s.counts.verified)} />
        <Stat label="Cost" value={s.cost.short} />
      </div>
      <Section title="Last status report">
        <ExpeditionMarkdown text={r.report} />
      </Section>
    </div>
  );
}

/** The owner's footer action, by `ownerActions`: Retire (finished) or Stop and retire (open),
 * each behind a two-step inline confirm so a stray click cannot put a crew away. */
function OwnerFooter({ v, refetch }: { v: ExpeditionView; refetch(): Promise<void> }) {
  const action = ownerActions(v);
  switch (action.t) {
    case 'none':
      return null;
    case 'retire':
    case 'stop_and_retire':
      return (
        <footer className="expedition-footer ui-row">
          <RetireControl id={v.id} mode={action.t} refetch={refetch} />
        </footer>
      );
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

function RetireControl({
  id,
  mode,
  refetch,
}: { id: string; mode: 'retire' | 'stop_and_retire'; refetch(): Promise<void> }) {
  const [asked, setAsked] = useState(false);
  const { state, run } = useHostAction(
    () => buddyWrite('expedition.retire', { id }, { mode }),
    refetch
  );
  const copy = RETIRE_COPY[mode];
  return (
    <span className="ui-row expedition-launch">
      {state.t === 'failed' && (
        <span role="alert" className="expedition-error">
          {state.error}
        </span>
      )}
      {asked ? (
        <>
          <span className="ui-muted">{copy.confirm}</span>
          <button
            type="button"
            className="expedition-button expedition-button--primary"
            disabled={state.t === 'pending'}
            aria-busy={state.t === 'pending'}
            onClick={run}
          >
            {state.t === 'pending' ? 'Retiring…' : `Yes, ${copy.ask.toLowerCase()}`}
          </button>
          <button type="button" className="expedition-button" onClick={() => setAsked(false)}>
            Cancel
          </button>
        </>
      ) : (
        <button type="button" className="expedition-button" onClick={() => setAsked(true)}>
          {copy.ask}
        </button>
      )}
    </span>
  );
}

/** The pieces of the live body, arranged by presentation. */
type Parts = { tabs: ReactNode; panel: ReactNode; chat: ReactNode };

/** The dialog shows the chat beside the tabs, so it has no Chat tab and a 'chat' focus (left over
 * from a sheet the window outgrew) shows the workers. The sheet makes the chat a tab. One entry
 * per presentation; the body never asks which one it is in. */
const LAYOUT: Record<
  Presentation,
  {
    foci: readonly { focus: Focus; label: string }[];
    shown(focus: Focus): Focus;
    arrange(parts: Parts): ReactNode;
  }
> = {
  dialog: {
    foci: FOCI.filter((f) => f.focus !== 'chat'),
    shown: (focus) => (focus === 'chat' ? 'workers' : focus),
    arrange: ({ tabs, panel, chat }) => (
      <div className="expedition-columns">
        <div className="expedition-main ui-stack">
          {tabs}
          {panel}
        </div>
        {chat}
      </div>
    ),
  },
  sheet: {
    foci: FOCI,
    shown: (focus) => focus,
    arrange: ({ tabs, panel }) => (
      <div className="expedition-main ui-stack">
        {tabs}
        {panel}
      </div>
    ),
  },
};

/** What each tab shows; the chat tab shows the chat the layout built. */
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

function LiveBody({
  v,
  presentation,
  stale,
}: { v: ExpeditionView; presentation: Presentation; stale: Error | null }) {
  const [focus, setFocus] = useState<Focus>('workers');
  const chatRef = useRef<HTMLDivElement>(null);
  const layout = LAYOUT[presentation];
  const { foci } = layout;
  const pane = layout.shown(focus);
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
      {layout.arrange({
        tabs,
        panel: <div {...panelProps(pane)}>{PANE[pane](v, chat)}</div>,
        chat,
      })}
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
        {a.kind === 'work' && (
          <details>
            <summary className="expedition-link">Brief</summary>
            <ExpeditionMarkdown text={a.ask} />
          </details>
        )}
        {a.briefing.t !== 'unbriefed' && (
          <details>
            <summary className="expedition-link">Full instructions</summary>
            <ExpeditionMarkdown text={a.briefing.brief} />
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
