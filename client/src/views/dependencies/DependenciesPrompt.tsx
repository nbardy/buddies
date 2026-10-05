import { DependenciesSchema, type DependencyCheck } from '@unleashd/shared';
import { useAtomValue } from 'jotai';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { setSetupDismissed, setupDismissedAtom } from '../../atoms/ui';
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
  failed: { icon: '✕', label: 'Installed — needs attention', color: '#ff9b94' },
  installing: { icon: '…', label: 'Installing automatically…', color: 'var(--warning)' },
  checking: { icon: '…', label: 'Checking…', color: 'var(--warning)' },
};

const SURFACE = {
  text: '#f2f4f8',
  muted: '#9da8b5',
  border: '#ffffff14',
};
const buttonStyle: CSSProperties = {
  padding: 'var(--sp-6) var(--sp-7)',
  border: 'none',
  borderRadius: 0,
  background: 'transparent',
  color: SURFACE.text,
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 'var(--fs-4)',
};

function DependencyCommand({ command, label }: { command: string; label: string }) {
  const copy = useCopyAction(command);
  return (
    <div
      className="ui-row"
      style={{
        gap: 'var(--sp-4)',
        marginTop: 'var(--sp-6)',
        borderBottom: `1px solid ${SURFACE.border}`,
        background: '#ffffff04',
      }}
    >
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
          background: 'transparent',
          border: 'none',
          borderRadius: 0,
        }}
      />
      <button
        type="button"
        style={{ ...buttonStyle, color: '#a6c7ff', fontSize: 'var(--fs-3)' }}
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
        padding: 'var(--sp-8) 0',
        borderTop: `1px solid ${SURFACE.border}`,
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
        <div
          className="ui-row"
          style={{ justifyContent: 'space-between', gap: 'var(--sp-4)', flexWrap: 'wrap' }}
        >
          <strong
            style={{
              color: SURFACE.text,
              fontSize: 'var(--fs-6)',
              lineHeight: 1.5,
              fontWeight: 500,
            }}
          >
            {guide.name}
          </strong>
          <span style={{ color: state.color, fontSize: 'var(--fs-2)', lineHeight: 1.5 }}>
            {label}
          </span>
        </div>
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
        {check.status === 'failed' &&
          guide.login &&
          check.failure !== 'quota' &&
          check.failure !== 'network' && (
            <DependencyCommand
              command={check.failure === 'login' ? guide.login : check.id}
              label={`${check.failure === 'login' ? 'Sign in to' : 'Open'} ${guide.name} command`}
            />
          )}
        {(check.status === 'missing' || check.status === 'failed') && (
          <a
            href={guide.url}
            target="_blank"
            rel="noreferrer"
            style={{
              color: '#8bbcff',
              fontSize: 'var(--fs-3)',
              marginTop: 'var(--sp-5)',
              textDecoration: 'none',
            }}
          >
            {check.status === 'missing'
              ? 'Installation guide'
              : check.failure === 'login'
                ? 'How to sign in'
                : 'Account help'}{' '}
            ↗
          </a>
        )}
      </div>
    </section>
  );
}

// Pattern: one-write-path (docs/patterns.md#one-write-path)
// One app-wide prompt, shared by both shells. Polling reads the server's cached checks.
export function DependenciesPrompt() {
  const dismissed = useAtomValue(setupDismissedAtom);
  const status = usePolledFetch(STATUS, 2_000, !dismissed);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!dismissed) {
      dialog.current?.showModal();
      dialog.current?.focus();
    }
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
      tabIndex={-1}
      aria-labelledby="dependencies-title"
      onCancel={() => setSetupDismissed(true)}
      style={{
        margin: 'auto',
        width: 'min(420px, calc(100vw - var(--sp-9)))',
        maxWidth: 'none',
        padding: 0,
        overflow: 'hidden',
        border: 'none',
        borderRadius: 0,
        background: '#141b24',
        borderTop: '2px solid #a6c7ff',
        outline: 'none',
        color: SURFACE.text,
        boxShadow: '0 24px 80px rgb(0 0 0 / 35%)',
      }}
    >
      <div className="ui-stack" style={{ maxHeight: '85dvh' }}>
        <header style={{ padding: 'var(--sp-10) var(--sp-9) var(--sp-9)', flexShrink: 0 }}>
          <div className="ui-row" style={{ justifyContent: 'space-between' }}>
            <h2
              id="dependencies-title"
              style={{
                fontSize: 'var(--fs-9)',
                fontWeight: 500,
                letterSpacing: '-0.04em',
                color: SURFACE.text,
                margin: 0,
              }}
            >
              Setup
            </h2>
            <button
              type="button"
              aria-label="Close dependency checks"
              onClick={() => setSetupDismissed(true)}
              style={{
                ...buttonStyle,
                padding: 'var(--sp-4)',
                fontSize: 'var(--fs-7)',
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
            gap: 0,
            padding: '0 var(--sp-9)',
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
            margin: '0 var(--sp-9)',
            padding: 'var(--sp-8) 0',
            borderTop: `1px solid ${SURFACE.border}`,
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
                background: '#d9e7ff',
                color: '#162034',
                padding: 'var(--sp-6) var(--sp-9)',
                fontWeight: 600,
              }}
              onClick={() => setSetupDismissed(true)}
            >
              Continue →
            </button>
          </div>
        </footer>
      </div>
    </dialog>
  );
}
