import { type ConversationConfig, isHarnessRetryFailure } from '@unleashd/shared';
import { type CSSProperties, useState } from 'react';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { useProviderCatalog } from '../../hooks/useProviderCatalog';
import { ChannelModelPicker } from './ChannelModelPicker';
import { errorText, retryFailedReply } from './api';
import type { Post, ThreadPage } from './types';
import './ChannelComposer.css';

// Retry and new-chat actions reuse the mention chip's model picker. A Buddy turn needs
// Buddy MCP tools; `excluded` removes the harness that failed. Inline recovery pickers
// stay centered in the viewport (a bottom sheet on phones), regardless of the row's position.
// Placement retains the trigger's layout hook for existing header/composer callers.
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
        <ChannelModelPicker
          label={label}
          note={note}
          catalog={catalog}
          value={value}
          providerFilter={allowed}
          onChange={setDraft}
          onClose={close}
          unavailable={
            catalog ? 'No other harness can run this Buddy.' : 'Loading harness options…'
          }
          actions={
            <>
              <button type="button" onClick={close}>
                Cancel
              </button>
              <button
                type="button"
                className="channel-composer-model-done"
                disabled={value === null || !allowed(value.provider)}
                onClick={() => {
                  if (value === null || !allowed(value.provider)) return;
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
            </>
          }
        />
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
      onConfirm={(config) => retryFailedReply(post.id, config)}
    />
  );
}
