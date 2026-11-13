import {
  type CSSProperties,
  type ReactNode,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { recordEmojiUse } from '../../atoms/emoji-usage';
import { invalidateChannelResources } from '../../atoms/resources';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { buddyWrite, errorText } from './api';
import { ChannelComposer } from './ChannelComposer';
import { ChannelMarkdown } from './ChannelMarkdown';
import {
  type ExpeditionCard,
  type WorkspaceDirectory,
  channelPostBody,
  expeditionCardOf,
  threadPageResource,
  wholePostIn,
} from './channel-data';
import { EmojiPicker } from './EmojiPicker';
import { ProposalCard } from './ExpeditionProposal';
import type { ClippedPost, ThreadPage } from './types';
import './ChannelPostContent.css';

// Pattern: fix-guards (docs/patterns.md#fix-guards)
// Edit and the emoji picker live in a floating tool pill (ChannelPostContent.css) that is out of
// flow: an in-flow action row under every post doubled the gap between messages, and
// display:none resized posts on hover. Reaction chips and "edited" stay in flow.
// Guard: tools/check-reaction-layout.mjs checks hover/focus dimensions and touch access.
// Pattern: one-definition (docs/patterns.md#one-definition)
// Both shells edit/react to the same post; the edit snapshot pins its revision until Save.
/** "edited" lives in the post header beside the time, not on a row of its own. */
export function EditedMark({ post }: { post: ClippedPost }) {
  return post.editedAt ? (
    <span className="channel-post-edited ui-muted" title={new Date(post.editedAt).toLocaleString()}>
      · edited
    </span>
  ) : null;
}

// toolsHost: desktop passes the hover toolbar element, so Edit/react render inside it as one
// toolbar (portal; state stays here). Null (phone) keeps the tap pill inside the post.
export function ChannelPostContent({
  post: shown,
  directory,
  toolsHost,
}: {
  post: ClippedPost;
  directory: WorkspaceDirectory;
  toolsHost: HTMLElement | null;
}) {
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
  const tools: ReactNode = (
    // biome-ignore lint/a11y/useSemanticElements: a row of action buttons, not a form; <fieldset> adds form borders and padding.
    <div className="channel-post-tools" role="group" aria-label="Edit or react">
      {post.author.kind === 'owner' && !clipped && (
        <button
          className="ui-inline-row"
          type="button"
          aria-label="Edit message"
          onClick={() => setEditing(post)}
        >
          Edit
        </button>
      )}
      <button
        type="button"
        className="channel-post-add-reaction ui-inline-row"
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
  );
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group of content, not a form control set; <fieldset> brings form borders and padding.
    <div
      className="channel-post-content"
      data-picking={picking || undefined}
      role="group"
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
        <PostBody
          key={`${post.id}:${clipped}`}
          post={post}
          directory={directory}
          initiallyExpanded={asked}
        />
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
      {!editing && reactions.size > 0 && (
        <div className="channel-post-chips ui-row">
          {[...reactions].map(([emoji, value]) => (
            <button
              type="button"
              key={emoji}
              className="channel-post-chip ui-inline-row"
              aria-label={`${value.active ? 'Remove' : 'Add'} ${emoji} reaction`}
              aria-pressed={value.active}
              disabled={busy}
              onClick={() => react(emoji, !value.active)}
            >
              {emoji} {value.count}
            </button>
          ))}
        </div>
      )}
      {!editing && (toolsHost === null ? tools : createPortal(tools, toolsHost))}
      {problem && <span role="alert">{problem}</span>}
      {picking && (
        <EmojiPicker onPick={(emoji) => react(emoji, true)} onClose={() => setPicking(false)} />
      )}
    </div>
  );
}

/** δ: a post's text, or the expedition card a host post carries in place of its plain fallback
 * text (the fallback is for readers without the card: a Buddy reading the thread). */
function PostBody({
  post,
  directory,
  initiallyExpanded,
}: {
  post: ClippedPost;
  directory: WorkspaceDirectory;
  initiallyExpanded: boolean;
}) {
  const card: ExpeditionCard = expeditionCardOf(post);
  switch (card.t) {
    case 'none': {
      const markdown = (
        <ChannelMarkdown
          body={channelPostBody(post)}
          buddyNames={directory.buddyNames}
          tasks={directory.taskById}
        />
      );
      return post.clippedFrom !== undefined ? (
        markdown
      ) : (
        <ExpandableMessage initiallyExpanded={initiallyExpanded}>{markdown}</ExpandableMessage>
      );
    }
    case 'proposal':
      return <ProposalCard proposal={card.proposal} />;
  }
}

const MESSAGE_PREVIEW_HEIGHT = 320;

// Pattern: one-definition (docs/patterns.md#one-definition)
// Channel, thread and Threads-card posts in both shells share this fold. Measure rendered
// height so narrow screens, code blocks and loaded images cannot turn a short string into a wall.
// Guard: tools/check-message-fold.mjs exercises real posts and both toggles in each shell.
function ExpandableMessage({
  children,
  initiallyExpanded,
}: {
  children: ReactNode;
  initiallyExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [long, setLong] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const id = useId();
  useLayoutEffect(() => {
    const element = content.current;
    if (!element) return;
    const measure = () => setLong(element.getBoundingClientRect().height > MESSAGE_PREVIEW_HEIGHT);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <>
      <div
        id={id}
        className="channel-message-preview"
        style={{ maxHeight: expanded ? undefined : MESSAGE_PREVIEW_HEIGHT }}
        onFocusCapture={() => setExpanded(true)}
      >
        <div ref={content} className="channel-message-preview">
          {children}
        </div>
      </div>
      {long && (
        <button
          type="button"
          className="threads-fold channel-message-fold"
          style={{ '--threads-inset': '0px' } as CSSProperties}
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </>
  );
}
