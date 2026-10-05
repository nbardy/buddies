import { bodyText } from '@unleashd/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { resource, usePolledFetch } from '../../hooks/usePolledFetch';
import { SearchExcerpt } from './SearchExcerpt';
import { BuddyApiError, buddyApi } from './api';
import { authorName, channelPostBody } from './channel-data';
import { channelLinkPath, postLink } from './channel-link';
import { searchTerms } from './search-excerpt';
import type { Channel, Post } from './types';
import '../../views/search/SearchView.css';

const MIN_QUERY_LENGTH = 2;
const RESULT_LIMIT = 50;

/** GET .../search: the channels the words name (above the posts) and the newest matching posts. */
interface SearchResults {
  channels: readonly Channel[];
  posts: readonly Post[];
}

function searchResource(workspaceId: string, query: string) {
  const params = new URLSearchParams({ q: query, limit: String(RESULT_LIMIT) });
  const url = `/api/buddies/workspaces/${encodeURIComponent(workspaceId)}/search?${params}`;
  return resource<SearchResults>(url, (signal) => buddyApi<SearchResults>(url, { signal }));
}

/** The server rejects a malformed or unknown-author search with a 400 whose text is for the owner
 *  ("no Buddy named …"); strip the `[invalid]` code prefix and show it as the answer, not as a failure. */
function rejection(error: Error): string | null {
  if (!(error instanceof BuddyApiError) || error.status !== 400) return null;
  return error.message.replace(/^\[invalid\]\s*(invalid:\s*)?(search text:\s*)?/, '');
}

function postProse(post: Post): string {
  return bodyText(channelPostBody(post));
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// Search lives in the channel header: a pill that expands in place into the
// field, with results dropping below it. The pill stays in flow (hidden while
// open) so the header never reflows; the panel overlays from the same spot.
export function ChannelSearch({
  workspaceId,
  channelNames,
  buddyNames,
}: {
  workspaceId: string;
  channelNames: ReadonlyMap<string, string>;
  buddyNames: Readonly<Record<string, string>>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const trimmed = query.trim();
  const terms = useMemo(() => searchTerms(trimmed), [trimmed]);
  const results = usePolledFetch(
    trimmed.length >= MIN_QUERY_LENGTH ? searchResource(workspaceId, trimmed) : null,
    0
  );

  const close = () => {
    setOpen(false);
    setQuery('');
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setOpen(true);
      }
      if (open && event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        setQuery('');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    // A click anywhere outside the expanded search collapses it.
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  return (
    <div className="channel-search" ref={rootRef}>
      <button
        type="button"
        className="channel-search-trigger ui-row"
        aria-label="Search all channel messages"
        aria-expanded={open}
        title="Search all messages (⌘F)"
        style={open ? { visibility: 'hidden' } : undefined}
        onClick={() => setOpen(true)}
      >
        <SearchIcon />
      </button>
      {open && (
        <div className="channel-search-panel ui-stack">
          <div className="channel-search-field ui-row">
            <SearchIcon />
            <input
              ref={inputRef}
              type="text"
              enterKeyHint="search"
              value={query}
              className="search-view__input"
              aria-label="Search all channel messages"
              placeholder="Search all messages…"
              onChange={(event) => setQuery(event.target.value)}
            />
            <button type="button" className="search-view__esc ui-card ui-muted" onClick={close}>
              Esc
            </button>
          </div>
          <div className="channel-search-results ui-stack">
            {trimmed.length === 0 ? (
              <p className="search-view__status">Search every channel in this workspace.</p>
            ) : trimmed.length < MIN_QUERY_LENGTH ? (
              <p className="search-view__status">Type at least {MIN_QUERY_LENGTH} characters.</p>
            ) : results.kind === 'loading' || results.kind === 'idle' ? (
              <p className="search-view__status">Searching…</p>
            ) : results.kind === 'failed' ? (
              <p className="search-view__status" role="alert">
                {rejection(results.error) ?? `Search failed: ${results.error.message}`}
              </p>
            ) : results.kind === 'stale' && results.data.posts.length === 0 ? (
              <p className="search-view__status" role="alert">
                Search could not refresh: {results.error.message}
              </p>
            ) : results.data.posts.length === 0 && results.data.channels.length === 0 ? (
              <p className="search-view__status">No messages found.</p>
            ) : (
              <ul className="search-view__results channel-search-list">
                {results.data.channels.map((channel) => (
                  <li key={channel.id}>
                    <Link
                      to={channelLinkPath(workspaceId, { kind: 'channel', channelId: channel.id })}
                      onClick={close}
                      className="search-view__item channel-search-item"
                    >
                      <span className="search-view__head">
                        <span className="search-view__kind search-view__kind--buddy">Channel</span>
                        <span className="search-view__title ui-truncate">
                          {channelNames.get(channel.id) ?? '#channel'}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
                {results.data.posts.map((post) => (
                  <li key={post.id}>
                    <Link
                      to={channelLinkPath(workspaceId, postLink(post))}
                      onClick={close}
                      className="search-view__item channel-search-item"
                    >
                      <span className="search-view__head">
                        <span className="search-view__kind search-view__kind--chat">
                          {channelNames.get(post.channelId) ?? '#channel'}
                        </span>
                        <span className="search-view__title ui-truncate">
                          {authorName(post.author, buddyNames)}
                        </span>
                      </span>
                      <SearchExcerpt body={postProse(post)} terms={terms} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
