import { DependenciesSchema, type DependencyCheck } from '@unleashd/shared';
import { useAtomValue } from 'jotai';
import { type ReactNode, Suspense, lazy, useEffect, useRef, useState } from 'react';
import { setSetupDismissed, setupDismissedAtom, setupRevealAtom } from '../../atoms/ui';
import { resource, usePolledFetch } from '../../hooks/usePolledFetch';
import { DependencyCommand, SURFACE, buttonStyle } from './setup-ui';
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/plus-jakarta-sans/wght.css';

const WorkspaceTeamForm = lazy(() =>
  import('../../components/buddies/WorkspaceTeamForm').then((module) => ({
    default: module.WorkspaceTeamForm,
  }))
);

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

const STEPS = ['welcome', 'setup', 'team'] as const;
type Step = (typeof STEPS)[number];
const STEP_TITLE: Record<Step, string> = {
  welcome: 'Welcome',
  setup: 'Setup',
  team: 'Create your team',
};

const STEP_PILL: Record<Step, string> = { welcome: 'Welcome', setup: 'Setup', team: 'Team' };

// Pattern: one-write-path (docs/patterns.md#one-write-path)
// One app-wide prompt, shared by both shells. Polling reads the server's cached checks.
// `children`: device-specific sections after the checks (desktop: Connect from mobile).
export function DependenciesPrompt({ children }: { children?: ReactNode }) {
  const dismissed = useAtomValue(setupDismissedAtom);
  const status = usePolledFetch(STATUS, 2_000, !dismissed);
  const reveal = useAtomValue(setupRevealAtom);
  const [step, setStep] = useState<Step>('welcome');
  // Fix guard: "Connect mobile" opened the wizard on Welcome, where its section is not
  // mounted, so the reveal never ran and fired later on an unrelated visit to Setup.
  // Every revealable section lives on the Setup step. Guard: dependencies-layout test.
  if (reveal !== null && step !== 'setup') setStep('setup');
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
      className="dependencies-dialog onboarding-card"
      ref={dialog}
      tabIndex={-1}
      aria-labelledby="dependencies-title"
      onCancel={() => setSetupDismissed(true)}
      style={{
        margin: 'auto',
        width: 'min(560px, calc(100vw - var(--sp-9)))',
        maxWidth: 'none',
        padding: 0,
        overflow: 'hidden',
        outline: 'none',
        color: SURFACE.text,
      }}
    >
      <div className="ui-stack" style={{ maxHeight: '85dvh' }}>
        <header style={{ padding: 'var(--sp-10) var(--sp-10) var(--sp-7)', flexShrink: 0 }}>
          <div className="ui-row" style={{ justifyContent: 'space-between' }}>
            <h2 id="dependencies-title">{STEP_TITLE[step]}</h2>
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
            padding: '0 var(--sp-10)',
            overflowY: 'auto',
            minHeight: 0,
          }}
        >
          <ol className="onboarding-steps">
            {STEPS.map((name, index) => (
              <li key={name} aria-current={name === step ? 'step' : undefined}>
                {index + 1}. {STEP_PILL[name]}
              </li>
            ))}
          </ol>
          {step === 'welcome' && (
            <p className="onboarding-lede">
              Welcome to Buddies. Connect your AI tools, choose a project folder, and build a team
              to work with you.
            </p>
          )}
          {step === 'team' && (
            <Suspense fallback={<p>Loading team creator…</p>}>
              <WorkspaceTeamForm onStarted={() => setSetupDismissed(true)} />
            </Suspense>
          )}
          {step === 'setup' && (
            <>
              {status.data?.checks.map((check) => (
                <DependencyCard key={check.id} check={check} />
              )) ?? <p>Checking dependencies…</p>}
              {(status.kind === 'failed' || status.kind === 'stale') && (
                <p>Could not load checks: {status.error.message}</p>
              )}
              {error && <p role="alert">{error}</p>}
              {children}
            </>
          )}
        </div>
        <footer
          style={{
            margin: '0 var(--sp-10)',
            padding: 'var(--sp-8) 0 var(--sp-9)',
            borderTop: `1px solid ${SURFACE.border}`,
            flexShrink: 0,
          }}
        >
          <div className="ui-row" style={{ gap: 'var(--sp-4)', justifyContent: 'space-between' }}>
            <button
              type="button"
              style={{ ...buttonStyle, visibility: step === 'welcome' ? 'hidden' : 'visible' }}
              disabled={step === 'setup' && (retrying || (checking && !!status.data))}
              onClick={() =>
                step === 'setup' ? void retry() : setStep(step === 'team' ? 'setup' : 'welcome')
              }
            >
              {step === 'setup' ? '↻ Check again' : step === 'team' ? '← Back' : 'Welcome'}
            </button>
            <button
              type="button"
              // The team form owns the step's primary action; Skip stays quiet beside it.
              className={step === 'team' ? undefined : 'onboarding-primary'}
              style={
                step === 'team'
                  ? { ...buttonStyle, color: SURFACE.muted, borderRadius: 10 }
                  : undefined
              }
              onClick={() =>
                step === 'team'
                  ? setSetupDismissed(true)
                  : setStep(step === 'welcome' ? 'setup' : 'team')
              }
            >
              {step === 'team' ? 'Skip for now' : 'Continue →'}
            </button>
          </div>
        </footer>
      </div>
    </dialog>
  );
}
