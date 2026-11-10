import { useCallback, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useBuddyOverview } from '../hooks/useBuddyData';
import { errorText } from './buddies/api';
import { BuddyDirectory } from './buddies/BuddyDirectory';
import { BuddyPage, RefreshNotice } from './buddies/BuddyPage';
import { createBuddyViaBuilder } from './buddies/create-buddy-builder';
import './BuddiesDashboard.css';

function Centered({ children }: { children: string }) {
  return (
    <div className="buddies-dashboard buddies-dashboard--centered">
      <div className="buddies-loading">{children}</div>
    </div>
  );
}

function Directory() {
  const navigate = useNavigate();
  const overview = useBuddyOverview();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openBuddyBuilder = async () => {
    setCreating(true);
    setError(null);
    try {
      const conversationId = await createBuddyViaBuilder();
      void navigate(`/chat/${conversationId}?helper=buddies`);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setCreating(false);
    }
  };
  if (overview.kind === 'failed') return <Centered>{overview.error.message}</Centered>;
  if (overview.data === null) return <Centered>Loading Buddies…</Centered>;
  return (
    <div className="buddies-dashboard">
      {error && <div className="buddies-error">{error}</div>}
      <BuddyDirectory
        overview={overview.data}
        onOpen={(id) => navigate(`/buddies/${id}`)}
        onNew={() => void openBuddyBuilder()}
        creating={creating}
        notice={<RefreshNotice read={overview} />}
      />
    </div>
  );
}

/** Desktop mount of the shared Buddy page (components/buddies/BuddyPage.tsx). */
function DesktopBuddyPage({ buddyId }: { buddyId: string }) {
  const navigate = useNavigate();
  const openConversation = useCallback((id: string) => navigate(`/chat/${id}`), [navigate]);
  return <BuddyPage buddyId={buddyId} layout="wide" openConversation={openConversation} />;
}

/** `/buddies` is the directory; `/buddies/:buddyId/:tab` one Buddy's page. */
export function BuddiesDashboard() {
  const { buddyId } = useParams();
  return buddyId ? <DesktopBuddyPage key={buddyId} buddyId={buddyId} /> : <Directory />;
}
