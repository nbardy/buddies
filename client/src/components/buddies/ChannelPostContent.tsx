import { type CSSProperties, useState } from 'react';
import { recordEmojiUse } from '../../atoms/emoji-usage';
import { invalidateChannelResources } from '../../atoms/resources';
import { ChannelComposer } from './ChannelComposer';
import { ChannelMarkdown } from './ChannelMarkdown';
import { EmojiPicker } from './EmojiPicker';
import { buddyWrite, errorText } from './api';
import { type WorkspaceDirectory, channelPostBody } from './channel-data';
import type { Post } from './types';

const actionStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--sp-1)',
  padding: 'var(--sp-1) var(--sp-3)',
  border: '1px solid var(--border-subtle)',
  borderRadius: '10px',
  background: 'transparent',
  color: 'var(--text-muted)',
  font: 'inherit',
};

// Pattern: one-definition (docs/patterns.md#one-definition)
// Both shells edit/react to the same post; the edit snapshot pins its revision until Save.
export function ChannelPostContent({
  post,
  directory,
}: { post: Post; directory: WorkspaceDirectory }) {
  const [editing, setEditing] = useState<Post | null>(null);
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
        invalidateChannelResources(post.channelId);
      })
      .catch((cause: unknown) => setProblem(errorText(cause)))
      .finally(() => setBusy(false));
  };
  return (
    <>
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
            invalidateChannelResources(post.channelId);
          }}
        />
      ) : (
        <ChannelMarkdown
          body={channelPostBody(post)}
          buddyNames={directory.buddyNames}
          tasks={directory.taskById}
        />
      )}
      {!editing && (
        <div
          className="ui-row"
          style={{
            gap: 'var(--sp-2)',
            flexWrap: 'wrap',
            marginTop: 'var(--sp-2)',
            fontSize: 'var(--fs-3)',
          }}
        >
          {[...reactions].map(([emoji, value]) => (
            <button
              type="button"
              key={emoji}
              style={{
                ...actionStyle,
                color: value.active ? 'var(--text-bright)' : actionStyle.color,
                background: value.active ? 'var(--bg-hover)' : 'transparent',
              }}
              aria-label={`${value.active ? 'Remove' : 'Add'} ${emoji} reaction`}
              aria-pressed={value.active}
              disabled={busy}
              onClick={() => react(emoji, !value.active)}
            >
              {emoji} {value.count}
            </button>
          ))}
          <button
            type="button"
            style={actionStyle}
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
            </svg>{' '}
            +
          </button>
          {post.author.kind === 'owner' && (
            <button
              type="button"
              style={{ ...actionStyle, border: 0 }}
              aria-label="Edit message"
              onClick={() => setEditing(post)}
            >
              Edit
            </button>
          )}
          {post.editedAt && (
            <span className="ui-muted" title={new Date(post.editedAt).toLocaleString()}>
              edited
            </span>
          )}
        </div>
      )}
      {problem && <span role="alert">{problem}</span>}
      {picking && (
        <EmojiPicker onPick={(emoji) => react(emoji, true)} onClose={() => setPicking(false)} />
      )}
    </>
  );
}
