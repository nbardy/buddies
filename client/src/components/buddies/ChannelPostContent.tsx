import { useState } from 'react';
import { recordEmojiUse } from '../../atoms/emoji-usage';
import { invalidateChannelResources } from '../../atoms/resources';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { ChannelComposer } from './ChannelComposer';
import { ChannelMarkdown } from './ChannelMarkdown';
import { EmojiPicker } from './EmojiPicker';
import { ExpeditionCard as ExpeditionCardView } from './ExpeditionCard';
import { buddyWrite, errorText } from './api';
import {
  type ExpeditionCard,
  type WorkspaceDirectory,
  channelPostBody,
  expeditionCardOf,
  threadPageResource,
  wholePostIn,
} from './channel-data';
import type { ClippedPost, ThreadPage } from './types';
import './ChannelPostContent.css';

// Pattern: fix-guards (docs/patterns.md#fix-guards)
// Edit and the emoji picker live in a floating tool pill (ChannelPostContent.css) that is out of
// flow: an in-flow action row under every post doubled the gap between messages, and
// display:none resized posts on hover. Reaction chips and "edited" stay in flow.
// Guard: tools/check-reaction-layout.mjs checks hover/focus dimensions and touch access.
// Pattern: one-definition (docs/patterns.md#one-definition)
// Both shells edit/react to the same post; the edit snapshot pins its revision until Save.
export function ChannelPostContent({
  post: shown,
  directory,
}: { post: ClippedPost; directory: WorkspaceDirectory }) {
  // A Threads card may hold only a preview (server routes.ts clipFollowedThreads). "Show full
  // message" swaps in the whole copy from the thread resource. Fix-guard: Edit is hidden on a
  // preview, or Save would overwrite the post with its clipped text.
  const [asked, setAsked] = useState(false);
  const thread = usePolledFetch<ThreadPage>(
    asked && shown.clippedFrom !== undefined ? threadPageResource(shown.rootId ?? shown.id) : null,
    0
  );
  const whole = thread.data === null ? null : wholePostIn(thread.data, shown.id);
  const post: ClippedPost = whole ?? shown;
  const clipped = post.clippedFrom !== undefined;
  const [editing, setEditing] = useState<ClippedPost | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const reactions = new Map<string, { count: number; active: boolean }>();
  for (const reaction of post.reactions ?? []) {
    const entry = reactions.get(reaction.emoji) ?? { count: 0, active: false };
    entry.count++;
    entry.active ||= reaction.actorKey === 'owner';
    reactions.set(reaction.emoji, entry);
  }
  const react = (emoji: string, active: boolean) => {
    if (busy) return;
    setBusy(true);
    setPicking(false);
    setProblem(null);
    void buddyWrite('post.react', { postId: post.id }, { emoji, active })
      .then(() => {
        if (active) recordEmojiUse(emoji);
        invalidateChannelResources(post.channelId, [post.rootId ?? post.id]);
      })
      .catch((cause: unknown) => setProblem(errorText(cause)))
      .finally(() => setBusy(false));
  };
  return (
    <div
      className="channel-post-content"
      data-picking={picking || undefined}
      aria-label="Message content and actions"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: Focus reveals message actions for keyboard and touch users.
      tabIndex={0}
    >
      {editing ? (
        <ChannelComposer
          channelId={post.channelId}
          rootId={post.rootId ?? null}
          placeholder="Edit message…"
          references={directory.references}
          submit="button"
          autoFocus
          editPost={editing}
          onCancel={() => setEditing(null)}
          onPosted={() => {
            setEditing(null);
            invalidateChannelResources(post.channelId, [post.rootId ?? post.id]);
          }}
        />
      ) : (
        <PostBody post={post} directory={directory} />
      )}
      {clipped && !editing && (
        <button
          type="button"
          className="threads-fold"
          disabled={thread.kind === 'loading'}
          onClick={() => setAsked(true)}
        >
          {thread.kind === 'failed'
            ? 'Could not load: retry'
            : thread.data !== null
              ? 'Longer than the latest page: open the thread to read it'
              : `Show full message (${post.clippedFrom} characters)`}
        </button>
      )}
      {!editing && (reactions.size > 0 || post.editedAt) && (
        <div className="channel-post-chips ui-row">
          {[...reactions].map(([emoji, value]) => (
            <button
              type="button"
              key={emoji}
              className="channel-post-chip"
              aria-label={`${value.active ? 'Remove' : 'Add'} ${emoji} reaction`}
              aria-pressed={value.active}
              disabled={busy}
              onClick={() => react(emoji, !value.active)}
            >
              {emoji} {value.count}
            </button>
          ))}
          {post.editedAt && (
            <span className="ui-muted" title={new Date(post.editedAt).toLocaleString()}>
              edited
            </span>
          )}
        </div>
      )}
      {!editing && (
        <div className="channel-post-tools" role="toolbar" aria-label="Edit or react">
          {post.author.kind === 'owner' && !clipped && (
            <button type="button" aria-label="Edit message" onClick={() => setEditing(post)}>
              Edit
            </button>
          )}
          <button
            type="button"
            className="channel-post-add-reaction"
            aria-label="Add emoji reaction"
            title="Add emoji reaction"
            disabled={busy}
            onClick={() => setPicking(true)}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              aria-hidden="true"
            >
              <circle cx="8" cy="8" r="6" />
              <path d="M5 9.5Q8 12 11 9.5" />
              <circle cx="6" cy="6" r=".5" />
              <circle cx="10" cy="6" r=".5" />
            </svg>
          </button>
        </div>
      )}
      {problem && <span role="alert">{problem}</span>}
      {picking && (
        <EmojiPicker onPick={(emoji) => react(emoji, true)} onClose={() => setPicking(false)} />
      )}
    </div>
  );
}

/** δ: a post's text, or the expedition card a host post carries in place of its plain fallback
 * text (the fallback is for readers without the card: a Buddy reading the thread). */
function PostBody({ post, directory }: { post: ClippedPost; directory: WorkspaceDirectory }) {
  const card: ExpeditionCard = expeditionCardOf(post);
  switch (card.t) {
    case 'none':
      return (
        <ChannelMarkdown
          body={channelPostBody(post)}
          buddyNames={directory.buddyNames}
          tasks={directory.taskById}
        />
      );
    case 'card':
      return <ExpeditionCardView id={card.id} />;
  }
}
