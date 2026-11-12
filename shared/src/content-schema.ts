import { z } from 'zod';
import { BuddyBuilderEventSchema, BuddyWorkerThreadSchema } from './buddy.js';

export const AskUserQuestionSchema = z.object({
  questions: z.array(
    z.object({
      question: z.string(),
      header: z.string().optional(),
      options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
      multiSelect: z.boolean().optional(),
    })
  ),
});
export type AskUserQuestion = z.infer<typeof AskUserQuestionSchema>;

// Pattern: sum-types (docs/patterns.md#sum-types)
// Ordered transcript content. The text projection is for search/copy; widgets and tools
// remain facts from provider ingress, never markers that the renderer must rediscover.
export const ContentPartSchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('text'), text: z.string() }),
  z.object({
    t: z.literal('tool'),
    name: z.string(),
    input: z.unknown().optional(),
    displayText: z.string().optional(),
    status: z.string().optional(),
  }),
  z.object({ t: z.literal('question'), question: AskUserQuestionSchema }),
  z.object({ t: z.literal('buddy_builder_result'), event: BuddyBuilderEventSchema }),
  z.object({ t: z.literal('buddy_worker_thread'), thread: BuddyWorkerThreadSchema }),
  // Legacy: stored parts of old `oompa run` launches (ingest parts_json). Never produced now.
  z.object({ t: z.literal('swarm_launch'), command: z.string() }),
]);
export type ContentPart = z.infer<typeof ContentPartSchema>;

export const MessageBodySchema = z.discriminatedUnion('t', [
  z.object({ t: z.literal('text'), text: z.string() }),
  z.object({ t: z.literal('parts'), parts: z.array(ContentPartSchema).min(1) }),
]);
export type MessageBody = z.infer<typeof MessageBodySchema>;

/** Visible prose in order; structured tool and receipt parts have no prose projection. */
export function bodyText(body: MessageBody): string {
  return body.t === 'text'
    ? body.text
    : body.parts.map((part) => (part.t === 'text' ? part.text : '')).join('');
}
