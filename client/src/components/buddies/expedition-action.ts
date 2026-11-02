import { useState } from 'react';
import { errorText } from './api';

// A host action's button state, shared by a draft's Launch (chat card and modal footer) and the
// retire controls. The server re-checks at click time and answers a refusal with the reason, which
// shows inline under the button.

export type ActionState = { t: 'idle' } | { t: 'pending' } | { t: 'failed'; error: string };

/** Run one mutation (`act` calls `buddyWrite`), then `refetch`; the state tracks pending and the
 * refusal text. */
export function useHostAction(act: () => Promise<unknown>, refetch: () => Promise<void>) {
  const [state, setState] = useState<ActionState>({ t: 'idle' });
  const run = () => {
    setState({ t: 'pending' });
    act()
      // The draft now reads `launched`, an expedition `retiring`: the view follows the refetch.
      .then(refetch)
      .then(() => setState({ t: 'idle' }))
      .catch((cause: unknown) => setState({ t: 'failed', error: errorText(cause) }));
  };
  return { state, run };
}
