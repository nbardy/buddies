import type { ConversationDetail, ConversationRow, Message } from '@unleashd/shared';
import { bodyText } from '@unleashd/shared';
import { shortenHomePath } from './directories';
import { formatToolUse } from './tool-presentation';

/**
 * Plain-text transcript and the fork draft, shared by both trees. Fork is a soft handoff: a new
 * conversation whose draft carries the transcript, so it must stand alone across providers. See
 * docs/client-rationale.md#fork-transcript.
 */

/** An open conversation: its row, its loaded detail and its loaded bodies. */
export interface OpenConversation {
  row: ConversationRow;
  detail: ConversationDetail;
  messages: readonly Message[];
}

export function messageTranscriptContent(message: Message): string {
  if (message.body.t === 'text') return message.body.text;
  return message.body.parts
    .map((part) => {
      switch (part.t) {
        case 'text':
          return part.text;
        case 'tool': {
          const summary = formatToolUse(part.name, part.input, part.displayText);
          return part.input === undefined
            ? summary
            : `${summary}\n\n${typeof part.input === 'string' ? part.input : JSON.stringify(part.input, null, 2)}`;
        }
        case 'question':
          return `[Question] ${JSON.stringify(part.question)}`;
        case 'buddy_builder_result':
          return `[Buddy Builder result] ${JSON.stringify(part.event)}`;
        case 'buddy_worker_thread':
          return `[Buddy worker thread] ${part.thread.label}`;
        case 'swarm_launch':
          return `[Swarm launch] ${part.command}`;
      }
    })
    .join('\n');
}

/** Remove the machine preamble from the first user record, including mixed native blocks. */
export function stripFirstMessagePrefix(message: Message, prefix: string): Message {
  if (message.body.t === 'text')
    return message.body.text.startsWith(prefix)
      ? {
          ...message,
          body: { t: 'text', text: message.body.text.slice(prefix.length).replace(/^\n\n/, '') },
        }
      : message;
  const first = message.body.parts[0];
  if (first?.t !== 'text' || !first.text.startsWith(prefix)) return message;
  return {
    ...message,
    body: {
      t: 'parts',
      parts: [
        { t: 'text', text: first.text.slice(prefix.length).replace(/^\n\n/, '') },
        ...message.body.parts.slice(1),
      ],
    },
  };
}

export function buildThreadTranscript({ row, detail, messages }: OpenConversation): string {
  // The server's resolution is the model; the client never re-derives it (T09).
  const resolution = detail.config.resolution;
  const modelDisplay =
    resolution.status === 'resolved'
      ? resolution.value.modelId
      : (resolution.lastResolved?.modelId ?? detail.latestTurn.observedModel ?? 'default');
  const header = [
    `Conversation: ${row.id}`,
    `Provider:     ${row.provider}`,
    `Model:        ${modelDisplay}`,
    `Folder:       ${shortenHomePath(row.cwd)}`,
    '---',
  ].join('\n');

  // The swarm debug preamble is a machine prefix on the first user message
  // (the server sets it only on chats). Strip it here too, or every fork
  // re-injects the preamble as if the user typed it.
  const prefix = detail.swarmDebugPrefix;
  const body = messages
    .map((msg, index) => {
      const content = messageTranscriptContent(
        index === 0 && msg.role === 'user' && prefix ? stripFirstMessagePrefix(msg, prefix) : msg
      );
      return `${msg.role === 'user' ? 'User' : 'Assistant'}: ${content}`;
    })
    .join('\n\n');

  return body ? `${header}\n\n${body}` : header;
}

export function buildForkDraft(conversation: OpenConversation): string {
  return [
    buildThreadTranscript(conversation),
    '',
    'Continue the original objective from this fork.',
  ].join('\n');
}

// One-time compatibility (task_01a1153f, owner decision 2026-10-07). From 2026-10-06 (decision A)
// until then, deliveries (worker answers, run_failed posts, followed-thread posts) ran as turns IN
// the owner's chat, so its history holds their prompts as user messages, which rendered as "You"
// with the raw envelope. Deliveries now run in the chat's background branch, so no new message
// matches. A message carries no provenance, so the envelope's fixed first line (server runner.ts
// `deliveryPrompt`) is the only evidence left. Never extend this to new inputs.
const DELIVERY_ENVELOPE = 'New posts in threads you follow, oldest first:';
export function isLegacyDeliveryInput(message: Message): boolean {
  return message.role === 'user' && bodyText(message.body).startsWith(DELIVERY_ENVELOPE);
}
