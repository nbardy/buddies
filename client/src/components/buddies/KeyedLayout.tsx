import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useScrollActivity } from '../../hooks/useScrollActivity';
import { channelsHref } from './channels-view';

/** A tab's scroll column; its sections share the channel feed's reading width. */
export function Scroll({ children }: { children: ReactNode }) {
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

export const when = (iso: string) =>
  new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

export type Frame = 'desktop' | 'mobile';

export function timeLeft(deadline: string, now: number): string {
  const minutes = Math.round((Date.parse(deadline) - now) / 60_000);
  if (minutes <= 0) return 'deadline reached';
  const h = Math.floor(minutes / 60);
  return `${h > 0 ? `${h} h ` : ''}${minutes % 60} min left`;
}
/** Re-renders the time left every 30 s; the record polls only when it changes. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export function Gone({
  frame,
  workspaceId,
  text,
}: {
  frame: Frame;
  workspaceId: string;
  text: string;
}) {
  return (
    <div className="channel-browser-empty expedition-gone ui-muted ui-row" data-frame={frame}>
      <strong>Expedition</strong>
      <span>{text}</span>
      <Link to={channelsHref(workspaceId, { kind: 'home' })}>Back to channels</Link>
    </div>
  );
}
