import { z } from 'zod';
import { ConversationConfigSchema } from './conversation-config.js';

// What a Buddy's turn runs on when nobody picks: its profile's harness, model
// and effort. `unreported`: no profile config is known, so the picker shows the
// Buddy's default without inventing one (the channel @ menu, ChannelReference).
// An unpinned profile runs the install's agent: `resolving` until the client has read
// it, `no-agent` when nothing is installed (config-mapping.ts buddyExecutionPreferences).
export const BuddyMemberExecutionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('profile'), config: ConversationConfigSchema }),
  z.object({ kind: z.literal('unreported') }),
  z.object({ kind: z.literal('resolving') }),
  z.object({ kind: z.literal('no-agent') }),
]);

export type BuddyMemberExecution = z.infer<typeof BuddyMemberExecutionSchema>;
