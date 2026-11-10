import { useAtom, useAtomValue } from 'jotai';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { listField, rowFamily } from '../../atoms/conversations';
import { searchMatchesFamily, searchQueryAtom } from '../../atoms/search';
import type { BuddyOverview } from '../../components/buddies/types';
import {
  type DirectoryEntry,
  directoryEntries,
  filterDirectoryEntries,
} from '../../components/buddies/ui-contract';
import { useBuddyOverview } from '../../hooks/useBuddyData';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { mobileConversationRouteState } from '../../utils/conversation-route-state';
import { shortenHomePath } from '../../utils/directories';
import { formatTimeAgo, getConversationLastActivity } from '../../utils/time';
import {
  type HitGroup,
  MIN_QUERY_LENGTH,
  groupHits,
  highlight,
  historySearch,
} from './search-model';
import './SearchView.css';

/**
 * Search over Buddies, the conversations this client holds, and deep message
 * history — one ranking and one result list for both trees. The shell picks
 * the presentation:
 * - `palette`: desktop ⌘P overlay. Starts empty, optionally scoped to a
 *   folder; ↑/↓ move the selection, Enter opens it, Escape closes.
 * - `page`: the mobile Search tab. Keeps its query across visits; touch links.
 */
export type SearchViewProps =
  | { presentation: 'palette'; folder: string; onClose: () => void }
  | { presentation: 'page' };

type SearchItem =
  | { kind: 'buddy'; entry: DirectoryEntry }
  | { kind: 'conversation'; id: string }
  | { kind: 'history'; group: HitGroup };

interface Section {
  title: string;
  items: SearchItem[];
  status: string | null;
  more: string | null;
}

const DEBOUNCE_MS = 150;
const LIST_LIMIT = 20;
const HITS_PER_GROUP = 3;
const NO_BUDDIES: BuddyOverview = [];

const hrefOf = (item: SearchItem): string =>
  item.kind === 'buddy'
    ? `/buddies/${encodeURIComponent(item.entry.buddy.id)}`
    : `/chat/${encodeURIComponent(item.kind === 'conversation' ? item.id : item.group.conversationId)}`;

const keyOf = (item: SearchItem): string =>
  item.kind === 'buddy'
    ? `b:${item.entry.buddy.id}`
    : item.kind === 'conversation'
      ? `c:${item.id}`
      : `h:${item.group.conversationId}`;

function useDebounced(value: string): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value]);
  return debounced;
}

/** The ranked sections for the current query: Buddies, then local, then history. */
function useSearchSections(folder: string) {
  const [state, setState] = useAtom(searchQueryAtom);
  const query = state.kind === 'searching' ? state.query : '';
  const term = useDebounced(query.trim());
  const deep = term.length >= MIN_QUERY_LENGTH;

  const history = usePolledFetch(deep ? historySearch(term, folder) : null, 0);
  // Same cache key the Sidebar and Buddies page poll: usually already in memory.
  const buddies = useBuddyOverview(0, deep && folder === '');
  const localIds = useAtomValue(searchMatchesFamily(folder));

  const buddyItems: SearchItem[] =
    deep && folder === ''
      ? filterDirectoryEntries(directoryEntries(buddies.data ?? NO_BUDDIES), term).map((entry) => ({
          kind: 'buddy',
          entry,
        }))
      : [];
  const groups = groupHits(history.data ?? []);
  const sections: Section[] = [
    { title: 'Buddies', items: buddyItems, status: null, more: null },
    {
      title: query.trim() ? 'Conversations' : 'Recent conversations',
      items: localIds.slice(0, LIST_LIMIT).map((id) => ({ kind: 'conversation', id })),
      status: localIds.length === 0 ? 'No matching conversations on this device.' : null,
      more:
        localIds.length > LIST_LIMIT
          ? `${(localIds.length - LIST_LIMIT).toLocaleString()} more — refine your search`
          : null,
    },
    {
      title: 'Message history',
      items: groups.slice(0, LIST_LIMIT).map((group) => ({ kind: 'history', group })),
      status: !deep
        ? query.trim().length > 0
          ? `Type ${MIN_QUERY_LENGTH} characters to search message history.`
          : null
        : history.kind === 'failed'
          ? history.error.message
          : history.kind === 'ready' || history.kind === 'stale'
            ? groups.length === 0
              ? 'No message-history matches.'
              : null
            : 'Searching history…',
      more: groups.length > LIST_LIMIT ? 'More matches — refine your search' : null,
    },
  ];
  const visible = sections.filter((section) => section.items.length > 0 || section.status);
  const setQuery = (value: string) =>
    setState(value.trim().length === 0 ? { kind: 'idle' } : { kind: 'searching', query: value });
  return { query, term, setQuery, sections: visible, reset: () => setState({ kind: 'idle' }) };
}

