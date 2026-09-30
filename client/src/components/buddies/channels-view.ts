/**
 * client/src/components/buddies/channels-view.ts
 *
 * Which view a channels URL names, for BOTH shells:
 * /buddies/workspaces/:id/channels?channel=&thread=&post=&task=&dm=&workers=&view=home|threads.
 * Mobile renders it one screen at a time, as Slack does on a phone; desktop picks its main pane
 * from it. (It was mobile's parser alone until the Threads view, while desktop read the same
 * params with its own if-ladder.) Pure: mobile may import it (gate G3). `post` is the reply a permalink names (components/buddies/channel-link.ts);
 * `task` is the Task filter (one Task's posts across every channel), opened
 * from its channel.
 *
 *   D = Home (channel list + Buddies) ⊕ Landing (the workspace Home) ⊕ Threads ⊕ Channel ⊕ Thread ⊕ Task ⊕ DM ⊕ Workers
 *
 * `dm` is a Buddy DM conversation drawn as a thread (493c1c7). It wins over the other params,
 * which stay in the URL so Back (dropping `dm`) returns to the screen the DM was opened from.
 */
export type ChannelsView =
  | { kind: 'home' }
  | { kind: 'landing' }
  | { kind: 'threads' }
  | { kind: 'channel'; channelId: string }
  | { kind: 'thread'; channelId: string; rootId: string; linkedPostId: string | null }
  | { kind: 'task'; channelId: string; taskId: string }
  | { kind: 'dm'; conversationId: string }
  | { kind: 'workers'; buddyId: string };

export function channelsView(search: string): ChannelsView {
  const params = new URLSearchParams(search);
  const channelId = params.get('channel');
  const rootId = params.get('thread');
  const taskId = params.get('task');
  const workers = params.get('workers');
  if (workers) return { kind: 'workers', buddyId: workers };
  const dm = params.get('dm');
  if (dm) return { kind: 'dm', conversationId: dm };
  if (params.get('view') === 'home') return { kind: 'landing' };
  if (params.get('view') === 'threads') return { kind: 'threads' };
  if (channelId && rootId)
    return { kind: 'thread', channelId, rootId, linkedPostId: params.get('post') };
  if (channelId && taskId) return { kind: 'task', channelId, taskId };
  if (channelId) return { kind: 'channel', channelId };
  return { kind: 'home' };
}

export function channelsHref(workspaceId: string, screen: ChannelsView): string {
  const base = `/buddies/workspaces/${encodeURIComponent(workspaceId)}/channels`;
  switch (screen.kind) {
    case 'home':
      return base;
    case 'landing':
      return `${base}?view=home`;
    case 'threads':
      return `${base}?view=threads`;
    case 'channel':
      return `${base}?channel=${encodeURIComponent(screen.channelId)}`;
    case 'thread': {
      const thread = `${base}?channel=${encodeURIComponent(screen.channelId)}&thread=${encodeURIComponent(screen.rootId)}`;
      return screen.linkedPostId === null
        ? thread
        : `${thread}&post=${encodeURIComponent(screen.linkedPostId)}`;
    }
    case 'task':
      return `${base}?channel=${encodeURIComponent(screen.channelId)}&task=${encodeURIComponent(screen.taskId)}`;
    case 'workers':
      return `${base}?workers=${encodeURIComponent(screen.buddyId)}`;
    case 'dm':
      return `${base}?dm=${encodeURIComponent(screen.conversationId)}`;
  }
}
