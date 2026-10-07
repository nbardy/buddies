import { useAtomValue } from 'jotai';
import { useEffect } from 'react';
import { loadConversationDetails, refreshTranscript, setTranscriptViewed } from '../atoms/actions';
import { type Transcript, rowFamily, transcriptFamily } from '../atoms/conversations';

export type BodiesStep = 'load' | 'refresh' | 'none';

/**
 * What the open view does next. Absent → load. Loaded but holding a different
 * number of messages than the row counts → page in the tail (an external CLI
 * session wrote to it, or a `message` event was missed). The WS spine never
 * fetches bodies: a count moving on a conversation nobody shows costs nothing.
 */
export function bodiesStep(transcript: Transcript, messageCount: number): BodiesStep {
  switch (transcript.tag) {
    case 'absent':
      return 'load';
    case 'loaded':
      return transcript.messages.length === messageCount ? 'none' : 'refresh';
    case 'loading':
    case 'failed':
      return 'none';
  }
}

/**
 * Keep one open conversation's bodies current (protocol v3: lists carry rows
 * only). The transcript atom holds the data per id, so a remount renders what
 * is already there; requests are deduped in flight (actions.ts).
 */
export function useConversationBodies(conversationId: string | null): {
  loaded: boolean;
  error: string | null;
} {
  const id = conversationId ?? '';
  const messageCount = useAtomValue(rowFamily(id))?.messageCount ?? null;
  const transcript = useAtomValue(transcriptFamily(id));
  const step = messageCount === null ? 'none' : bodiesStep(transcript, messageCount);
  useEffect(() => {
    if (!conversationId) return;
    setTranscriptViewed(conversationId, true);
    return () => setTranscriptViewed(conversationId, false);
  }, [conversationId]);
  useEffect(() => {
    if (!conversationId) return;
    switch (step) {
      case 'load':
        void loadConversationDetails(conversationId);
        return;
      case 'refresh':
        void refreshTranscript(conversationId);
        return;
      case 'none':
        return;
    }
  }, [conversationId, step, messageCount]);
  return {
    loaded: transcript.tag === 'loaded',
    error: transcript.tag === 'failed' ? transcript.error : null,
  };
}
