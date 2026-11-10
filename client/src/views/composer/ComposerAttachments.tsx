import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PendingFile } from '../../hooks/usePendingAttachments';
import './ComposerAttachments.css';

/**
 * Pending attachments above either composer. Upload, previews and persistence
 * live in hooks/usePendingAttachments (one path for both trees); this view is
 * only the tray. `presentation` is picked by the caller:
 * - `chips`: a wrapping row of name chips, each with a remove button (desktop).
 * - `gallery`: a thumbnail strip that opens a swipeable preview pager with
 *   per-file Remove (touch, where a 18px remove target is too small).
 */
export type AttachmentsPresentation = 'chips' | 'gallery';

interface AttachmentsProps {
  files: PendingFile[];
  onRemove: (path: string) => void;
}

function AttachmentChips({ files, onRemove }: AttachmentsProps) {
  if (!files.length) return null;
  return (
    <div className="pending-files">
      {files.map((file) => (
        <div key={file.absolutePath} className="pending-file-item ui-row ui-card">
          {file.previewUrl ? (
            <img className="pending-file-thumb" src={file.previewUrl} alt={file.originalName} />
          ) : (
            <span className="pending-file-icon">&#x1F4C4;</span>
          )}
          <span className="pending-file-name ui-truncate">{file.originalName}</span>
          <button
            type="button"
            className="pending-file-remove ui-control ui-row"
            onClick={() => onRemove(file.absolutePath)}
            title="Remove file"
            aria-label={`Remove ${file.originalName}`}
          >
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}

const TRAYS: Record<
  AttachmentsPresentation,
  (props: AttachmentsProps) => React.JSX.Element | null
> = { chips: AttachmentChips, gallery: AttachmentGallery };

export function ComposerAttachments({
  presentation,
  ...props
}: AttachmentsProps & { presentation: AttachmentsPresentation }) {
  const Tray = TRAYS[presentation];
  return <Tray {...props} />;
}

/**
 * A failed drop/paste/pick must announce itself rather than look ignored:
 * during the 2026-08-20 hot-reload drain the upload 503'd and only
 * console.error'd, so drag-and-drop read as silently broken.
 */
export function UploadErrorNotice({ error, onDismiss }: { error: string; onDismiss: () => void }) {
  return (
    <div className="composer-upload-error ui-row" role="alert">
      <span className="composer-upload-error__text">{error}</span>
      <button
        type="button"
        className="composer-upload-error__dismiss"
        onClick={onDismiss}
        aria-label="Dismiss upload error"
      >
        &times;
      </button>
    </div>
  );
}

function AttachmentGallery({ files, onRemove }: AttachmentsProps) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(0);
  const pagesRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!files.length) setOpen(false);
  }, [files.length]);
  useLayoutEffect(() => {
    if (!open) return;
    const pages = pagesRef.current;
    const page = pages?.children[selected] as HTMLElement | undefined;
    if (pages && page)
      pages.scrollLeft = page.offsetLeft - (pages.firstElementChild as HTMLElement).offsetLeft;
  }, [open, selected]);
  if (!files.length) return null;
  return (
    <div className="composer-attachments">
      {open && (
        <section className="composer-attachments__gallery" aria-label="Attachment previews">
          <header>
            <span>{files.length} attachments</span>
            <button type="button" onClick={() => setOpen(false)}>
              Close previews
            </button>
          </header>
          <div ref={pagesRef} className="composer-attachments__pages">
            {files.map((file) => (
              <article className="composer-attachments__page" key={file.absolutePath}>
                {file.previewUrl ? (
                  <img src={file.previewUrl} alt={file.originalName} />
                ) : (
                  <span className="composer-attachments__document">Document</span>
                )}
                <footer>
                  <span>{file.originalName}</span>
                  <button
                    type="button"
                    onClick={() => onRemove(file.absolutePath)}
                    aria-label={`Remove ${file.originalName}`}
                  >
                    Remove
                  </button>
                </footer>
              </article>
            ))}
          </div>
        </section>
      )}
      {/* biome-ignore lint/a11y/useSemanticElements: a labelled group of content, not a form control set; <fieldset> brings form borders and padding. */}
      <div className="composer-attachments__strip" role="group" aria-label="Attached files">
        {files.map((file, index) => (
          <button
            type="button"
            className="composer-attachments__thumbnail ui-card"
            key={file.absolutePath}
            aria-label={`Preview ${file.originalName}`}
            aria-expanded={open}
            onClick={() => {
              setSelected(index);
              setOpen(true);
            }}
          >
            {file.previewUrl ? (
              <img src={file.previewUrl} alt="" />
            ) : (
              <span>{file.originalName}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