function Highlighted({ text, term }: { text: string; term: string }) {
  return (
    <>
      {highlight(text, term).map((segment, index) =>
        segment.match ? (
          <mark key={index} className="search-view__highlight">
            {segment.text}
          </mark>
        ) : (
          segment.text
        )
      )}
    </>
  );
}

function ItemBody({ item, term }: { item: SearchItem; term: string }) {
  if (item.kind === 'buddy') {
    const { buddy } = item.entry;
    return (
      <>
        <div className="search-view__head">
          <span className="search-view__kind search-view__kind--buddy">Buddy</span>
          <span className="search-view__title ui-truncate">{buddy.name}</span>
          <span className="search-view__time ui-muted">{buddy.status}</span>
        </div>
        <div className="search-view__snippet">
          <Highlighted text={buddy.role} term={term} />
        </div>
      </>
    );
  }
  if (item.kind === 'conversation') return <ConversationBody id={item.id} term={term} />;
  const { group } = item;
  return (
    <>
      <div className="search-view__head">
        <span className="search-view__kind search-view__kind--chat">Chat</span>
        <span className="search-view__title ui-truncate" title={group.workingDirectory}>
          {shortenHomePath(group.workingDirectory) || group.conversationId.slice(0, 8)}
        </span>
        <span className="search-view__meta ui-muted">
          {group.hits.length} hit{group.hits.length === 1 ? '' : 's'}
        </span>
        <span className="search-view__time ui-muted">{formatTimeAgo(group.latest)}</span>
      </div>
      {group.hits.slice(0, HITS_PER_GROUP).map((hit) => (
        <div key={hit.messageIndex} className="search-view__snippet">
          <span className={`search-view__role search-view__role--${hit.role}`}>{hit.role}</span>{' '}
          <Highlighted text={hit.snippet} term={term} />
        </div>
      ))}
    </>
  );
}

function ConversationBody({ id, term }: { id: string; term: string }) {
  const row = useAtomValue(rowFamily(id));
  if (!row) return null;
  return (
    <>
      <div className="search-view__head">
        <span className="search-view__kind search-view__kind--chat">Chat</span>
        <span className="search-view__title ui-truncate" title={row.cwd}>
          {shortenHomePath(row.cwd) || row.id.slice(0, 8)}
        </span>
        <span className="search-view__meta ui-muted">{row.messageCount} msg</span>
        <span className="search-view__time ui-muted">
          {formatTimeAgo(getConversationLastActivity(row))}
        </span>
      </div>
      <div className="search-view__snippet">
        <Highlighted text={row.label} term={term} />
      </div>
    </>
  );
}

interface ListProps {
  sections: Section[];
  term: string;
  linkState: unknown;
  selected: number;
  onHover: (index: number) => void;
  onOpen: () => void;
}

/**
 * The result list. A history hit for a conversation this client no longer
 * holds is shown but not linked: opening it would bounce off Chat's missing-
 * conversation redirect (AGENTS: availability-checked links).
 */
