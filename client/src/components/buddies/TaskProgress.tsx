import type { ProjectProgress } from './home-view';
import './TaskProgress.css';

// Pattern: one-definition (docs/patterns.md#one-definition)
export function TaskProgress({ progress }: { progress: ProjectProgress }) {
  switch (progress.kind) {
    case 'none':
      return (
        <div className="task-progress ui-stack">
          <span className="task-progress-label ui-muted">No todos yet</span>
          <span className="task-progress-bar task-progress-bar--dashed" aria-hidden="true" />
        </div>
      );
    case 'no_active':
      return (
        <div className="task-progress ui-stack">
          <span className="task-progress-label ui-muted">No active todos</span>
          <span className="task-progress-bar task-progress-bar--dashed" aria-hidden="true" />
        </div>
      );
    case 'counted': {
      const share = (count: number) => `${(count / progress.total) * 100}%`;
      // The bar's colours are the only status on a card (owner, 2026-10-01); the words live in the
      // accessible value and the tooltip so colour is never the sole carrier.
      const words = [
        `${progress.done} of ${progress.total} todos done`,
        progress.inProgress > 0 ? `${progress.inProgress} in progress` : null,
        progress.blocked > 0 ? `${progress.blocked} blocked` : null,
      ]
        .filter((part) => part !== null)
        .join(', ');
      return (
        <div className="task-progress ui-stack">
          <span className="task-progress-label ui-row">
            <span>
              <strong>
                {progress.done} of {progress.total}
              </strong>{' '}
              · {progress.percent}%
            </span>
          </span>
          {/* Only green is progress; the tinted segments are unfinished work, named in the label. */}
          <span
            className="task-progress-bar"
            role="progressbar"
            tabIndex={0}
            aria-label="Todos done"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.percent}
            aria-valuetext={words}
            title={words}
          >
            <span className="task-progress-bar-done" style={{ width: share(progress.done) }} />
            <span
              className="task-progress-bar-active"
              style={{ width: share(progress.inProgress) }}
            />
            <span
              className="task-progress-bar-blocked"
              style={{ width: share(progress.blocked) }}
            />
          </span>
        </div>
      );
    }
  }
}
