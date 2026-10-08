import { useAtomValue } from 'jotai';
import { Link, useSearchParams } from 'react-router-dom';
import { buddyWorkerCountsFamily } from '../../atoms/buddy-background';
import { connectionAtom, loadCompleteOf } from '../../atoms/conversations';
import { useBuddyWorkerRead } from '../../hooks/useBuddyData';
import './ChannelWorkers.css';
import { channelLinkPath } from './channel-link';

/** A separate link beside Message/Wake, so inspecting workers never starts a turn. */
export function BuddyBackgroundLink({
  buddyId,
  workspaceId,
  name,
}: { buddyId: string; workspaceId: string; name: string }) {
  const read = useBuddyWorkerRead(buddyId, workspaceId);
  const {
    active: count,
    running,
    runningCount,
  } = useAtomValue(buddyWorkerCountsFamily({ buddyId, workspaceId }));
  const loaded =
    loadCompleteOf(useAtomValue(connectionAtom).server) && (count > 0 || read.kind !== 'loading');
  const [searchParams] = useSearchParams();
  const returnParams = new URLSearchParams(searchParams);
  returnParams.delete('workers');
  const path = channelLinkPath(workspaceId, { kind: 'workers', buddyId });
  const label = `${name}: ${loaded ? `${count} active background workers` : 'loading background workers'}`;
  const tooltip = loaded
    ? `${runningCount} ${runningCount === 1 ? 'worker' : 'workers'} running${count > runningCount ? ` · ${count - runningCount} queued` : ''}`
    : 'Loading workers…';
  return (
    <Link
      className="buddy-background-link"
      data-running={loaded && running ? 'true' : undefined}
      to={returnParams.size ? `${path}&${returnParams}` : path}
      aria-label={label}
      title={`${name}: ${tooltip}. View workers and recent activity`}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        aria-hidden="true"
      >
        <rect x="6.5" y="2" width="7" height="5" rx="1" />
        <path d="M10 7v3M4 13v-3h12v3" />
        <rect x="1" y="13" width="6" height="5" rx="1" />
        <rect x="13" y="13" width="6" height="5" rx="1" />
      </svg>
      <span>{loaded ? count : '…'}</span>
    </Link>
  );
}
