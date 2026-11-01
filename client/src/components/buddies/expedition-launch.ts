import type { ExpeditionDraftView } from '@unleashd/shared';
import { useState } from 'react';
import { buddyWrite, errorText } from './api';

// A draft's Launch, shared by the chat card and the modal footer. The server re-checks the issues
// at click time and answers a refusal with the reason, which shows inline under the button.

export type LaunchState = { t: 'idle' } | { t: 'pending' } | { t: 'failed'; error: string };

export function useDraftLaunch(draft: ExpeditionDraftView, refetch: () => Promise<void>) {
  const [state, setState] = useState<LaunchState>({ t: 'idle' });
  const launch = () => {
    setState({ t: 'pending' });
    buddyWrite('expedition.launch', { draftId: draft.id }, { workspaceId: draft.workspaceId })
      // The draft now reads `launched`; the card turns into "Launched →".
      .then(refetch)
      .then(() => setState({ t: 'idle' }))
      .catch((cause: unknown) => setState({ t: 'failed', error: errorText(cause) }));
  };
  return { state, launch };
}
