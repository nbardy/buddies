import type { ExpeditionCharterView, ExpeditionDefault } from '@unleashd/shared';
import { type ReactNode, createContext, useContext, useMemo, useState } from 'react';
import { ChannelMarkdown } from './ChannelMarkdown';
import { type WorkspaceDirectory, useWorkspaceDirectory } from './channel-data';
import { limitItems } from './expedition-view';
import '../FilePreview.css';
import './Expedition.css';

// The charter and the markdown surface the live and draft modals share.

/** The workspace directory the modal's markdown resolves Buddy mentions and Task refs against.
 * Provided once per modal body (WithDirectory); a markdown block outside one is a bug, named. */
const DirectoryContext = createContext<WorkspaceDirectory | null>(null);

export function WithDirectory({
  workspaceId,
  children,
}: { workspaceId: string; children: ReactNode }) {
  const directory = useWorkspaceDirectory(workspaceId);
  return <DirectoryContext.Provider value={directory}>{children}</DirectoryContext.Provider>;
}

/** Markdown exactly as the chat renders it (ChannelMarkdown: line breaks, buddy:/task: links,
 * highlighted code), on the file preview's document surface (FilePreview.css). */
export function ExpeditionMarkdown({ text }: { text: string }) {
  const directory = useContext(DirectoryContext);
  const body = useMemo(() => ({ t: 'text' as const, text }), [text]);
  if (!directory) throw new Error('ExpeditionMarkdown outside an expedition modal body');
  return (
    <div className="file-preview-markdown expedition-markdown">
      <ChannelMarkdown body={body} buddyNames={directory.buddyNames} tasks={directory.taskById} />
    </div>
  );
}

/** The goal, rendered, clamped to a few lines until "Show more". */
export function Goal({ goal }: { goal: string }) {
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
export function Bullets({ items }: { items: readonly string[] }) {
  return (
    <ul className="expedition-bullets">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

/** The small "default" marker on a value the host filled in for the draft. */
export function DefaultMark({ on }: { on: boolean }) {
  return on ? (
    <span className="expedition-default" title="Not stated in the request; the default applies">
      default
    </span>
  ) : null;
}

export function Section({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="expedition-section ui-stack">
      <h3 className="ui-section__title">{title}</h3>
      {children}
    </section>
  );
}

/** Repo paths (or plain scope words) as chips; the empty list says so, marked when defaulted. */
export function ScopeList({ items, defaulted }: { items: string[]; defaulted: boolean }) {
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
export function CharterPane({
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
