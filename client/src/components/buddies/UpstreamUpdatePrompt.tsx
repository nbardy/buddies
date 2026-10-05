import {
  type UpstreamStatus,
  UpstreamStatusSchema,
  UpstreamUpdateResultSchema,
} from '@unleashd/shared';
import { useAtomValue } from 'jotai';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { markUpstreamHandled, upstreamHandledShaAtom } from '../../atoms/ui';
import { resource, usePolledFetch } from '../../hooks/usePolledFetch';
import type { DeviceKind } from '../../mobile/hooks/useDeviceKind';
import { buddyApi, buddyWrite } from './api';
import { channelLinkPath } from './channel-link';
import './UpstreamUpdatePrompt.css';

// App-wide notice that this install's checkout is behind upstream `main`
// (server/src/upstream/). [Update] posts in the #upstream channel, which
// starts the Upstream Release Manager's merge turn, then opens that thread.
// [Later] hides it on this device until upstream moves to a new sha.
// Rendered once in App.tsx, above both device trees.

const STATUS_URL = '/api/upstream/status';
// The server fetches upstream every 6 hours; polling faster only re-reads its cache.
const POLL_MS = 10 * 60_000;

const STATUS = resource(STATUS_URL, async (signal) =>
  UpstreamStatusSchema.parse(await buddyApi<unknown>(STATUS_URL, { signal }))
);

type Offer = { remote: string; sha: string; behind: number };

/** What to offer, if anything: only a behind check with a ready workspace, not yet answered here. */
function offerFor(status: UpstreamStatus, handledSha: string | null): Offer | null {
  if (status.check.kind !== 'behind' || status.home.kind !== 'ready') return null;
  if (status.check.sha === handledSha) return null;
  return { remote: status.check.remote, sha: status.check.sha, behind: status.check.behind };
}

type Phase = { kind: 'idle' } | { kind: 'posting' } | { kind: 'failed'; message: string };

export function UpstreamUpdatePrompt({ device }: { device: DeviceKind }) {
  const status = usePolledFetch(STATUS, POLL_MS);
  const handledSha = useAtomValue(upstreamHandledShaAtom);
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });

  const offer = status.data ? offerFor(status.data, handledSha) : null;
  if (!offer) return null;

  const update = async () => {
    setPhase({ kind: 'posting' });
    try {
      const result = UpstreamUpdateResultSchema.parse(await buddyWrite('upstream.update', {}));
      markUpstreamHandled(offer.sha);
      setPhase({ kind: 'idle' });
      navigate(
        channelLinkPath(result.workspaceId, {
          kind: 'thread',
          channelId: result.channelId,
          rootId: result.postId,
        })
      );
    } catch (error) {
      setPhase({ kind: 'failed', message: error instanceof Error ? error.message : String(error) });
    }
  };

  const commits = offer.behind === 1 ? 'commit' : 'commits';
  return (
    <section
      className="upstream-update-prompt ui-card"
      data-device={device}
      aria-label="Update available"
      aria-live="polite"
    >
      <p>
        Unleashd is {offer.behind} {commits} behind <code>{offer.remote}/main</code>
      </p>
      {phase.kind === 'failed' && <p className="upstream-update-prompt-error">{phase.message}</p>}
      <div className="upstream-update-prompt-actions ui-row">
        <button type="button" className="ui-choice" onClick={() => markUpstreamHandled(offer.sha)}>
          Later
        </button>
        <button
          type="button"
          className="ui-choice upstream-update-prompt-update"
          disabled={phase.kind === 'posting'}
          onClick={() => void update()}
        >
          {phase.kind === 'posting' ? 'Starting…' : 'Update'}
        </button>
      </div>
    </section>
  );
}
