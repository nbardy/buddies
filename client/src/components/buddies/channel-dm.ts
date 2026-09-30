/**
 * client/src/components/buddies/channel-dm.ts
 *
 * A Buddy DM drawn as a channel thread (493c1c7): the conversation's message groups become thread
 * rows — a day rule, a lead (avatar + name + time) or a continuation — so a DM reads like the
 * channel around it. Pure, so mobile may import it.
 */
import {
  type ContentPart,
  type Message,
  type MessageBody,
  type QueuedMessage,
  bodyText,
} from '@unleashd/shared';
import type { MessageGroup } from '../../utils/chat-message-groups';

// The window channelRows uses: a later message from the same author within five minutes
// continues the run (the avatar and name stay on the lead).
const GROUP_WINDOW_MS = 5 * 60_000;

export type DmAuthor = 'owner' | 'buddy';

export type DmRow =
  | { kind: 'day' | 'notice'; key: string; label: string }
  | { kind: 'lead' | 'continuation'; key: string; author: DmAuthor; at: string; body: MessageBody };

const dayLabel = (date: Date) =>
  date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

// One response's text in order; tool lines stay, so ChannelMarkdown collapses them the way it
// does in a post.
function responseBody(group: Extract<MessageGroup, { type: 'assistant' }>): MessageBody {
  const parts: ContentPart[] = [];
  group.messages.forEach((message, index) => {
    if (index) parts.push({ t: 'text', text: '\n' });
    if (message.body.t === 'text') parts.push({ t: 'text', text: message.body.text });
    else parts.push(...message.body.parts);
  });
  return { t: 'parts', parts };
}

/**
 * Rows for one DM generation. System records (errors, notices) are left out: a failed turn shows
 * its retry under the transcript instead. `queued` is what the owner sent that the server has not
 * written to the transcript yet, so Send shows it at once.
 */
export function dmRows(
  groups: readonly MessageGroup[],
  queued: readonly QueuedMessage[],
  boundary?: { at: Date; label: string }
): DmRow[] {
  const rows: DmRow[] = [];
  // Fix guard: a reset belongs below its own date, even before the first message arrives.
  // channel-dm.test.tsx covers empty generations and resets on a new day.
  let currentDay: string | null = null;
  if (boundary) {
    currentDay = boundary.at.toDateString();
    rows.push({ kind: 'day', key: 'day:reset', label: dayLabel(boundary.at) });
    rows.push({ kind: 'notice', key: 'reset', label: boundary.label });
  }
  let previous: { author: DmAuthor; at: number; day: string } | null = null;
  const push = (key: string, author: DmAuthor, at: Date, body: MessageBody) => {
    if (body.t === 'text' && !body.text.trim()) return;
    if (body.t === 'parts' && body.parts.length === 0) return;
    const day = at.toDateString();
    if (currentDay !== day) rows.push({ kind: 'day', key: `day:${key}`, label: dayLabel(at) });
    currentDay = day;
    const continues =
      previous?.day === day &&
      previous.author === author &&
      at.getTime() - previous.at < GROUP_WINDOW_MS;
    rows.push({
      kind: continues ? 'continuation' : 'lead',
      key,
      author,
      at: at.toISOString(),
      body,
    });
    previous = { author, at: at.getTime(), day };
  };
  for (const group of groups) {
    const first = group.messages[0];
    switch (group.type) {
      case 'assistant':
        push(
          `m:${group.firstMessageIndex}`,
          'buddy',
          new Date(first.timestamp),
          responseBody(group)
        );
        break;
      case 'single':
        if (first.role === 'user')
          push(`m:${group.firstMessageIndex}`, 'owner', new Date(first.timestamp), first.body);
        break;
    }
  }
  for (const item of queued) {
    // Fix guard: a 334-character owner DM appeared twice while its queue head was sending, with
    // the continuation wrapping at about five characters; stop mirroring it once transcript has it.
    const alreadyInTranscript =
      item.status === 'sending' &&
      groups.some(
        (group) =>
          group.type === 'single' &&
          group.messages[0]?.role === 'user' &&
          bodyText(group.messages[0].body) === item.content &&
          group.messages[0].timestamp.getTime() >= item.queuedAt.getTime()
      );
    if (!alreadyInTranscript)
      push(`q:${item.id}`, 'owner', new Date(item.queuedAt), {
        t: 'text',
        text: item.content,
      });
  }
  return rows;
}

/** The owner's last message: what an out-of-tokens retry resends on the new harness. */
export function lastOwnerText(messages: readonly Message[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'user' && bodyText(message.body).trim()) return bodyText(message.body);
  }
  return null;
}
