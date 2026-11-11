import { type ReactNode, useEffect, useRef } from 'react';

// Pattern: one-definition (docs/patterns.md#one-definition)
// The one modal for Buddy surfaces: the Task overlay and the file viewer.
// Native <dialog> + showModal() gives the top layer, the focus trap and Escape (as `cancel`), and
// needs no portal. A click on ::backdrop reaches the dialog itself; one inside reaches a child.
// Focus returns to whatever held it before opening (the badge or card that opened it).
export function ModalDialog({
  className,
  label,
  onClose,
  children,
}: {
  className: string;
  label: string;
  onClose(): void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  // Read through a ref: an inline onClose from a parent that re-renders (a polled view) must not
  // close and re-open the dialog, which would move focus back to the opener on every poll.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    dialog.focus();
    const onCancel = (event: Event) => {
      event.preventDefault();
      closeRef.current();
    };
    dialog.addEventListener('cancel', onCancel);
    return () => {
      dialog.removeEventListener('cancel', onCancel);
      if (dialog.open) dialog.close();
      opener?.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialogRef}
      className={className}
      tabIndex={-1}
      aria-label={label}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {children}
    </dialog>
  );
}