function ResultList({ sections, term, linkState, selected, onHover, onOpen }: ListProps) {
  const available = useAtomValue(listField('idSet'));
  let index = -1;
  return (
    <div className="search-view__results">
      {sections.map((section) => (
        <section key={section.title} className="search-view__section">
          <h2 className="search-view__section-title ui-muted">{section.title}</h2>
          {section.items.map((item) => {
            index += 1;
            const at = index;
            const className = `search-view__item${at === selected ? ' selected' : ''}`;
            return item.kind === 'history' && !available.has(item.group.conversationId) ? (
              <div key={keyOf(item)} className={`${className} search-view__item--gone`}>
                <ItemBody item={item} term={term} />
              </div>
            ) : (
              <Link
                key={keyOf(item)}
                to={hrefOf(item)}
                state={linkState}
                className={className}
                data-selected={at === selected}
                onMouseEnter={() => onHover(at)}
                onClick={onOpen}
              >
                <ItemBody item={item} term={term} />
              </Link>
            );
          })}
          {section.status && <p className="search-view__status ui-muted">{section.status}</p>}
          {section.more && <p className="search-view__status ui-muted">{section.more}</p>}
        </section>
      ))}
    </div>
  );
}

function Palette({ folder, onClose }: { folder: string; onClose: () => void }) {
  const { query, term, setQuery, sections, reset } = useSearchSections(folder);
  const [selected, setSelected] = useState(0);
  const navigate = useNavigate();
  const available = useAtomValue(listField('idSet'));
  const panelRef = useRef<HTMLDivElement>(null);
  const items = sections.flatMap((section) => section.items);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset once per open
  useEffect(() => reset(), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: new results restart at the top
  useEffect(() => setSelected(0), [term]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the selection as it moves
  useEffect(() => {
    panelRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') return onClose();
    if (items.length === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setSelected((at) => Math.min(Math.max(at + step, 0), items.length - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const item = items[Math.min(selected, items.length - 1)];
      if (item.kind === 'history' && !available.has(item.group.conversationId)) return;
      void navigate(hrefOf(item));
      onClose();
    }
  };

  const folderName = folder.split('/').filter(Boolean).pop();
  return (
    <div className="search-view-backdrop" onClick={onClose}>
      <div
        ref={panelRef}
        className="search-view search-view--palette ui-stack"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="search-view__input-row ui-row">
          <input
            autoFocus
            type="text"
            className="search-view__input"
            placeholder={
              folderName ? `Search in ${folderName}…` : 'Search Buddies and conversations…'
            }
            aria-label="Search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <kbd className="search-view__esc ui-card ui-muted">esc</kbd>
        </div>
        <ResultList
          sections={sections}
          term={term}
          linkState={undefined}
          selected={selected}
          onHover={setSelected}
          onOpen={onClose}
        />
      </div>
    </div>
  );
}

const NO_SELECTION = -1;
const noop = () => {};

function Page() {
  const { query, term, setQuery, sections } = useSearchSections('');
  const location = useLocation();
  return (
    <div className="search-view search-view--page ui-stack">
      <div className="search-view__input-row ui-row">
        <input
          autoFocus
          type="search"
          className="search-view__input"
          placeholder="Search conversations…"
          aria-label="Search conversations"
          enterKeyHint="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query && (
          <button
            type="button"
            className="search-view__clear ui-muted"
            aria-label="Clear search"
            onClick={() => setQuery('')}
          >
            ×
          </button>
        )}
      </div>
      <ResultList
        sections={sections}
        term={term}
        linkState={mobileConversationRouteState(location)}
        selected={NO_SELECTION}
        onHover={noop}
        onOpen={noop}
      />
    </div>
  );
}

export function SearchView(props: SearchViewProps) {
  switch (props.presentation) {
    case 'palette':
      return <Palette folder={props.folder} onClose={props.onClose} />;
    case 'page':
      return <Page />;
  }
}
