import { useAtomValue } from 'jotai';
import { useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { listField } from '../../atoms/conversations';
import { mobileConversationRouteState } from '../../utils/conversation-route-state';
import { ConversationRow } from '../../views/conversation-row/ConversationRow';
import { MobileEmptyPanel, MobileHeaderAction, MobilePage } from '../components/MobileUI';
import { NewConversationSheet } from '../components/NewConversationSheet';

export function ConversationListMobile({ scope = 'all' }: { scope?: 'all' | 'chats' }) {
  const order = useAtomValue(listField('order'));
  const chatInbox = useAtomValue(listField('inbox'));
  const ids = scope === 'chats' ? chatInbox.ids : order;
  const location = useLocation();
  const routeState = useMemo(() => mobileConversationRouteState(location), [location]);
  const [showCreate, setShowCreate] = useState(false);

  const list =
    ids.length === 0 ? (
      <MobileEmptyPanel>
        No conversations yet. Tap <strong>+ New</strong> to start one.
      </MobileEmptyPanel>
    ) : (
      <div className="mobile-ui-stack">
        {ids.map((id) => (
          <ConversationRow variant="list" key={id} id={id} routeState={routeState} />
        ))}
      </div>
    );

  if (scope !== 'chats') return <div className="mobile-ui-page">{list}</div>;

  const subtitle =
    chatInbox.total > ids.length
      ? `${ids.length} most recent · ${chatInbox.total} total`
      : `${chatInbox.total} ${chatInbox.total === 1 ? 'conversation' : 'conversations'}`;

  return (
    <>
      <MobilePage
        title="Chats"
        subtitle={subtitle}
        className="mobile-chats"
        headerAside={
          <MobileHeaderAction onClick={() => setShowCreate(true)} aria-label="New conversation">
            + New
          </MobileHeaderAction>
        }
      >
        {list}
      </MobilePage>
      {showCreate && <NewConversationSheet kind="chat" onClose={() => setShowCreate(false)} />}
    </>
  );
}
