import { buddyWrite } from './api';

/**
 * Open a Buddy Builder conversation (POST /api/buddies/builder →
 * `{conversationId}`). `workspaceId` is the slack workspace on screen; the
 * Builder opens in that workspace's directory and hires there. Omit it from
 * the sidebar, which has no current workspace. The caller owns navigation.
 */
export async function createBuddyViaBuilder(workspaceId?: string): Promise<string> {
  const { conversationId } = await buddyWrite(
    'builder.open',
    {},
    workspaceId ? { workspaceId } : {}
  );
  return conversationId;
}
