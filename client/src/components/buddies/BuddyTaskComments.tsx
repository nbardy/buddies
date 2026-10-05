import { useState } from 'react';
import { buddyWrite } from './api';
import type { Actor, Post } from './types';
import { ActionError, useBuddyAction } from './useBuddyAction';

/** A post's author as a name: the owner is "You", a Buddy its roster name (or its id). */
export function actorName(actor: Actor, names: Readonly<Record<string, string>>): string {
  switch (actor.kind) {
    case 'owner':
      return 'You';
    case 'buddy':
      return names[actor.id] ?? actor.id;
  }
}

/** Task comments are the task channel's posts, newest first. */
export function BuddyTaskCommentList({
  comments,
  names,
}: {
  comments: readonly Post[];
  names: Readonly<Record<string, string>>;
}) {
  if (comments.length === 0) return <p className="buddy-panel__empty">No comments yet.</p>;
  return (
    <ol className="buddy-post-list">
      {comments.map((comment) => (
        <li key={comment.id}>
          <div className="buddy-post-list__meta">
            <strong>{actorName(comment.author, names)}</strong>
            <time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleString()}</time>
          </div>
          <p className="buddy-post-list__body">{comment.body}</p>
          {comment.evidence.length > 0 && (
            <ul className="buddy-post-list__evidence">
              {comment.evidence.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ol>
  );
}

/** Append a comment: a post in the task's channel. */
export function BuddyTaskCommentForm({
  channelId,
  refresh,
}: {
  channelId: string;
  refresh: () => Promise<void>;
}) {
  const [body, setBody] = useState('');
  const action = useBuddyAction(refresh);
  return (
    <form
      className="buddy-panel__form"
      onSubmit={(event) => {
        event.preventDefault();
        void action
          .run('comment', () =>
            buddyWrite(
              'channel.post',
              { channelId },
              {
                body,
              }
            )
          )
          .then((ok) => ok && setBody(''));
      }}
    >
      <textarea
        aria-label="Comment"
        placeholder="Add a comment for this task"
        rows={3}
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      <button type="submit" disabled={action.busy || !body.trim()}>
        Add comment
      </button>
      <ActionError state={action.state} />
    </form>
  );
}
