import { useAtomValue } from 'jotai';
import { type ReactNode, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { createBuddyViaBuilder } from '../../components/buddies/create-buddy-builder';
import { initials } from '../../components/buddies/ui-contract';
import { useBuddyOverview } from '../../hooks/useBuddyData';
import { mobileConversationRouteState } from '../../utils/conversation-route-state';
import { mobileBuddyDirectoryAtom } from '../atoms/buddies';
import {
  EmptyState,
  MobileHeaderAction,
  MobilePage,
  MobileRefreshNotice,
} from '../components/MobileUI';

export function BuddiesMobile() {
  const navigate = useNavigate();
  const location = useLocation();
  const chatRouteState = useMemo(() => mobileConversationRouteState(location), [location]);
  const overviewFetch = useBuddyOverview();
  const overview = overviewFetch.data;
  const [query, setQuery] = useState('');
  const directoryAtom = useMemo(() => mobileBuddyDirectoryAtom(overview, query), [overview, query]);
  const { groups, total, matched } = useAtomValue(directoryAtom);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const openBuilder = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      void navigate(`/chat/${await createBuddyViaBuilder()}`, { state: chatRouteState });
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : String(cause));
      setCreating(false);
    }
  };

  // The page shell is constant across loading/error/empty/populated so the
  // "+ New" action never disappears — the empty state is precisely when a user
  // needs it, and hiding it behind an early return is what made mobile look
  // like it had no create affordance at all.
  const shell = (body: ReactNode, subtitle: string) => (
    <MobilePage
      title="Buddies"
      subtitle={subtitle}
      className="mobile-buddies"
      headerAside={
        <MobileHeaderAction
          onClick={() => void openBuilder()}
          disabled={creating}
          aria-label="New buddy"
        >
          {creating ? 'Opening…' : '+ New'}
        </MobileHeaderAction>
      }
    >
      {createError && (
        <div className="mobile-sheet__error" role="alert">
          {createError}
        </div>
      )}
      {body}
    </MobilePage>
  );

  if (overviewFetch.kind === 'loading') {
    return shell(
      <output className="mobile-buddies__status" aria-live="polite" aria-busy="true">
        <p className="mobile-empty__message">Loading buddies…</p>
      </output>,
      'Loading…'
    );
  }

  // Only a directory that never loaded is unavailable. A failed refresh is
  // `stale` and keeps the list below with a notice (until 2026-09-25 it
  // replaced the list with this screen).
  if (overviewFetch.kind === 'failed') {
    return shell(
      <EmptyState
        icon="⚠"
        title="Could not load buddies"
        message={overviewFetch.error.message}
        actionLabel="Retry"
        onAction={overviewFetch.refetch}
      />,
      'Unavailable'
    );
  }

  if (!overview || total === 0) {
    return shell(
      <EmptyState
        icon="◎"
        title="No buddies yet"
        message="Tap + New to open the Buddy Builder — it interviews you and sets one up."
        actionLabel={creating ? 'Opening…' : 'New buddy'}
        onAction={() => void openBuilder()}
      />,
      'No buddies'
    );
  }

  return shell(
    <>
      {overviewFetch.kind === 'stale' && (
        <MobileRefreshNotice error={overviewFetch.error} onRetry={overviewFetch.refetch} />
      )}
      <div className="mobile-buddies__controls">
        <label className="mobile-search__field" aria-label="Filter buddies">
          <input
            type="search"
            inputMode="search"
            placeholder="Search buddies…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="mobile-search__input"
            aria-label="Search buddies or projects"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      </div>

      {matched === 0 ? (
        <EmptyState icon="⌕" message={`No buddies match “${query.trim()}”.`} />
      ) : (
        groups.map((group) => (
          <section className="mobile-buddies__group" key={group.id} aria-label={group.name}>
            <h2 className="mobile-buddies__group-heading">
              {group.name}
              <span>{group.entries.length}</span>
            </h2>
            <ul className="mobile-buddies__grid">
              {group.entries.map((entry) => (
                <li key={entry.buddy.id}>
                  <Link
                    className="mobile-buddy-card"
                    to={`/buddies/${encodeURIComponent(entry.buddy.id)}`}
                  >
                    <span className="mobile-buddy-card__avatar" aria-hidden="true">
                      {initials(entry.buddy.name)}
                    </span>
                    <span className="mobile-buddy-card__identity">
                      <strong className="mobile-buddy-card__name">{entry.buddy.name}</strong>
                      <span className="mobile-buddy-card__role">{entry.buddy.role}</span>
                      {entry.reports.length > 0 && (
                        <span className="mobile-buddy-card__activity">
                          {entry.reports.length} {entry.reports.length === 1 ? 'report' : 'reports'}
                        </span>
                      )}
                    </span>
                    <span className="mobile-buddy-card__chevron" aria-hidden="true">
                      ›
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </>,
    `${total} ${total === 1 ? 'buddy' : 'buddies'}`
  );
}
