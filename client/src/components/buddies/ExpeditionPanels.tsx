import {
  ALLOWED,
  type Attempt,
  type Done,
  type Expedition,
  type Launch,
  type State,
  attemptResult,
} from '@unleashd/shared';
import { type ReactNode, useMemo } from 'react';
import { useScrollActivity } from '../../hooks/useScrollActivity';
import { ChannelMarkdown } from './ChannelMarkdown';
import type { WorkspaceDirectory } from './channel-data';
import { useAct } from './expedition-api';

// The expedition's non-chat tabs (ExpeditionView.tsx): Attempts (newest first, with the owner's
// Pass/Fail), Goal (blocked-launch issues, the goal, Done when, notes for the crew) and Details
// (limits, launch facts, extend and retire).

/** A tab's scroll column; its sections share the channel feed's reading width. */
function Scroll({ children }: { children: ReactNode }) {
  const scroll = useScrollActivity();
  return (
    <div
      className="channel-browser-scroll ui-scroll-quiet expedition-scroll"
      data-scrolling={scroll['data-scrolling']}
      onScroll={scroll.onScroll}
    >
      {children}
    </div>
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

export const when = (iso: string) =>
  new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

// ---- Goal ----

export function GoalPanel({ x, directory }: { x: Expedition; directory: WorkspaceDirectory }) {
  const body = useMemo(() => ({ t: 'text' as const, text: x.charter.goal }), [x.charter.goal]);
  return (
    <Scroll>
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
        <div className="expedition-goal">
          <ChannelMarkdown
            body={body}
            buddyNames={directory.buddyNames}
            tasks={directory.taskById}
          />
        </div>
      </Section>
      <Section title="Done when">
        {DONE[x.charter.done.t](x.charter.done as never)}
        {x.charter.oracle.length > 0 && (
          <p className="expedition-plain">Protected: {x.charter.oracle.join(', ')}</p>
        )}
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
    </Scroll>
  );
}

const DONE: { [K in Done['t']]: (d: Extract<Done, { t: K }>) => ReactNode } = {
  checks: (d) => (
    <ul className="expedition-checks ui-stack">
      {d.checks.map((argv) => (
        <li key={argv.join('\0')}>
          <code>{argv.join(' ')}</code>
        </li>
      ))}
    </ul>
  ),
  owner: () => <p className="expedition-plain">You judge each attempt: pass or fail.</p>,
};

// ---- Attempts ----

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

export function AttemptsPanel({ x, empty }: { x: Expedition; empty: string }) {
  const act = useAct(x.id);
  const verdict = x.charter.done.t === 'owner' && ALLOWED.verdict.includes(x.state.t);
  return (
    <Scroll>
      <Section title={`Attempts · ${x.attempts.length} of ${x.charter.maxAttempts}`}>
        {x.attempts.length === 0 && <p className="expedition-plain ui-muted">{empty}</p>}
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
                    <span className="expedition-attempt-time ui-muted">{when(a.startedAt)}</span>
                  </div>
                  {lesson && <p className="expedition-attempt-lesson">{lesson}</p>}
                  <code className="expedition-attempt-branch">{a.branch}</code>
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
      </Section>
    </Scroll>
  );
}

// ---- Details ----

type Row = [string, ReactNode];
const launched = (l: Launch, directory: WorkspaceDirectory): Row[] => [
  ['Launched', when(l.at)],
  ['Deadline', when(l.deadline)],
  ['Repository', <code key="r">{l.repoRoot}</code>],
  ['Base', <code key="b">{l.baseSha.slice(0, 12)}</code>],
  ['Crew', directory.buddyNames[l.crewBuddyId] ?? l.crewBuddyId],
];
/** The launch facts; a draft has none yet. */
const RUN: {
  [K in State['t']]: (s: Extract<State, { t: K }>, directory: WorkspaceDirectory) => Row[];
} = {
  draft: () => [['Launch', 'Repository, base and crew are set at launch.']],
  running: (s, d) => launched(s.launch, d),
  paused: (s, d) => launched(s.launch, d),
  finished: (s, d) => launched(s.launch, d),
};

export function DetailsPanel({
  x,
  directory,
  manage,
}: { x: Expedition; directory: WorkspaceDirectory; manage: ReactNode }) {
  const c = x.charter;
  const seat = [c.seat.provider, c.seat.model, c.seat.reasoningEffort].filter(Boolean).join(' · ');
  const limits: Row[] = [
    ['Attempts', `up to ${c.maxAttempts}, ${c.maxLive} at a time`],
    ['Time box', `${c.hours} h`],
    ['Crew seat', seat],
    ['Created', when(x.createdAt)],
  ];
  return (
    <Scroll>
      <Section title="Limits">
        <Facts rows={limits} />
      </Section>
      <Section title="Run">
        <Facts rows={RUN[x.state.t](x.state as never, directory)} />
      </Section>
      <Section title="Manage">{manage}</Section>
    </Scroll>
  );
}

const Facts = ({ rows }: { rows: Row[] }) => (
  <dl className="expedition-plain">
    {rows.map(([k, v]) => (
      <div key={k} className="expedition-fact">
        <dt className="ui-muted">{k}</dt>
        <dd>{v}</dd>
      </div>
    ))}
  </dl>
);
