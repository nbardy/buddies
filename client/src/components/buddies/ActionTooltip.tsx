import {
  type HTMLAttributes,
  type ReactElement,
  cloneElement,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import './ActionTooltip.css';

type TriggerProps = HTMLAttributes<HTMLElement> & { 'data-tooltip'?: string };
type Position = { left: number; top: number; above: boolean };

// Pattern: fix-guards (docs/patterns.md#fix-guards)
// Native titles were present but invisible to the owner. The real-browser tooltip
// check proves painted hover/focus text; a body portal escapes the scrolling rail.
export function ActionTooltip({
  text,
  children,
}: { text: string; children: ReactElement<TriggerProps> }) {
  const id = useId();
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const closeSoon = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setPosition(null), 150);
  };
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    []
  );
  const [position, setPosition] = useState<Position | null>(null);
  const show = (element: HTMLElement) => {
    cancelClose();
    trigger.current = element;
    const rect = element.getBoundingClientRect();
    const above = rect.bottom > window.innerHeight - 80;
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - 288)),
      top: above ? rect.top - 6 : rect.bottom + 6,
      above,
    });
  };
  useEffect(() => {
    if (!position) return;
    const close = () => setPosition(null);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [position]);
  const original = children.props;
  return (
    <>
      {cloneElement(children, {
        title: undefined,
        'data-tooltip': text,
        'aria-describedby': position
          ? [original['aria-describedby'], id].filter(Boolean).join(' ')
          : original['aria-describedby'],
        onPointerEnter: (event) => {
          original.onPointerEnter?.(event);
          if (event.pointerType !== 'touch') show(event.currentTarget);
        },
        onPointerLeave: (event) => {
          original.onPointerLeave?.(event);
          if (document.activeElement !== event.currentTarget) closeSoon();
        },
        onFocus: (event) => {
          original.onFocus?.(event);
          show(event.currentTarget);
        },
        onBlur: (event) => {
          original.onBlur?.(event);
          setPosition(null);
        },
        onClick: (event) => {
          setPosition(null);
          original.onClick?.(event);
        },
      })}
      {position &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            onPointerEnter={cancelClose}
            onPointerLeave={() => {
              if (document.activeElement !== trigger.current) closeSoon();
            }}
            className="action-tooltip"
            style={{
              left: position.left,
              top: position.top,
              transform: position.above ? 'translateY(-100%)' : undefined,
            }}
          >
            {text}
          </div>,
          document.body
        )}
    </>
  );
}
