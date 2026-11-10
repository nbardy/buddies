import { Link } from 'react-router-dom';
import { BuddyTaskPanel } from './BuddyWork';
import type { ChannelTask } from './channel-text';
import { ModalDialog } from './ModalDialog';
import { taskStatusView } from './ui-contract';

// A Task ref stays in Channels (493c1c7): the chip's hover card is the one-line preview, and a
// click opens the Task itself over the transcript — criteria, todos, runs, comments — instead of
// leaving for the owner's Work tab. "Open in Work" is still one click away.
export function ChannelTaskOverlay({
  task,
  names,
  onClose,
}: {
  task: ChannelTask;
  names: Readonly<Record<string, string>>;
  onClose(): void;
}) {
  const status = taskStatusView(task.status);
  return (
    <ModalDialog
      className="channel-task-overlay ui-card ui-stack"
      label={task.title}
      onClose={onClose}
    >
      <header className="channel-task-overlay-header ui-row">
        <strong>{task.title}</strong>
        <span className="ui-muted">
          {status.glyph} {status.label} · {task.ownerName}
        </span>
        <Link to={`/buddies/${encodeURIComponent(task.ownerId)}/work`}>Open in Work</Link>
        <button type="button" onClick={onClose} aria-label="Close task" title="Close task">
          ✕
        </button>
      </header>
      <BuddyTaskPanel taskId={task.id} names={names} />
    </ModalDialog>
  );
}
