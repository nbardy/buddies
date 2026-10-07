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

// A reference the channel composer's @ menu offers: a Buddy or a Task. Picking one inserts its
// token into the draft's Markdown (body-references.ts); this record is the menu's entry, not state.
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

// An unsent channel/thread composer draft (device-local, localStorage `draft:channel:…`).
// `text` is the post body in the stored Markdown contract, references included, so the draft
// owns its own mention identities. `picked` is LEGACY: drafts saved before 2026-10-08 kept
// `@Label` text with the picks beside it. It is read once to fold the picks into tokens
// (decodeChannelDraft) and never written.
export const ChannelComposerDraftSchema = z.object({
  text: z.string(),
  picked: z.array(ChannelReferenceSchema).optional(),
  // Optional for old drafts. These are unsent explicit choices, never inferred seat copies.
  mentionConfigs: z.array(OwnerPostMentionConfigSchema).optional(),
});

export type ChannelReference = z.infer<typeof ChannelReferenceSchema>;
export type ChannelComposerDraft = z.infer<typeof ChannelComposerDraftSchema>;
