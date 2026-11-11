import { useAtomValue } from 'jotai';
import { type CSSProperties, type RefObject, useRef, useState } from 'react';
import { setThreadWidth, threadWidthAtom } from '../../atoms/ui';

// The channel thread pane's width and drag handle (review 2026-11-03: the expedition chat
// that originally shared it was a fixed 440px that could not be resized).

/** The pane's inline width: the device's thread width, leaving the main pane readable when a
 * saved width exceeds the current window. */
export function useThreadPaneStyle(): CSSProperties {
  const width = useAtomValue(threadWidthAtom);
  return { width: `min(${width}px, calc(100% - min(320px, 45%)))` };
}

/** Hover/focus left a full-height purple stripe after release; only active drag glows.
 * Guard: thread-resize.test.mjs checks release, scrolling, reload and narrow windows. */
export function ThreadResize({
  paneId,
  paneRef,
  label,
}: {
  paneId: string;
  paneRef: RefObject<HTMLElement | null>;
  label: string;
}) {
  const width = useAtomValue(threadWidthAtom);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a focusable, draggable splitter; <hr> takes neither focus nor pointer capture.
    <div
      className="channel-thread-resize"
      role="separator"
      tabIndex={0}
      aria-label={label}
      data-resizing={resizing || undefined}
      aria-orientation="vertical"
      aria-controls={paneId}
      aria-valuemin={320}
      aria-valuemax={960}
      aria-valuenow={width}
      title="Drag to resize. Arrow keys adjust; double-click resets."
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        setResizing(true);
        drag.current = {
          x: event.clientX,
          width: paneRef.current?.getBoundingClientRect().width ?? width,
        };
      }}
      onPointerMove={(event) => {
        if (drag.current) setThreadWidth(drag.current.width + drag.current.x - event.clientX);
      }}
      onPointerUp={(event) => {
        drag.current = null;
        setResizing(false);
        event.currentTarget.blur();
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        setResizing(false);
      }}
      onDoubleClick={() => setThreadWidth(420)}
      onKeyDown={(event) => {
        const next = { ArrowLeft: width + 24, ArrowRight: width - 24, Home: 320, End: 960 }[
          event.key
        ];
        if (next === undefined) return;
        event.preventDefault();
        setThreadWidth(next);
      }}
    />
  );
}
