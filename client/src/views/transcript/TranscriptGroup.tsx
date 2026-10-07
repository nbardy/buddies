import type { Message } from '@unleashd/shared';
import { memo, useMemo } from 'react';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { AskUserQuestionWidget } from '../../components/AskUserQuestion';
import { BuddyBuilderResultCard } from '../../components/buddies/BuddyBuilderResultCard';
import { InlineSwarmRunWidget } from '../../swarm';
import { ChatActivity } from '../../ui/ChatActivity';
import type { AssistantResponse, MessageGroup } from '../../utils/chat-message-groups';
import {
  isLegacyDeliveryInput,
  messageTranscriptContent,
} from '../../utils/conversation-transcript';
import { useMarkdownPipeline } from '../../utils/lazyMarkdownPlugins';
import {
  type MarkdownRenderer,
  defineMarkdownFlavor,
  renderMarkdownCached,
  renderMarkdownLive,
} from '../../utils/markdown-pipeline';
import { remarkBreaks } from '../../utils/remark-breaks';
import { formatToolUse, freeformExecPreview } from '../../utils/tool-presentation';
import {
  CopyButton,
  makeMarkdownComponents,
  normalizeLatexDelimiters,
} from './markdown-components';
import './Transcript.css';

/** One transcript row per message group, rendered by both list containers. */
export type TranscriptPresentation = 'hover' | 'footer';

interface RowActionsProps {
  text: string;
  timestamp: Message['timestamp'];
  forwardedRef?: React.RefObject<HTMLDivElement | null>;
}

function HoverActions({ text, forwardedRef }: RowActionsProps) {
  return (
    <div className="message-actions" ref={forwardedRef}>
      {text.trim() && (
        <CopyButton text={text} className="message-action-btn ui-control ui-inline-row ui-muted" />
      )}
    </div>
  );
}

function FooterActions({ text, timestamp, forwardedRef }: RowActionsProps) {
  return (
    <div className="message-actions message-actions--footer" ref={forwardedRef}>
      <span className="message-actions__time">{new Date(timestamp).toLocaleTimeString()}</span>
      {text.trim() && <CopyButton text={text} className="message-footer-copy ui-card ui-muted" />}
    </div>
  );
}

const ROW_ACTIONS: Record<TranscriptPresentation, (props: RowActionsProps) => React.JSX.Element> = {
  hover: HoverActions,
  footer: FooterActions,
};
const CHAT_MARKDOWN = defineMarkdownFlavor([remarkGfm, remarkMath, remarkBreaks]);

interface MessageContentProps {
  msg: Message;
  collapseTools?: boolean;
  workingDirectory: string;
  markdown: MarkdownRenderer;
}

const MessageContent = memo(
  function MessageContent({ msg, workingDirectory, markdown }: MessageContentProps) {
    const pipeline = useMarkdownPipeline(CHAT_MARKDOWN);
    const mdComponents = useMemo(
      () => makeMarkdownComponents(workingDirectory),
      [workingDirectory]
    );
    const renderText = (text: string, key: number) => {
      if (!text.trim()) return null;
      return (
        <div key={key}>{markdown(pipeline, normalizeLatexDelimiters(text), mdComponents)}</div>
      );
    };
    if (msg.body.t === 'text') {
      return <div className="message-content">{renderText(msg.body.text || '...', 0)}</div>;
    }
    return (
      <div className="message-content">
        {msg.body.parts.map((part, index) => {
          switch (part.t) {
            case 'text':
              return renderText(part.text, index);
            case 'tool': {
              const line = formatToolUse(part.name, part.input, part.displayText);
              const preview = freeformExecPreview(part.name, part.input);
              const input =
                part.input === undefined
                  ? null
                  : typeof part.input === 'string'
                    ? part.input
                    : JSON.stringify(part.input, null, 2);
              return (
                <div key={index}>
                  {preview ? (
                    <p>
                      🔧 exec <code>{preview}</code>
                    </p>
                  ) : (
                    renderText(line, index)
                  )}
                  {input && (
                    <pre aria-label="Tool input">
                      <code>{input}</code>
                    </pre>
                  )}
                </div>
              );
            }
            case 'question':
              return <AskUserQuestionWidget key={index} data={part.question} />;
            case 'buddy_builder_result':
              return <BuddyBuilderResultCard key={index} event={part.event} />;
            case 'buddy_worker_thread':
              return null;
            case 'swarm_launch':
              return <InlineSwarmRunWidget key={index} workingDirectory={workingDirectory} />;
          }
        })}
      </div>
    );
  },
  (prev, next) =>
    prev.msg.body === next.msg.body &&
    prev.msg.role === next.msg.role &&
    prev.workingDirectory === next.workingDirectory &&
    prev.markdown === next.markdown
);

const ROLE_LABEL: Record<Message['role'], string> = {
  user: 'You',
  assistant: 'Assistant',
  system: 'system',
};

