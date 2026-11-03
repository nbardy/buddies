import { channelsView } from '../../components/buddies/channels-view';

const CHANNELS_PATH = /^\/buddies\/workspaces\/[^/]+\/channels\/?$/;

/**
 * Inside a channel or thread the screen is a full-height pane with its
 * composer pinned to the bottom and no tab bar — Slack's conversation screen.
 * Home and Threads keep the tab bar and scroll as a page.
 */
export function isImmersiveChannelRoute(pathname: string, search: string): boolean {
  if (!CHANNELS_PATH.test(pathname)) return false;
  const kind = channelsView(search).kind;
  return kind !== 'home' && kind !== 'landing' && kind !== 'threads';
}
