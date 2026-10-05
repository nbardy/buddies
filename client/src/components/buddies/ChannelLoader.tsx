import { type RefObject, useEffect, useRef } from 'react';
import type { OlderEdge } from './channel-data';
import './ChannelLoader.css';

// Shown while a channel or thread has never loaded. Before this the pane
// rendered "No posts yet" during the first fetch and then flashed the posts
// in — an empty channel and an unloaded one looked identical. Desktop and
// mobile share it (gate G3 allows components/buddies/).
//
// Fix-guard: animate ONLY the outer <svg>. CSS animations on elements INSIDE an
// SVG (<g>/<path>) force an SVG layout every frame on the main thread; the
// idle "older posts" flame did ~15 layouts/s for as long as a feed had older
// posts (measured 2026-10-05: 229 layouts / 3.2 s per 15 s vs 0 / 0.16 s with
// the animation on the <svg> element itself, which runs on the compositor).
export function ChannelLoader({ label }: { label: string }) {
  return (
    <output className="channel-loader ui-stack" aria-live="polite">
      <svg className="channel-loader-flame" viewBox="0 0 32 44" aria-hidden="true">
        <defs>
          <linearGradient id="channel-loader-outer" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stopColor="#ff5a1f" />
            <stop offset="0.6" stopColor="#ff9a2e" />
            <stop offset="1" stopColor="#ffcf5c" stopOpacity="0.85" />
          </linearGradient>
          <linearGradient id="channel-loader-inner" x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stopColor="#ffd36b" />
            <stop offset="1" stopColor="#fff4c2" />
          </linearGradient>
        </defs>
        <path
          fill="url(#channel-loader-outer)"
          d="M16 2c1.5 7 9.5 11.5 11.5 20.5C29.5 32 23.5 42 16 42S2.5 32 4.5 22.5C5.8 16.5 10 14 11 8.5c2.2 3 2.8 5.8 2.6 8.6C15.6 13.2 16.6 8 16 2Z"
        />
        <path
          fill="url(#channel-loader-inner)"
          d="M16 18c1 4 6 6.5 6 13 0 5.5-2.8 9-6 9s-6-3.5-6-9c0-4.2 2.6-6 3.6-9 .9 1.6 1.2 3 1 4.4C15.8 24.2 16.4 21.4 16 18Z"
        />
      </svg>
      <span className="channel-loader-label">{label}</span>
    </output>
  );
}

// Older posts start loading this far above the top of the view, so a reader
// scrolling up meets posts rather than the flame.
const PRELOAD_MARGIN = '1200px 0px 0px 0px';

/**
 * The top of a channel feed, one view per OlderEdge: reaching it loads the
 * page before the oldest post shown (channel-data.ts useChannelFeed).
 */
export function ChannelHistory({
  edge,
  scrollRef,
  onReach,
}: {
  edge: OlderEdge;
  scrollRef: RefObject<HTMLDivElement | null>;
  onReach(): void;
}) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const reachRef = useRef(onReach);
  reachRef.current = onReach;
  // Observed afresh on every edge change: observe() reports the current
  // intersection at once, so when a loaded page is too short to move the top
  // out of range the next one loads without waiting for another scroll.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (edge.kind !== 'more' || !sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) reachRef.current();
      },
      { root: scrollRef.current, rootMargin: PRELOAD_MARGIN }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [edge.kind, scrollRef]);
  switch (edge.kind) {
    case 'more':
    case 'loading':
      return (
        <div ref={sentinelRef} className="channel-history">
          <ChannelLoader label="Loading older posts…" />
        </div>
      );
    case 'failed':
      return <HistoryFailed error={edge.error} onRetry={onReach} />;
    case 'complete':
      return null;
  }
}

function HistoryFailed({ error, onRetry }: { error: Error; onRetry(): void }) {
  return (
    <div className="channel-history channel-history-failed ui-row" role="alert">
      <span>Older posts could not load: {error.message}</span>
      <button type="button" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}
