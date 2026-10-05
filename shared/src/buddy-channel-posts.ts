import { z } from 'zod';
import { BuddyMemberExecutionSchema } from './buddy-workspace-activity.js';
import { ConversationConfigSchema } from './conversation-config.js';

// The owner's model choice for one mentioned Buddy, sent beside the post (not
// in its body, so the channel reads the same either way). A mentioned Buddy
// with no entry replies on whatever its thread already runs: its profile
// default for a new thread.
export const OwnerPostMentionConfigSchema = z.object({
  buddyId: z.string().min(1),
  config: ConversationConfigSchema,
});

export type OwnerPostMentionConfig = z.infer<typeof OwnerPostMentionConfigSchema>;

// A reference picked from the channel composer's @ menu. The composer shows
// `@Label` and swaps it for the token on send, so the pick is state beside
// the text, not part of it.
export const ChannelReferenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('buddy'),
    id: z.string(),
    label: z.string(),
    detail: z.string(),
    execution: BuddyMemberExecutionSchema,
  }),
  z.object({
    kind: z.literal('task'),
    id: z.string(),
    label: z.string(),
    detail: z.string(),
    status: z.string(),
  }),
]);

// An unsent channel/thread composer draft (device-local, localStorage
// `draft:channel:…`). It keeps the picks with the text: text alone would
// restore `@Lead` as plain words and the post would mention nobody.
export const ChannelComposerDraftSchema = z.object({
  text: z.string(),
  picked: z.array(ChannelReferenceSchema),
  // Optional for old drafts. These are unsent explicit choices, never inferred seat copies.
  mentionConfigs: z.array(OwnerPostMentionConfigSchema).optional(),
});

export type ChannelReference = z.infer<typeof ChannelReferenceSchema>;
export type ChannelComposerDraft = z.infer<typeof ChannelComposerDraftSchema>;
