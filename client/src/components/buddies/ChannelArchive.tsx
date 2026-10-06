import { type ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { errorText } from './api';
import { CHANNEL_BACKSTOP_MS, setChannelArchived } from './channel-data';
import { channelLinkPath } from './channel-link';
import type { Channel } from './types';
import './ChannelHeaderControls.css';

export const archivedChannelsUrl = (workspaceId: string) =>
  `/api/buddies/workspaces/${encodeURIComponent(workspaceId)}/channels?archived=1`;

export function useArchivedChannels(workspaceId: string) {
  return usePolledFetch<Channel[]>(archivedChannelsUrl(workspaceId), CHANNEL_BACKSTOP_MS);
}

export function ChannelArchiveButton({ channel }: { channel: Channel }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  if (channel.kind.type !== 'public') return null;
  return (
    <span className="ui-stack">
      <button
        type="button"
        className="ui-control"
        disabled={pending}
        onClick={() => {
          setPending(true);
          setError(null);
          void setChannelArchived(channel.id, !channel.archivedAt)
            .catch((error) => setError(errorText(error)))
            .finally(() => setPending(false));
        }}
      >
        {channel.archivedAt ? 'Restore' : 'Archive'}
      </button>
      {error && <span role="alert">{error}</span>}
    </span>
  );
}

export function ChannelHeaderControls({
  channel,
  description,
  children,
}: {
  channel?: Channel;
  description: string;
  children?: ReactNode;
}) {
  const [infoOpen, setInfoOpen] = useState(false);
  return (
    <div className="channel-header-controls">
      {description && (
        <span className="channel-header-info">
          <button
            type="button"
            aria-label="Channel description"
            aria-expanded={infoOpen}
            title="Channel description"
            onClick={() => setInfoOpen((open) => !open)}
          >
            ⓘ
          </button>
          <span
            className="channel-header-info__text ui-popover ui-popover--end"
            data-open={infoOpen || undefined}
          >
            {description}
          </span>
        </span>
      )}
      {channel?.kind.type === 'public' && (
        <details className="channel-header-settings">
          <summary aria-label="Channel settings" title="Channel settings">
            ⚙
          </summary>
          <div className="ui-popover ui-popover--end ui-stack">
            {children}
            <ChannelArchiveButton channel={channel} />
          </div>
        </details>
      )}
    </div>
  );
}

export function ArchivedChannels({
  workspaceId,
  channels,
}: { workspaceId: string; channels: readonly Channel[] }) {
  if (!channels.length) return null;
  return (
    <section className="ui-stack" aria-labelledby="archived-channels-heading">
      <div className="ui-section__header">
        <h3 id="archived-channels-heading" className="ui-section__title">
          Archived channels ({channels.length})
        </h3>
      </div>
      <ul className="channel-browser-channels mobile-channels-list">
        {channels.map((channel) => (
          <li key={channel.id} className="channel-browser-buddy ui-row">
            <Link
              className="channel-browser-buddy-link mobile-channels-row"
              to={channelLinkPath(workspaceId, { kind: 'channel', channelId: channel.id })}
            >
              #{channel.kind.type === 'public' ? channel.kind.name : 'channel'}
            </Link>
            <ChannelArchiveButton channel={channel} />
          </li>
        ))}
      </ul>
    </section>
  );
}
