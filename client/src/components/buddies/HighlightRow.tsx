import type { ComponentPropsWithoutRef, ReactElement, ReactNode } from 'react';
import './HighlightRow.css';

type Props = Omit<ComponentPropsWithoutRef<'li'>, 'children'> & {
  children: ReactElement;
  current?: boolean;
  buttonsRight: ReactNode;
  footer?: ReactNode;
};

// Pattern: fix-guards (docs/patterns.md#fix-guards)
// Worker counts used to shrink the highlighted opener and move stars between rows.
// inspectChannelStarLayout guards this single row/background/actions layout in both shells.
export function HighlightRow({
  children,
  buttonsRight,
  footer,
  current,
  className = '',
  ...props
}: Props) {
  return (
    <li {...props} className={`highlight-row ${className}`} data-current={current || undefined}>
      {children}
      <div className="highlight-row-actions">{buttonsRight}</div>
      {footer && <div className="highlight-row-footer">{footer}</div>}
    </li>
  );
}