function StandaloneMessage({
  msg,
  forwardedRef,
  workingDirectory,
  presentation,
}: {
  msg: Message;
  forwardedRef?: React.RefObject<HTMLDivElement | null>;
  workingDirectory: string;
  presentation: TranscriptPresentation;
}) {
  const Actions = ROW_ACTIONS[presentation];
  if (isLegacyDeliveryInput(msg))
    return (
      <div className="message system">
        <ChatActivity label="Background delivery (ran in this chat before 2026-10-07)">
          <pre className="ui-muted">{messageTranscriptContent(msg)}</pre>
        </ChatActivity>
      </div>
    );
  return (
    <div className={`message ${msg.role}`}>
      {msg.role !== 'system' && (
        <div className={`message-role ${msg.role}`}>{ROLE_LABEL[msg.role]}</div>
      )}
      <MessageContent
        msg={msg}
        workingDirectory={workingDirectory}
        markdown={renderMarkdownCached}
      />
      <Actions
        text={messageTranscriptContent(msg)}
        timestamp={msg.timestamp}
        forwardedRef={forwardedRef}
      />
    </div>
  );
}

function AssistantResponseBlock({
  response,
  forwardedRef,
  workingDirectory,
  isLive,
  presentation,
}: {
  response: AssistantResponse;
  forwardedRef?: React.RefObject<HTMLDivElement | null>;
  workingDirectory: string;
  /** The turn that owns this response is still active. Shows a working
      affordance when the response has no renderable parts yet — otherwise a
      silent provider phase leaves a blank "Assistant" bubble (the server
      creates the empty placeholder at turn.started, before any output). */
  isLive: boolean;
  presentation: TranscriptPresentation;
}) {
  const showWorking = isLive && response.parts.length === 0;
  const Actions = ROW_ACTIONS[presentation];
  return (
    <article className="message assistant chat-assistant-response" aria-label="Assistant response">
      <div className="message-role assistant">Assistant</div>
      <div className="chat-response-parts">
        {showWorking && (
          <div className="chat-response-working" aria-live="polite">
            <span>Thinking…</span>
            <span className="typing-dot" aria-hidden="true" />
            <span className="typing-dot" aria-hidden="true" />
            <span className="typing-dot" aria-hidden="true" />
          </div>
        )}
        {response.parts.map((part, partIndex) => {
          // Streaming text only ever grows the response's last part.
          const markdown =
            isLive && partIndex === response.parts.length - 1
              ? renderMarkdownLive
              : renderMarkdownCached;
          return part.type === 'tool_calls' ? (
            <ChatActivity
              key={part.key}
              label={
                part.count
                  ? `${part.count} tool ${part.count === 1 ? 'call' : 'calls'}`
                  : 'Work launched'
              }
              workerThreads={part.workerThreads}
            >
              {part.messages.map((msg, index) => (
                <MessageContent
                  key={index}
                  msg={msg}
                  collapseTools={false}
                  workingDirectory={workingDirectory}
                  markdown={markdown}
                />
              ))}
            </ChatActivity>
          ) : (
            <MessageContent
              key={part.key}
              msg={part.message}
              workingDirectory={workingDirectory}
              markdown={markdown}
            />
          );
        })}
      </div>
      <Actions
        text={response.copyText}
        timestamp={response.messages[0].timestamp}
        forwardedRef={forwardedRef}
      />
    </article>
  );
}

interface TranscriptGroupProps {
  group: MessageGroup;
  isLastGroup: boolean;
  lastMessageRef: React.RefObject<HTMLDivElement | null>;
  /** Conversation working directory — resolves relative file paths in previews. */
  workingDirectory: string;
  /** Owning turn still active — only the last group can be the live one. */
  isLiveTurn?: boolean;
  presentation: TranscriptPresentation;
}

/**
 * Memoised on group identity: the tail regroup (atoms/conversations.ts) keeps
 * every settled group the SAME object on a streaming frame, so only the last
 * row re-renders. Guarded by chat-message-groups.test.tsx.
 */
export const TranscriptGroup = memo(
  function TranscriptGroup({
    group,
    isLastGroup,
    lastMessageRef,
    workingDirectory,
    isLiveTurn,
    presentation,
  }: TranscriptGroupProps) {
    if (group.type === 'assistant') {
      return (
        <AssistantResponseBlock
          response={group}
          forwardedRef={isLastGroup ? lastMessageRef : undefined}
          workingDirectory={workingDirectory}
          isLive={isLiveTurn === true && isLastGroup}
          presentation={presentation}
        />
      );
    }

    return (
      <>
        {group.messages.map((msg, mi) => (
          <StandaloneMessage
            key={mi}
            msg={msg}
            forwardedRef={
              isLastGroup && mi === group.messages.length - 1 ? lastMessageRef : undefined
            }
            workingDirectory={workingDirectory}
            presentation={presentation}
          />
        ))}
      </>
    );
  },
  (prev, next) =>
    prev.group === next.group &&
    prev.isLastGroup === next.isLastGroup &&
    prev.workingDirectory === next.workingDirectory &&
    prev.isLiveTurn === next.isLiveTurn &&
    prev.presentation === next.presentation
);
