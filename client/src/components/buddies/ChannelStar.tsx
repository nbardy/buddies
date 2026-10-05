import { useAtomValue } from 'jotai';
import { starredChannelIdsAtom, toggleChannelStar } from '../../atoms/ui';
import './ChannelStar.css';

export function ChannelStar({ channelId, name }: { channelId: string; name: string }) {
  const starred = useAtomValue(starredChannelIdsAtom).includes(channelId);
  const label = `${starred ? 'Unstar' : 'Star'} #${name}`;
  return (
    <button
      type="button"
      className="channel-star"
      aria-label={label}
      title={label}
      aria-pressed={starred}
      onClick={() => toggleChannelStar(channelId)}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="m12 3 2.8 5.7 6.3.9-4.5 4.4 1 6.2-5.6-3-5.6 3 1-6.2L2.9 9.6l6.3-.9Z"
          fill={starred ? 'currentColor' : 'none'}
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
