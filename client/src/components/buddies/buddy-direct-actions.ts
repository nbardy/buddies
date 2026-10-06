import { WAKE_MESSAGE } from '@unleashd/shared';
/**
 * client/src/components/buddies/buddy-direct-actions.ts
 *
 * DM and Wake for one Buddy, shared by the desktop channel rail, the desktop
 * sidebar and the mobile channels home. No JSX, no CSS (mobile-safe).
 * Server: server/src/buddies/channels.ts (openDirect). No body: the chat lives
 * in the Buddy's home workspace.
 *   DM   — POST /api/buddies/:id/direct → the one ongoing owner chat (history kept)
 *   Wake — an ordinary post of WAKE_MESSAGE to the Buddy's 1:1 DM channel
 *          (postToBuddyDm): a DM post wakes its Buddy, so wake has no route
 */
import { useAtomValue } from 'jotai';
import { useState } from 'react';
import { setConversationDone } from '../../atoms/actions';
import { listField } from '../../atoms/conversations';
import { buddyWrite, errorText, postToBuddyDm } from './api';
import { createBuddyViaBuilder } from './create-buddy-builder';

export type DirectAction =
  | { kind: 'idle' }
  | { kind: 'pending'; action: 'dm' | 'wake' }
  | { kind: 'failed'; message: string };

// Each wake gets a fresh attempt number so its status mark remounts clean.
export type WakeAttempt = { attempt: number };

export function useBuddyDirectActions(buddyId: string) {
  const [action, setAction] = useState<DirectAction>({ kind: 'idle' });
  const [woken, setWoken] = useState<WakeAttempt | null>(null);
  const fail = (cause: unknown) => setAction({ kind: 'failed', message: errorText(cause) });
  return {
    action,
    woken,
    /** Resolve the DM, then hand its id to the caller's navigation. */
    openDm(open: (conversationId: string) => void) {
      setAction({ kind: 'pending', action: 'dm' });
      buddyWrite('direct.open', { buddyId })
        .then(({ conversationId }) => {
          setAction({ kind: 'idle' });
          open(conversationId);
        })
        .catch(fail);
    },
    wake() {
      setAction({ kind: 'pending', action: 'wake' });
      postToBuddyDm(buddyId, { body: WAKE_MESSAGE })
        .then(() => {
          setWoken((current) => ({ attempt: (current?.attempt ?? 0) + 1 }));
          setAction({ kind: 'idle' });
        })
        .catch(fail);
    },
  };
}

/**
 * "+" beside the channels rail's Buddies: start a Buddy Builder chat and open it in the DM pane
 * (the sidebar's New Buddy spine). `workspaceId` is that slack workspace, so the chat opens
 * there instead of the install checkout. One setup chat at a time: earlier unfinished ones are
 * marked done, so the rail's "Creating buddy" row is always the newest (493c1c7).
 */
export function useNewBuddy(open: (conversationId: string) => void, workspaceId?: string) {
  const builders = useAtomValue(listField('builders'));
  const [state, setState] = useState<DirectAction>({ kind: 'idle' });
  return {
    state,
    start() {
      if (state.kind === 'pending') return;
      for (const entry of builders) if (!entry.done) setConversationDone(entry.id, true);
      setState({ kind: 'pending', action: 'dm' });
      createBuddyViaBuilder(workspaceId)
        .then((conversationId) => {
          setState({ kind: 'idle' });
          open(conversationId);
        })
        .catch((cause: unknown) => setState({ kind: 'failed', message: errorText(cause) }));
    },
  };
}
