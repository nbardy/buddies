import { DependenciesSchema, type DependencyCheck } from '@unleashd/shared';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
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
  installing: { icon: '…', label: 'Installing automatically…', color: 'var(--warning)' },
  checking: { icon: '…', label: 'Checking…', color: 'var(--warning)' },
};

const SURFACE = {
  text: '#edf3fa',
  muted: '#a4b4c5',
  border: '#304052',
  raised: '#1c2a3a',
};
const buttonStyle: CSSProperties = {
  padding: 'var(--sp-4) var(--sp-6)',
  border: `1px solid ${SURFACE.border}`,
  borderRadius: 'var(--ui-radius)',
  background: SURFACE.raised,
  color: SURFACE.text,
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 'var(--fs-4)',
};

function DependencyCommand({ command, label }: { command: string; label: string }) {
  const copy = useCopyAction(command);
  return (
    <div className="ui-row" style={{ gap: 'var(--sp-3)', marginTop: 'var(--sp-3)' }}>
      <input
        aria-label={label}
        readOnly
        value={command}
        onFocus={(event) => event.currentTarget.select()}
        style={{
          minWidth: 0,
          width: 0,
          flex: 1,
          fontFamily: 'monospace',
          fontSize: 'var(--fs-3)',
          padding: 'var(--sp-4)',
          color: SURFACE.text,
          background: '#0d1722',
          border: `1px solid ${SURFACE.border}`,
          borderRadius: 'var(--ui-radius)',
        }}
      />
      <button
        type="button"
        style={buttonStyle}
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
  const label =
    check.status === 'failed'
      ? check.failure === 'quota'
        ? 'Installed · usage limit'
        : check.failure === 'login'
          ? 'Login required'
          : 'Installed · check failed'
      : state.label;
  return (
    <section
      aria-label={guide.name}
      style={{
        display: 'grid',
        gridTemplateColumns: '28px minmax(0, 1fr)',
        gap: 'var(--sp-6)',
        padding: 'var(--sp-7)',
        border: `1px solid ${SURFACE.border}`,
        borderRadius: 'var(--ui-radius)',
        background: 'linear-gradient(135deg, #1b2939, #172332)',
        boxShadow: '0 2px 8px rgb(0 0 0 / 12%)',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: 'grid',
          placeItems: 'center',
          width: 28,
          height: 28,
          borderRadius: '50%',
          color: state.color,
          background: `color-mix(in srgb, ${state.color} 12%, transparent)`,
          fontWeight: 700,
          fontSize: 'var(--fs-6)',
        }}
      >
        {state.icon}
      </span>
      <div className="ui-stack" style={{ gap: 'var(--sp-2)', minWidth: 0 }}>
        <strong style={{ color: SURFACE.text, fontSize: 'var(--fs-5)', lineHeight: 1.3 }}>
          {guide.name}
        </strong>
        <span style={{ color: state.color, fontSize: 'var(--fs-3)' }}>{label}</span>
        {check.status === 'failed' && (
          <span
            style={{
              color: SURFACE.muted,
              fontSize: 'var(--fs-4)',
              lineHeight: 1.5,
              marginTop: 'var(--sp-2)',
            }}
          >
            {check.failure === 'quota'
              ? 'This response check hit an account limit. Try again later.'
              : check.message}
          </span>
        )}
        {check.status === 'missing' && (
          <>
            <DependencyCommand command={guide.install} label={`Install ${guide.name} command`} />
            {guide.login && (
              <DependencyCommand command={guide.login} label={`Sign in to ${guide.name} command`} />
            )}
          </>
        )}
        {(check.status === 'missing' || check.status === 'failed') && (
          <a
            href={guide.url}
            target="_blank"
            rel="noreferrer"
            style={{ color: '#8bbcff', fontSize: 'var(--fs-3)', marginTop: 'var(--sp-3)' }}
          >
            {check.status === 'missing' ? 'Installation guide' : 'Account & setup help'} ↗
          </a>
        )}
        {check.status === 'failed' &&
          guide.login &&
          check.failure !== 'quota' &&
          check.failure !== 'network' && (
            <DependencyCommand
              command={check.failure === 'login' ? guide.login : check.id}
              label={`${check.failure === 'login' ? 'Sign in to' : 'Open'} ${guide.name} command`}
            />
          )}
      </div>
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
  const checking =
    !status.data ||
    status.data.checks.some(
      (check) => check.status === 'checking' || check.status === 'installing'
    );
  if (dismissed) return null;
  return (
    <dialog
      className="dependencies-dialog"
      ref={dialog}
      aria-labelledby="dependencies-title"
      onCancel={() => setDismissed(true)}
      style={{
        margin: 'auto',
        width: 'min(420px, calc(100vw - var(--sp-9)))',
        maxWidth: 'none',
        padding: 0,
        overflow: 'hidden',
        border: `1px solid ${SURFACE.border}`,
        borderRadius: 'var(--sp-6)',
        background: 'linear-gradient(145deg, #202e3e, #101a26)',
        color: SURFACE.text,
        boxShadow: '0 32px 90px rgb(0 0 0 / 65%), inset 0 1px 0 rgb(255 255 255 / 6%)',
      }}
    >
      <div className="ui-stack" style={{ maxHeight: '85dvh' }}>
        <header style={{ padding: 'var(--sp-9) var(--sp-9) var(--sp-7)', flexShrink: 0 }}>
          <div className="ui-row" style={{ justifyContent: 'space-between' }}>
            <h2
              id="dependencies-title"
              style={{
                fontSize: 'var(--fs-8)',
                letterSpacing: '-0.025em',
                color: SURFACE.text,
                margin: 0,
              }}
            >
              Setup
            </h2>
            <button
              type="button"
              aria-label="Close dependency checks"
              onClick={() => setDismissed(true)}
              style={{
                ...buttonStyle,
                padding: 'var(--sp-2) var(--sp-4)',
                border: 'none',
                background: 'transparent',
                color: SURFACE.muted,
              }}
            >
              ✕
            </button>
          </div>
        </header>
        <div
          aria-live="polite"
          className="ui-stack"
          style={{
            gap: 'var(--sp-4)',
            padding: '0 var(--sp-9) var(--sp-9)',
            overflowY: 'auto',
            minHeight: 0,
          }}
        >
          {status.data?.checks.map((check) => <DependencyCard key={check.id} check={check} />) ?? (
            <p>Checking dependencies…</p>
          )}
          {(status.kind === 'failed' || status.kind === 'stale') && (
            <p>Could not load checks: {status.error.message}</p>
          )}
          {error && <p role="alert">{error}</p>}
        </div>
        <footer
          style={{
            padding: 'var(--sp-7) var(--sp-9)',
            borderTop: `1px solid ${SURFACE.border}`,
            background: 'rgb(0 0 0 / 14%)',
            flexShrink: 0,
          }}
        >
          <div className="ui-row" style={{ gap: 'var(--sp-4)', justifyContent: 'space-between' }}>
            <button
              type="button"
              style={buttonStyle}
              disabled={retrying || (checking && !!status.data)}
              onClick={() => void retry()}
            >
              ↻ Check again
            </button>
            <button
              type="button"
              style={{
                ...buttonStyle,
                background: '#a9c6ff',
                color: '#102039',
                borderColor: '#a9c6ff',
                fontWeight: 600,
              }}
              onClick={() => setDismissed(true)}
            >
              Continue →
            </button>
          </div>
          <p
            style={{
              color: SURFACE.muted,
              fontSize: 'var(--fs-2)',
              lineHeight: 1.4,
              margin: 'var(--sp-6) 0 0',
            }}
          >
            Response checks use a little agent quota. You can continue while resolving a check.
          </p>
        </footer>
      </div>
    </dialog>
  );
}
