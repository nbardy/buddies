import { setConversationDone } from '../../atoms/actions';
import { ActionTooltip } from './ActionTooltip';
import { BuddyBackgroundLink } from './BuddyBackgroundLink';
import { BuddySigil } from './BuddySigil';
import type { OpenDm } from './ChannelAuthor';
import { BuddyStar } from './ChannelStar';
import { HighlightRow } from './HighlightRow';
import { WakeIcon, WakeIndicator } from './WakeIndicator';
import { useBuddyDirectActions } from './buddy-direct-actions';
import type { Buddy } from './types';

// One Buddy in the desktop channels rail. Like Slack (and the mobile Buddies
// home), the name opens the DM — the ongoing owner chat, history kept; on
// hover, Wake asks the Buddy to catch up on the channels inside that DM.
// The DM opens inside the channels view (`openDm`), and its row is marked
// current while it is open, like a selected channel.
export function BuddyRailRow({
  member,
  openDm,
  current,
  workspaceId,
}: {
  member: Pick<Buddy, 'id' | 'name' | 'role'>;
  openDm: OpenDm;
  current: boolean;
  workspaceId: string;
}) {
  const direct = useBuddyDirectActions(member.id);
  const { action } = direct;
  return (
    <HighlightRow
      current={current}
      buttonsRight={
        <>
          <span className="channel-browser-buddy-actions">
            <ActionTooltip text={`Wake up ${member.name}: catch up on the channels and act`}>
              <button
                type="button"
                aria-label={`Wake ${member.name}`}
                disabled={action.kind === 'pending'}
                onClick={direct.wake}
              >
                <WakeIcon />
              </button>
            </ActionTooltip>
            {direct.woken && (
              <WakeIndicator
                key={direct.woken.attempt}
                conversationId={direct.woken.conversationId}
                name={member.name}
                className="channel-browser-buddy-status ui-inline-row ui-muted"
                doneClassName="channel-browser-buddy-done"
              />
            )}
          </span>
          <BuddyStar buddyId={member.id} name={member.name} />
          <BuddyBackgroundLink buddyId={member.id} workspaceId={workspaceId} name={member.name} />
        </>
      }
      footer={
        action.kind === 'failed' && (
          <span className="channel-browser-buddy-error" role="alert">
            {action.message}
          </span>
        )
      }
      className="channel-browser-buddy"
      data-worker-row="desktop"
      data-failed={action.kind === 'failed' || undefined}
    >
      <button
        type="button"
        className="channel-browser-buddy-link"
        aria-label={`Message ${member.name}`}
        title={action.kind === 'failed' ? action.message : member.role}
        aria-current={current ? 'page' : undefined}
        disabled={action.kind === 'pending'}
        onClick={() => direct.openDm(openDm)}
      >
        <BuddySigil className="channel-browser-buddy-sigil" name={member.name} />
        <span className="channel-browser-channel-name ui-truncate">{member.name}</span>
      </button>
    </HighlightRow>
  );
}

const CREATING = 'Creating buddy';

// The Buddy Builder chat in progress, above the Buddies it will add: opens in the DM pane; on
// hover, × archives the setup chat (marks it done).
export function CreatingBuddyRailRow({
  conversationId,
  openDm,
  current,
}: {
  conversationId: string;
  openDm: OpenDm;
  current: boolean;
}) {
  return (
    <HighlightRow
      className="channel-browser-buddy"
      current={current}
      buttonsRight={
        <span className="channel-browser-buddy-actions">
          <button
            type="button"
            title="Archive this setup chat"
            aria-label="Archive Buddy setup"
            onClick={() => setConversationDone(conversationId, true)}
          >
            ×
          </button>
        </span>
      }
    >
      <button
        type="button"
        className="channel-browser-buddy-link"
        aria-label={`Continue ${CREATING}`}
        aria-current={current ? 'page' : undefined}
        onClick={() => openDm(conversationId)}
      >
        <BuddySigil className="channel-browser-buddy-sigil" name={CREATING} />
        <em className="channel-browser-channel-name ui-truncate ui-muted">{CREATING}</em>
      </button>
    </HighlightRow>
  );
}
