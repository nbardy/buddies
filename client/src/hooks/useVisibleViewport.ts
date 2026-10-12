import { type RefObject, useLayoutEffect } from 'react';

// Pattern: fix-guards (docs/patterns.md#fix-guards)
// The keyboard covers the layout viewport's bottom. Anchor mobile pickers to the
// visual viewport instead; guard: channel-model-picker keyboard geometry probe.
export function useVisibleViewport(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element?.closest('[data-device="mobile"]')) return;
    const viewport = window.visualViewport;
    const update = () => {
      const height = viewport?.height ?? window.innerHeight;
      const top = viewport?.offsetTop ?? 0;
      element.style.setProperty('--picker-visible-height', `${height}px`);
      element.style.setProperty(
        '--picker-bottom',
        `${Math.max(0, window.innerHeight - top - height)}px`
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
    };
  }, [ref]);
}
