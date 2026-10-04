import { DependenciesSchema, type DependencyCheck } from '@unleashd/shared';
import { useEffect, useRef, useState } from 'react';
import { COPY_LABEL, useCopyAction } from '../../hooks/useCopyAction';
import { resource, usePolledFetch } from '../../hooks/usePolledFetch';

const STATUS = resource('/api/dependencies', async (signal) => {
  const response = await fetch('/api/dependencies', { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return DependenciesSchema.parse(await response.json());
});

// Pattern: table-driven (docs/patterns.md#table-driven)
const GUIDES = {
  rust: {
    name: 'Rust / Cargo',
    url: 'https://rustup.rs/',
    install: 'brew install rust',
    login: null,
  },
  claude: {
    name: 'Claude Code',
    url: 'https://code.claude.com/docs/en/quickstart',
    install: 'curl -fsSL https://claude.ai/install.sh | bash',
    login: 'claude auth login',
  },
  codex: {
    name: 'Codex',
    url: 'https://developers.openai.com/codex/cli/',
    install: 'npm install -g @openai/codex',
    login: 'codex login',
  },
};
const STATES = {
  ready: { icon: '✓', label: 'Yes — ready', color: '#22c55e' },
  missing: { icon: '✕', label: 'No — not installed', color: 'var(--danger)' },
  failed: { icon: '✕', label: 'Installed — needs attention', color: 'var(--danger)' },
  checking: { icon: '…', label: 'Checking…', color: 'var(--warning)' },
};

function DependencyCommand({ command, label }: { command: string; label: string }) {
  const copy = useCopyAction(command);
  return (
    <div className="ui-row" style={{ gap: 'var(--sp-3)' }}>
      <input
        aria-label={label}
        readOnly
        value={command}
        onFocus={(event) => event.currentTarget.select()}
        style={{
          minWidth: 0,
          flex: 1,
          fontFamily: 'monospace',
          padding: 'var(--sp-3)',
          color: 'var(--text-primary)',
          background: 'var(--bg-raised-2)',
          border: '1px solid var(--border-default)',
        }}
      />
      <button
        type="button"
        className="ui-choice"
        onClick={copy.copy}
        aria-label={`${COPY_LABEL[copy.state]} ${label}`}
      >
        {COPY_LABEL[copy.state]}
      </button>
    </div>
  );
}

export function DependencyCard({ check }: { check: DependencyCheck }) {
  const guide = GUIDES[check.id];
  const state = STATES[check.status];
  return (
    <section
      className="ui-card ui-stack"
      style={{ padding: 'var(--sp-5)', gap: 'var(--sp-3)' }}
      aria-label={guide.name}
    >
      <div
        className="ui-row"
        style={{ gap: 'var(--sp-3)', justifyContent: 'space-between', flexWrap: 'wrap' }}
      >
        <strong>{guide.name}</strong>
        <strong style={{ color: state.color }}>
          <span aria-hidden="true">{state.icon} </span>
          {state.label}
        </strong>
      </div>
      <span>{check.message}</span>
      {check.status === 'missing' && (
        <>
          <DependencyCommand command={guide.install} label={`Install ${guide.name} command`} />
          <a href={guide.url} target="_blank" rel="noreferrer">
            Install {guide.name} — official guide ↗
          </a>
          {check.id === 'rust' && (
            <span className="ui-muted">
              No Homebrew? The Rust guide includes the rustup installer.
            </span>
          )}
          {guide.login && (
            <DependencyCommand command={guide.login} label={`Sign in to ${guide.name} command`} />
          )}
        </>
      )}
      {check.status === 'failed' && guide.login && (
        <>
          {check.failure !== 'quota' && check.failure !== 'network' && (
            <DependencyCommand
              command={check.failure === 'login' ? guide.login : check.id}
              label={`${check.failure === 'login' ? 'Sign in to' : 'Open'} ${guide.name} command`}
            />
          )}
          <a href={guide.url} target="_blank" rel="noreferrer">
            {guide.name} setup and sign-in help ↗
          </a>
        </>
      )}
    </section>
  );
}

// Pattern: one-write-path (docs/patterns.md#one-write-path)
// One app-wide prompt, shared by both shells. Polling reads the server's cached checks.
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
      style={{
        margin: 'auto',
        width: 'calc(100% - var(--sp-8))',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--ui-radius)',
      }}
      aria-labelledby="dependencies-title"
      onCancel={() => setDismissed(true)}
    >
      <div className="ui-sheet__inner ui-stack">
        <h2 id="dependencies-title" className="ui-sheet__title">
          Dependencies
        </h2>
        <p>Checked on the computer running Unleashd.</p>
        <div aria-live="polite" className="ui-stack" style={{ gap: 'var(--sp-4)' }}>
          {status.data?.checks.map((check) => <DependencyCard key={check.id} check={check} />) ?? (
            <p>Checking dependencies…</p>
          )}
          {(status.kind === 'failed' || status.kind === 'stale') && (
            <p>Could not load checks: {status.error.message}</p>
          )}
          {error && <p role="alert">{error}</p>}
        </div>
        <p className="ui-muted">
          You can continue using Unleashd. After resolving any checks above, click Check again.
          Response checks use a little agent quota.
        </p>
        <div className="ui-row" style={{ gap: 'var(--sp-4)', justifyContent: 'flex-end' }}>
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
