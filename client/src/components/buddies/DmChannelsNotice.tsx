import { useAtomValue } from 'jotai';
import { Link, useNavigate } from 'react-router-dom';
import { detailOf, transcriptFamily } from '../../atoms/conversations';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import type { BuddyRowKind } from '../../utils/conversation-row';
import { type DirectChain, directChainUrl, startNewDirectChat } from './ChannelDm';
import { channelLinkPath } from './channel-link';
import { HarnessPicker } from './HarnessPicker';

/**
 * A Buddy DM opened on the conversation page (a sidebar row, a link, an eye). Until 493c1c7 the
 * `/chat` page stitched a DM's generations itself and redirected an earlier one to the latest.
 * DMs now live in Channels, where ChannelDm already stitches them and owns New chat, so this page
 * points there instead of drawing a second joined view: "Open in Channels" lands on the latest
 * generation, and New chat starts the next one and opens it there. Nothing renders for a Buddy
 * conversation that is not a DM generation (a seat, a Wake, a background run).
 */
export function DmChannelsNotice({
  conversationId,
  buddy,
  className,
}: {
  conversationId: string;
  buddy: BuddyRowKind;
  className: string;
}) {
  const navigate = useNavigate();
  const seed = detailOf(useAtomValue(transcriptFamily(conversationId)))?.config.config ?? null;
  const chain = usePolledFetch<DirectChain>(directChainUrl(buddy.buddyId), 15_000);
  const generations = chain.data?.generations ?? [];
  if (!generations.includes(conversationId)) return null;
  const dmPath = (id: string) =>
    channelLinkPath(buddy.workspaceId, { kind: 'dm', conversationId: id });
  const latest = generations.at(-1) ?? conversationId;
  return (
    <div className={className} role="note">
      <Link className="channel-inline-action" to={dmPath(latest)}>
        Open DM
      </Link>
      <HarnessPicker
        label="Refresh context"
        note="Start a fresh chat to save token cost. Saved Buddy memories carry forward; this chat remains above it in Channels."
        confirm="Refresh context"
        seed={seed}
        excluded={null}
        buddy
        onConfirm={(config) =>
          startNewDirectChat(buddy.buddyId, { config }).then((next) => navigate(dmPath(next)))
        }
        placement="below"
      />
    </div>
  );
}
