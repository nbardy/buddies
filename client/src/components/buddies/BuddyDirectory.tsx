import { useAtomValue } from 'jotai';
import { type ReactNode, useState } from 'react';
import { rosterHiddenBuddyIdsAtom } from '../../atoms/buddy-visibility';
import type { BuddyOverview } from './types';
import { directoryEntries, filterDirectoryEntries } from './ui-contract';

const CARD_VISUALS = ['horizon', 'archive', 'orbit', 'ember', 'tide'] as const;

export function BuddyDirectory({
  overview,
  onOpen,
  onNew,
  creating,
  notice,
}: {
  overview: BuddyOverview;
  onOpen: (id: string) => void;
  onNew: () => void;
  creating: boolean;
  /** Under the intro: the overview's last refresh failed, but this is what it holds. */
  notice?: ReactNode;
}) {
  const hidden = useAtomValue(rosterHiddenBuddyIdsAtom);
  const [query, setQuery] = useState('');
  const visibleBuddies = filterDirectoryEntries(directoryEntries(overview), query).filter(
    (entry) => !hidden.has(entry.buddy.id)
  );

  return (
    <main className="buddies-directory-content">
      <header className="buddies-directory-header">
        <div>
          <span className="buddies-directory-eyebrow">Workspace directory</span>
          <h1>Buddies</h1>
          <p>Meet the specialist teammates shaping work across your projects.</p>
          {notice}
        </div>
        <div className="buddies-directory-tools ui-row">
          <label className="buddies-directory-search ui-row ui-card ui-muted">
            <span className="sr-only">Search buddies</span>
            <svg aria-hidden="true" width="15" height="15" viewBox="0 0 16 16" fill="none">
              <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" />
              <line
                x1="11"
                y1="11"
                x2="14.5"
                y2="14.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search buddies…"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <span className="buddies-directory-count ui-muted">
            {visibleBuddies.length} {visibleBuddies.length === 1 ? 'Buddy' : 'Buddies'}
          </span>
        </div>
      </header>
      {visibleBuddies.length === 0 && query.trim() && (
        <output className="buddies-directory-empty">No buddies match “{query.trim()}”.</output>
      )}
      <div className="buddy-card-grid">
        <button
          type="button"
          className="buddy-directory-card ui-stack ui-card buddy-directory-card--new"
          onClick={onNew}
          disabled={creating}
        >
          <span className="buddy-card-visual buddy-card-visual--new" aria-hidden="true">
            <span className="buddy-card-visual__plus">+</span>
          </span>
          <span className="buddy-card-title">
            {creating ? 'Opening Builder…' : 'Create a new Buddy'}
          </span>
          <span className="buddy-card-hover-copy">
            <span>Describe a role in chat and the Builder will shape the brief with you.</span>
            <span className="buddy-card-hover-action">
              {creating ? 'Opening…' : 'Start here →'}
            </span>
          </span>
        </button>
        {visibleBuddies.map(({ buddy, workspace, reports, tasks }, index) => {
          const visual = CARD_VISUALS[index % CARD_VISUALS.length];
          return (
            <button
              type="button"
              key={buddy.id}
              className={`buddy-directory-card ui-stack ui-card buddy-directory-card--${visual}`}
              onClick={() => onOpen(buddy.id)}
            >
              <span className="buddy-card-visual" aria-hidden="true">
                <span className="buddy-card-visual__orb" />
                <span className="buddy-card-visual__line" />
              </span>
              <span className="buddy-card-title">{buddy.name}</span>
              <span className="buddy-card-hover-copy">
                <span>{buddy.role}</span>
                <span className="buddy-card-hover-meta ui-row ui-muted">
                  <span className={`buddy-presence buddy-presence--${buddy.status}`}>
                    {buddy.status}
                  </span>
                  <span className="buddy-card-workspace ui-truncate">{workspace.name}</span>
                  {reports.length > 0 && (
                    <span>
                      {reports.length} {reports.length === 1 ? 'report' : 'reports'}
                    </span>
                  )}
                  <span>{tasks.open} open</span>
                  <span>{tasks.blocked} blocked</span>
                </span>
                <span className="buddy-card-hover-action">Open Buddy →</span>
              </span>
            </button>
          );
        })}
      </div>
    </main>
  );
}
