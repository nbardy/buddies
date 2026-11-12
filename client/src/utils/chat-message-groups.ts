import type { BuddyWorkerThread, ContentPart, Message } from '@unleashd/shared';
import { messageTranscriptContent } from './conversation-transcript';

export type AssistantResponsePart =
  | { type: 'content'; key: string; message: Message }
  | {
      type: 'tool_calls';
      key: string;
      messages: Message[];
      count: number;
      workerThreads?: BuddyWorkerThread[];
    };

export type AssistantResponse = {
  type: 'assistant';
  messages: Message[];
  parts: AssistantResponsePart[];
  copyText: string;
  firstMessageIndex: number;
};

export type MessageGroup =
  | AssistantResponse
  | { type: 'single'; messages: Message[]; firstMessageIndex: number };

function fragment(message: Message, part: ContentPart): Message {
  return { ...message, body: { t: 'parts', parts: [part] } };
}

/** Provider records stay ordered; one assistant response owns the display and Copy action. */
export function groupChatMessages(messages: readonly Message[]): MessageGroup[] {
  return groupMessageRange(messages, 0);
}

function groupMessageRange(messages: readonly Message[], firstIndex: number): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let response: AssistantResponse | undefined;
  const content = (message: Message, key: string) => {
    response?.parts.push({ type: 'content', key, message });
  };
  const tool = (message: Message, key: string) => {
    if (!response) return;
    const last = response.parts.at(-1);
    if (last?.type === 'tool_calls') {
      last.messages.push(message);
      last.count += 1;
    } else response.parts.push({ type: 'tool_calls', key, messages: [message], count: 1 });
  };
  const worker = (thread: BuddyWorkerThread, key: string) => {
    if (!response) return;
    let last = response.parts.at(-1);
    if (last?.type !== 'tool_calls') {
      last = { type: 'tool_calls', key, messages: [], count: 0 };
      response.parts.push(last);
    }
    last.workerThreads ??= [];
    if (!last.workerThreads.some((item) => item.conversationId === thread.conversationId))
      last.workerThreads.push(thread);
  };
  for (const [localIndex, message] of messages.entries()) {
    const index = firstIndex + localIndex;
    const msg = message;
    if (msg.role !== 'assistant') {
      if (response)
        response.copyText = response.messages.map(messageTranscriptContent).join('\n\n');
      response = undefined;
      groups.push({ type: 'single', messages: [msg], firstMessageIndex: index });
      continue;
    }
    if (!response) {
      response = {
        type: 'assistant',
        messages: [],
        parts: [],
        copyText: '',
        firstMessageIndex: index,
      };
      groups.push(response);
    }
    response.messages.push(msg);
    if (msg.body.t === 'text') {
      if (msg.body.text.trim()) content(msg, `${index}:0`);
      continue;
    }
    for (const [partIndex, part] of msg.body.parts.entries()) {
      const key = `${index}:${partIndex}`;
      if (part.t === 'buddy_worker_thread') {
        worker(part.thread, key);
        continue;
      }
      if (part.t === 'tool') {
        tool(fragment(msg, part), key);
        continue;
      }
      if (part.t === 'text' && !part.text.trim()) continue;
      content(fragment(msg, part), key);
    }
  }
  if (response) response.copyText = response.messages.map(messageTranscriptContent).join('\n\n');
  return groups;
}

/** Rebuild only the last group while every earlier record keeps identity. */
export function regroupChatMessages(
  previousGroups: readonly MessageGroup[],
  previousMessages: readonly Message[],
  messages: readonly Message[]
): MessageGroup[] {
  const tail = previousGroups.at(-1);
  if (!tail || messages.length < tail.firstMessageIndex) return groupChatMessages(messages);
  const start = tail.firstMessageIndex;
  for (let i = 0; i < start; i++)
    if (messages[i] !== previousMessages[i]) return groupChatMessages(messages);
  return [
    ...previousGroups.slice(0, -1),
    ...groupMessageRange(messages.slice(start), start),
  ];
}

/** Text frames grow only the last assistant text record; structured frames arrive as records. */
export function withStreamingTail(
  settled: MessageGroup[],
  messages: readonly Message[],
  streamingText: string
): MessageGroup[] {
  const last = messages.at(-1);
  const tail = settled.at(-1);
  if (!streamingText || !last || last.role !== 'assistant' || last.body.t !== 'text' || !tail)
    return settled;
  const window = messages.slice(tail.firstMessageIndex);
  window[window.length - 1] = {
    ...last,
    body: { t: 'text', text: last.body.text + streamingText },
  };
  return [...settled.slice(0, -1), ...groupMessageRange(window, tail.firstMessageIndex)];
}
