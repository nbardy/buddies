import type { ButtonHTMLAttributes, HTMLAttributes, PropsWithChildren, ReactNode } from 'react';

function classes(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

type MobilePageProps = PropsWithChildren<{
  /** The h1's content: usually text; the channels sidebar puts its workspace switcher here. */
  title: ReactNode;
  subtitle?: ReactNode;
  className?: string;
  headerAside?: ReactNode;
}>;

export function MobilePage({ title, subtitle, className, headerAside, children }: MobilePageProps) {
  return (
    <main className={classes('mobile-ui-page', className)}>
      <header className="mobile-ui-page__header">
        <div className="mobile-ui-page__heading">
          <h1 className="mobile-ui-page__title">{title}</h1>
          {subtitle != null ? (
            <p className="mobile-ui-page__subtitle ui-muted">{subtitle}</p>
          ) : null}
        </div>
        {headerAside != null ? <div className="mobile-ui-page__aside">{headerAside}</div> : null}
      </header>
      {children}
    </main>
  );
}

type MobileSectionProps = PropsWithChildren<{
  title?: ReactNode;
  meta?: ReactNode;
  className?: string;
}>;

export function MobileSection({ title, meta, className, children }: MobileSectionProps) {
  return (
    <section className={classes('mobile-ui-section', className)}>
      {title != null || meta != null ? (
        <header className="ui-section__header">
          {title != null ? <h2 className="ui-section__title">{title}</h2> : null}
          {meta != null ? <span className="ui-section__meta ui-truncate">{meta}</span> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

/**
 * Primary action in a page header — the "+ New" affordance on Chats, Swarms and
 * Buddies. Sized to the 44px tap target so it stays reachable one-handed.
 */
export function MobileHeaderAction({
  className,
  type = 'button',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      type={type}
      className={classes('mobile-ui-header-action ui-control ui-inline-row', className)}
    >
      {children}
    </button>
  );
}

/**
 * A background refresh failed while the page still shows what loaded before
 * (a `stale` PolledState, hooks/usePolledFetch.ts). Quiet on purpose: what is
 * on screen is still right to read, only possibly behind. A failure replaces
 * the page only when nothing ever loaded (`failed`).
 */
export function MobileRefreshNotice({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <p className="mobile-muted ui-muted">
      <output>Could not refresh: {error.message}</output>{' '}
      <button type="button" className="mobile-link ui-inline-row" onClick={onRetry}>
        Retry
      </button>
    </p>
  );
}

export function MobileEmptyPanel({
  className,
  children,
  ...props
}: PropsWithChildren<HTMLAttributes<HTMLDivElement>>) {
  return (
    <div {...props} className={classes('mobile-ui-empty-panel ui-muted', className)}>
      {children}
    </div>
  );
}

/** Empty state for mobile lists: icon + message + optional CTA; the caller owns copy and action. */
type EmptyStateProps = {
  icon?: string;
  title?: string;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
};

export function EmptyState({ icon = '∅', title, message, actionLabel, onAction }: EmptyStateProps) {
  return (
    <div className="mobile-empty ui-stack" role="status" aria-live="polite">
      <div className="mobile-empty__icon ui-muted" aria-hidden="true">
        {icon}
      </div>
      {title ? <h2 className="mobile-empty__title">{title}</h2> : null}
      <p className="mobile-empty__message">{message}</p>
      {actionLabel && onAction ? (
        <button type="button" className="mobile-empty__cta" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}
