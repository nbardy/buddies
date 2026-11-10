import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useBuddyDetail } from '../../hooks/useBuddyData';
import { BuddyBackgroundTasks } from './BuddyBackgroundTasks';
import { BuddySigil } from './BuddySigil';
import './ChannelWorkers.css';

const NO_RUNS: import('./types').Run[] = [];
export function ChannelWorkers({
  buddyId,
  buddyName,
  workspaceId,
}: {
  buddyId: string;
  buddyName: string;
  workspaceId: string;
}) {
  const location = useLocation();
  const [params] = useSearchParams();
  const detail = useBuddyDetail(buddyId);
  const back = new URLSearchParams(params);
  back.delete('workers');
  return (
    <section className="channel-workers ui-stack" aria-label={`${buddyName} background workers`}>
      <header className="channel-workers-header ui-row">
        <Link
          to={`${location.pathname}${back.size ? `?${back}` : ''}`}
          aria-label="Back to Buddies"
        >
          ‹
        </Link>
        <BuddySigil className="channel-workers-sigil" name={buddyName} />
        <h1 className="channel-workers-title ui-truncate">{buddyName}</h1>
      </header>
      <div className="channel-workers-scroll">
        <BuddyBackgroundTasks
          buddyId={buddyId}
          fixedWorkspaceId={workspaceId}
          runs={detail.data?.runs ?? NO_RUNS}
          tasks={detail.data?.tasks}
          refresh={detail.refetch}
        />
      </div>
    </section>
  );
}
