import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSwarmRuntimeSnapshots } from './useSwarmRuntimeSnapshots';
import './InlineSwarmRunWidget.css';

interface InlineSwarmRunWidgetProps {
  workingDirectory: string;
}

export function InlineSwarmRunWidget({ workingDirectory }: InlineSwarmRunWidgetProps) {
  const navigate = useNavigate();
  const snapshots = useSwarmRuntimeSnapshots(useMemo(() => [workingDirectory], [workingDirectory]));

  const snapshot = snapshots[workingDirectory];
  const run = snapshot?.run;

  const handleClick = () => {
    void navigate(`/workers/detail?project=${encodeURIComponent(workingDirectory)}`);
  };

  if (!run) {
    return (
      <button
        type="button"
        className="inline-swarm-run ui-control ui-stack inline-swarm-run--empty"
        onClick={handleClick}
      >
        <div className="inline-swarm-run-content ui-stack">
          <div className="inline-swarm-run-header ui-row">
            <span className="inline-swarm-label">▶️ oompa run</span>
            <div className="inline-swarm-status-container ui-row">
              <span className="inline-swarm-status status-unknown">Initializing...</span>
              <div className="inline-swarm-nav-arrow ui-row ui-muted">→</div>
            </div>
          </div>
        </div>
      </button>
    );
  }

  const isRunning = run.isRunning;
  const workers = run.totalWorkers ?? 0;
  const active = run.activeWorkers ?? 0;
  const done = run.doneWorkers ?? 0;

  return (
    <button
      type="button"
      className={`inline-swarm-run ui-control ui-stack ${isRunning ? 'running' : 'completed'}`}
      onClick={handleClick}
    >
      <div className="inline-swarm-run-content ui-stack">
        <div className="inline-swarm-run-header ui-row">
          <span className="inline-swarm-label">🚀 SWARM RUN</span>
          <span className="inline-swarm-id">{run.swarmId ?? run.runId}</span>
          <div className="inline-swarm-status-container ui-row">
            <span className={`inline-swarm-status status-${isRunning ? 'running' : 'stopped'}`}>
              {isRunning ? 'RUNNING' : 'STOPPED'}
            </span>
            <div className="inline-swarm-nav-arrow ui-row ui-muted">→</div>
          </div>
        </div>
        <div className="inline-swarm-run-stats">
          <div className="swarm-run-stat ui-stack">
            <span className="stat-value">{workers}</span>
            <span className="stat-label">Workers</span>
          </div>
          <div className="swarm-run-stat ui-stack">
            <span className="stat-value stat-success">{active}</span>
            <span className="stat-label">Active</span>
          </div>
          <div className="swarm-run-stat ui-stack">
            <span className="stat-value">{done}</span>
            <span className="stat-label">Done</span>
          </div>
        </div>
      </div>
    </button>
  );
}
