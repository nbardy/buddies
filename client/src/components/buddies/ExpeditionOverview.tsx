import { ALLOWED, type Attempt, type Done, type Expedition, attemptResult } from '@unleashd/shared';
import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useScrollActivity } from '../../hooks/useScrollActivity';
import { ChannelMarkdown } from './ChannelMarkdown';
import type { WorkspaceDirectory } from './channel-data';
import { useAct } from './expedition-api';

// The expedition overview, where a channel's feed sits: blocked-launch issues, goal, done-when,
// attempts (newest first, with the owner's Pass/Fail) and the notes for the crew.

export function Overview({
  x,
  directory,
  noAttempts,
  top,
}: {
  x: Expedition;
  directory: WorkspaceDirectory;
  noAttempts: string;
  /** What leads the scroll: the phone's meta and controls; nothing on desktop (its header). */
  top: ReactNode;
}) {
  const scroll = useScrollActivity();
  return (
    <div
      className="channel-browser-scroll ui-scroll-quiet expedition-overview"
      data-scrolling={scroll['data-scrolling']}
      onScroll={scroll.onScroll}
    >
      {top}
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
      <Goal text={x.charter.goal} directory={directory} />
      <Section title="Done when">{DONE[x.charter.done.t](x.charter.done as never)}</Section>
      <Section title="Attempts">
        <Attempts x={x} empty={noAttempts} />
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

function Section({
  title,
  action,
  children,
}: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="expedition-section ui-stack">
      <header className="ui-section__header">
        <h3 className="ui-section__title">{title}</h3>
        {action}
      </header>
      {children}
    </section>
  );
}

/** The goal's markdown, clamped to about four lines until "Show more". Open, "Show less" sits by
 * the heading too (review 2026-11-03: the bottom one was far below the fold). */
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
  const toggle = (label: string) => (
    <button type="button" className="expedition-more" onClick={() => setOpen(!open)}>
      {label}
    </button>
  );
  return (
    <Section title="Goal" action={open && toggle('Show less')}>
      <div className="expedition-goal ui-stack">
        <div ref={ref} className="expedition-goal-text" data-open={open}>
          <ChannelMarkdown
            body={body}
            buddyNames={directory.buddyNames}
            tasks={directory.taskById}
          />
        </div>
        {(clipped || open) && toggle(open ? 'Show less' : 'Show more')}
      </div>
    </Section>
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
const when = (iso: string) =>
  new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

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
                  <span className="expedition-attempt-time ui-muted">{when(a.startedAt)}</span>
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
