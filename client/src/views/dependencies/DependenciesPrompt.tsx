import { DependenciesSchema } from '@unleashd/shared';
import { useEffect, useRef, useState } from 'react';
import { resource, usePolledFetch } from '../../hooks/usePolledFetch';

const STATUS = resource('/api/dependencies', async (signal) => {
  const response = await fetch('/api/dependencies', { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return DependenciesSchema.parse(await response.json());
});

// Pattern: one-write-path (docs/patterns.md#one-write-path)
// One app-wide prompt, shared by both shells. Server checks are cached, so
// opening another tab or polling status never launches another agent probe.
export function DependenciesPrompt() {
  const [dismissed, setDismissed] = useState(false);
  const status = usePolledFetch(STATUS, 2_000, !dismissed);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!dismissed) dialog.current?.showModal();
  }, [dismissed]);

  const retry = async () => {
    setRetrying(true);
    setError(null);
    try {
      const response = await fetch('/api/dependencies/check', { method: 'POST' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      await status.refetch();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRetrying(false);
    }
  };
  const checking = !status.data || status.data.checks.some((check) => check.status === 'checking');
  if (dismissed) return null;
  return (
    <dialog
      ref={dialog}
      className="ui-sheet"
      aria-labelledby="dependencies-title"
      onCancel={() => setDismissed(true)}
    >
      <div className="ui-sheet__inner ui-stack">
        <h2 id="dependencies-title" className="ui-sheet__title">
          Dependencies
        </h2>
        <p>Checking which agents can respond on this computer.</p>
        <p className="ui-muted">Each check asks for a short reply and uses a little agent quota.</p>
        <div aria-live="polite" className="ui-stack" style={{ gap: 'var(--sp-4)' }}>
          {status.data?.checks.map((check) => (
            <div key={check.id} className="ui-card ui-stack" style={{ padding: 'var(--sp-4)' }}>
              <strong>
                {check.id === 'rust'
                  ? 'Rust / Cargo'
                  : check.id === 'claude'
                    ? 'Claude Code'
                    : 'Codex'}{' '}
                — {check.status}
              </strong>
              <span>{check.message}</span>
            </div>
          )) ?? <p>Checking dependencies…</p>}
          {(status.kind === 'failed' || status.kind === 'stale') && (
            <p>Could not load checks: {status.error.message}</p>
          )}
          {error && <p role="alert">{error}</p>}
        </div>
        <div className="ui-row" style={{ gap: 'var(--sp-4)' }}>
          <button
            type="button"
            className="ui-choice"
            disabled={retrying || (checking && !!status.data)}
            onClick={() => void retry()}
          >
            Check again
          </button>
          <button type="button" className="ui-choice" onClick={() => setDismissed(true)}>
            Continue
          </button>
        </div>
      </div>
    </dialog>
  );
}
