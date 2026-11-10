import { type ReactNode, useLayoutEffect, useRef } from 'react';
import './fullscreen-composer.css';

/** Keep the editor mounted: moving it into a portal on focus loses the iOS keyboard. */
export function FullscreenComposer({
  expanded,
  onClose,
  children,
}: {
  expanded: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!expanded) return;
    const frame = frameRef.current!;
    const root = document.documentElement;
    const body = document.body;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const saved = {
      position: body.style.position,
      top: body.style.top,
      width: body.style.width,
      overflow: body.style.overflow,
      rootOverflow: root.style.overflow,
    };
    body.style.position = 'fixed';
    body.style.top = `${-scrollY}px`;
    body.style.width = '100%';
    body.style.overflow = 'hidden';
    root.style.overflow = 'hidden';

    // Make the rest of the app inaccessible without remounting the focused input.
    const siblings: Array<[HTMLElement, boolean]> = [];
    let branch: HTMLElement = frame;
    while (branch.parentElement && branch !== body) {
      for (const sibling of branch.parentElement.children) {
        if (sibling !== branch && sibling instanceof HTMLElement) {
          siblings.push([sibling, sibling.inert]);
          sibling.inert = true;
        }
      }
      branch = branch.parentElement;
    }
    const viewport = window.visualViewport;
    const update = () => {
      const top = viewport?.offsetTop ?? 0;
      frame.style.top = `${top}px`;
      frame.style.left = `${viewport?.offsetLeft ?? 0}px`;
      frame.style.width = `${viewport?.width ?? window.innerWidth}px`;
      frame.style.height = `${viewport?.height ?? window.innerHeight}px`;
      frame.style.setProperty('--composer-viewport-top', `${top}px`);
      frame.style.setProperty(
        '--composer-visible-height',
        `${viewport?.height ?? window.innerHeight}px`
      );
      frame.dataset.keyboard = String(
        root.clientHeight - (viewport?.height ?? window.innerHeight) > 120
      );
    };
    update();
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      for (const [element, inert] of siblings) element.inert = inert;
      Object.assign(body.style, {
        position: saved.position,
        top: saved.top,
        width: saved.width,
        overflow: saved.overflow,
      });
      root.style.overflow = saved.rootOverflow;
      frame.removeAttribute('style');
      delete frame.dataset.keyboard;
      window.scrollTo(scrollX, scrollY);
    };
  }, [expanded]);

  return (
    // biome-ignore lint/a11y/useAriaPropsSupportedByRole: role is 'dialog' whenever aria-modal and aria-label are set.
    <div
      ref={frameRef}
      className={
        expanded ? 'fullscreen-composer fullscreen-composer--expanded' : 'fullscreen-composer'
      }
      role={expanded ? 'dialog' : undefined}
      aria-modal={expanded || undefined}
      aria-label={expanded ? 'Compose message' : undefined}
      onKeyDown={(event) => {
        if (!expanded) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
        if (event.key !== 'Tab') return;
        const controls = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not(:disabled), textarea:not(:disabled), summary, input:not([type="file"])'
          )
        ).filter((element) => element.getClientRects().length > 0);
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }}
    >
      {children}
    </div>
  );
}
