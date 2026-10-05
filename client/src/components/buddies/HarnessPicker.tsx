import { type ConversationConfig, isHarnessRetryFailure } from '@unleashd/shared';
import { type CSSProperties, useState } from 'react';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { useProviderCatalog } from '../../hooks/useProviderCatalog';
import { ConversationConfigPicker } from '../../views/config/ConversationConfigPicker';
import { buddyWrite, errorText } from './api';
import type { Post, ThreadPage } from './types';
import './ChannelComposer.css';

// A button that opens the composer's harness/model popover (the mention chip's, same classes) and
// confirms one choice. Callers (493c1c7): "Retry with a different harness" under a failed reply,
// an out-of-tokens DM or chat, and "New chat" in a DM. A Buddy turn (`buddy`) needs the Buddy MCP
// tools, and `excluded` is the harness that just failed, which the server would refuse anyway.
// `placement` is where the popover opens relative to the button: 'above' near the composer,
// 'below' in a header. Fix guard: the header's "Refresh context" opened upward off the top of
// the viewport, unreadable and unpickable (#bugfixes 2026-09-28/29).
export type PickerPlacement = 'above' | 'below';

export function HarnessPicker({
  label,
  note,
  confirm,
  seed,
  excluded,
  buddy,
  onConfirm,
  placement,
  style,
  disabled = false,
}: {
  label: string;
  note: string;
  confirm: string;
  /** Where the picker opens; null picks the first other harness that can run a Buddy. */
  seed: ConversationConfig | null;
  excluded: string | null;
  buddy: boolean;
  onConfirm(config: ConversationConfig): Promise<unknown>;
  placement: PickerPlacement;
  style?: CSSProperties;
  disabled?: boolean;
}) {
  const { catalog } = useProviderCatalog();
  const [draft, setDraft] = useState<ConversationConfig | null>(null);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<
    { kind: 'idle' | 'busy' } | { kind: 'failed'; message: string }
  >({ kind: 'idle' });
  const allowed = (providerId: string) =>
    providerId !== excluded &&
    (catalog?.providers.some((p) => p.id === providerId && (!buddy || p.supportsRequiredMcp)) ??
      false);
  const fallback = catalog?.providers.find((provider) => allowed(provider.id));
  const value =
    draft ??
    seed ??
    (fallback
      ? { provider: fallback.id, model: { mode: 'default' }, reasoning: { mode: 'default' } }
      : null);
  const close = () => setOpen(false);
  return (
    <div className={`channel-harness-picker channel-harness-picker--${placement}`} style={style}>
      <button
        type="button"
        className="channel-inline-action"
        disabled={disabled || state.kind === 'busy'}
        onClick={() => {
          setDraft(null);
          setOpen(true);
        }}
      >
        {state.kind === 'busy' ? 'Starting…' : label}
      </button>
      {state.kind === 'failed' && (
        <p className="channel-composer-problem" role="alert">
          {state.message}
        </p>
      )}
      {open && (
        <>
          <button
            type="button"
            className="channel-composer-model-backdrop"
            aria-label="Close harness picker"
            tabIndex={-1}
            onClick={close}
          />
          <dialog
            open
            className="channel-composer-model ui-stack"
            aria-label={label}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              close();
            }}
          >
            <p className="channel-composer-model-note ui-muted">{note}</p>
            {catalog && value ? (
              <ConversationConfigPicker
                value={value}
                catalog={catalog}
                providerFilter={allowed}
                onChange={setDraft}
              />
            ) : (
              <p className="channel-composer-model-note ui-muted">
                {catalog ? 'No other harness can run this Buddy.' : 'Loading harness options…'}
              </p>
            )}
            <div className="channel-composer-model-actions">
              <button type="button" onClick={close}>
                Cancel
              </button>
              <button
                type="button"
                className="channel-composer-model-done"
                disabled={value === null || value.provider === excluded}
                onClick={() => {
                  if (value === null) return;
                  close();
                  setState({ kind: 'busy' });
                  onConfirm(value).then(
                    () => setState({ kind: 'idle' }),
                    (cause: unknown) => setState({ kind: 'failed', message: errorText(cause) })
                  );
                }}
              >
                {confirm}
              </button>
            </div>
          </dialog>
        </>
      )}
    </div>
  );
}

/** Failed replies and decision checks share model recovery in the original thread. */
export function ReplyRetry({ post }: { post: Post }) {
  const retryable = post.purpose === 'reply_failed' && isHarnessRetryFailure(post.body);
  const { data } = usePolledFetch<ThreadPage>(
    retryable && post.rootId
      ? `/api/buddies/posts/${encodeURIComponent(post.rootId)}/thread`
      : null,
    30_000
  );
  const author = post.author;
  const seed =
    author.kind === 'buddy'
      ? (data?.seats.find((seat) => seat.buddyId === author.id)?.config ?? null)
      : null;
  if (!retryable) return null;
  return (
    <HarnessPicker
      label="Retry with model…"
      note="Choose a model to answer the original message in this thread."
      confirm="Retry"
      seed={seed}
      disabled={seed === null}
      excluded={null}
      buddy
      placement="above"
      onConfirm={(config) =>
        buddyWrite(`/api/buddies/posts/${encodeURIComponent(post.id)}/retry`, 'POST', { config })
      }
    />
  );
}
