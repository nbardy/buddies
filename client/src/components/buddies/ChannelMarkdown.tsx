import type { ContentPart, MessageBody } from '@unleashd/shared';
import {
  Fragment,
  type ReactNode,
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { type Components, type ExtraProps, defaultUrlTransform } from 'react-markdown';
import { Link } from 'react-router-dom';
import remarkGfm from 'remark-gfm';
import { resource, usePolledFetch } from '../../hooks/usePolledFetch';
import { ChatActivity } from '../../ui/ChatActivity';
import { useMarkdownPipeline } from '../../utils/lazyMarkdownPlugins';
import { defineMarkdownFlavor, renderMarkdownCached } from '../../utils/markdown-pipeline';
import { remarkBreaks } from '../../utils/remark-breaks';
import { formatToolUse } from '../../utils/tool-presentation';
import { AskUserQuestionWidget } from '../AskUserQuestion';
import { BuddyBuilderResultCard } from './BuddyBuilderResultCard';
import { ChannelTaskOverlay } from './ChannelTaskOverlay';
import {
  type ChannelFileKind,
  type ChannelTask,
  channelFilePreview,
  isImageSource,
  isVideoSource,
  mediaUrl,
  parseChannelLink,
} from './channel-text';
import { REF_ATTRIBUTE } from './composer-draft';
import { taskStatusView } from './ui-contract';
import './ChannelContent.css';

// Channel post bodies: markdown (GFM, soft breaks, highlighted code; raw HTML
// stays disabled) with three app-level extensions, all ordinary markdown:
//   [@Name](buddy:<id>)  → mention pill linking to the Buddy
//   [Title](task:<id>)   → live Task: a one-line chip with a hover card in
//                          running text; a card of its own when the ref is
//                          the whole paragraph or list item. A click opens the
//                          Task overlay; it does not leave Channels.
//   ![alt](/abs/path)    → inline image, or a video player for .mp4/.webm/.mov
// Typed Buddy replies keep tool calls as parts; historical generated posts are
// decoded at channel-data before reaching this renderer.

// react-markdown strips unknown URL schemes; buddy: and task: are ours.
function channelUrlTransform(url: string): string {
  return /^(buddy|task):/.test(url) ? url : defaultUrlTransform(url);
}

const CHANNEL_MARKDOWN = defineMarkdownFlavor([remarkGfm, remarkBreaks], channelUrlTransform);

const CARD_WIDTH = 280;
const CARD_GAP = 6;
const VIEWPORT_MARGIN = 8;

// Title, status, owner, todo progress and next action: the one Task card
// layout, shared by the hover card and the block card so they cannot drift.
function TaskCardBody({ task }: { task: ChannelTask }) {
  const status = taskStatusView(task.status);
  return (
    <>
      <span className="channel-task-card-title" {...{ [REF_ATTRIBUTE]: `task:${task.id}` }}>
        {task.title}
      </span>
      <span className="channel-task-card-status" data-tone={status.tone}>
        {status.glyph} {status.label}
        <span className="channel-task-card-owner ui-muted"> · {task.ownerName}</span>
      </span>
      {task.todosTotal > 0 && (
        <span className="channel-task-card-progress">
          <span
            className="channel-task-card-bar"
            style={{ width: `${(task.todosDone / task.todosTotal) * 100}%` }}
          />
          <span className="channel-task-card-count">
            {task.todosDone}/{task.todosTotal} todos
          </span>
        </span>
      )}
      {task.nextAction && <span className="channel-task-card-next">{task.nextAction}</span>}
    </>
  );
}

type CardPlacement = { left: number; top: number } | { left: number; bottom: number };

// The hover card is portalled and fixed to the viewport, clamped to its
// edges. It used to be absolute inside the post, so the thread pane's
// overflow cut it off at the right edge (#buddies-dev, 2026-09-24).
function placeCard(trigger: DOMRect): CardPlacement {
  const width = Math.min(CARD_WIDTH, window.innerWidth - 2 * VIEWPORT_MARGIN);
  const left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(trigger.left, window.innerWidth - VIEWPORT_MARGIN - width)
  );
  return trigger.top > window.innerHeight - trigger.bottom
    ? { left, bottom: window.innerHeight - trigger.top + CARD_GAP }
    : { left, top: trigger.bottom + CARD_GAP };
}

type OpenTask = (taskId: string) => void;

function TaskChip({
  taskId,
  label,
  task,
  onOpen,
}: {
  taskId: string;
  label: ReactNode;
  task: ChannelTask | undefined;
  onOpen: OpenTask;
}) {
  const chipRef = useRef<HTMLButtonElement>(null);
  const [placement, setPlacement] = useState<CardPlacement | null>(null);
  if (!task) {
    return (
      <span className="channel-task-chip" data-tone="missing" title={`Task ${taskId}`}>
        <span className="channel-task-chip-glyph" aria-hidden="true">
          ?
        </span>
        <span className="channel-task-chip-title" {...{ [REF_ATTRIBUTE]: `task:${taskId}` }}>
          {label}
        </span>
      </span>
    );
  }
  const status = taskStatusView(task.status);
  const open = () => {
    const chip = chipRef.current;
    if (chip) setPlacement(placeCard(chip.getBoundingClientRect()));
  };
  const close = () => setPlacement(null);
  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className="channel-task-chip"
        data-tone={status.tone}
        aria-label={`${task.title} — ${status.label}`}
        onMouseEnter={open}
        onMouseLeave={close}
        onFocus={open}
        onBlur={close}
        onClick={() => {
          close();
          onOpen(task.id);
        }}
      >
        <span className="channel-task-chip-glyph" aria-hidden="true">
          {status.glyph}
        </span>
        <span className="channel-task-chip-title" {...{ [REF_ATTRIBUTE]: `task:${task.id}` }}>
          {task.title}
        </span>
      </button>
      {placement &&
        createPortal(
          <span className="channel-task-card" role="tooltip" style={placement}>
            <TaskCardBody task={task} />
          </span>,
          document.body
        )}
    </>
  );
}

// A ref that stands alone — a paragraph or list item holding nothing else —
// is a card; one inside a sentence stays a chip so it never splits the line.
function standaloneTaskId(node: ExtraProps['node']): string | null {
  const content = (node?.children ?? []).filter(
    (child) => !(child.type === 'text' && child.value.trim() === '')
  );
  if (content.length !== 1) return null;
  const [only] = content;
  if (only.type !== 'element' || only.tagName !== 'a') return null;
  const link = parseChannelLink(String(only.properties.href ?? ''));
  return link.kind === 'task' ? link.id : null;
}

function TaskBlock({
  taskId,
  task,
  onOpen,
}: {
  taskId: string;
  task: ChannelTask | undefined;
  onOpen: OpenTask;
}) {
  if (!task)
    return <TaskChip taskId={taskId} label={`Task ${taskId}`} task={undefined} onOpen={onOpen} />;
  return (
    <button
      type="button"
      className="channel-task-block"
      data-tone={taskStatusView(task.status).tone}
      onClick={() => onOpen(task.id)}
    >
      <TaskCardBody task={task} />
    </button>
  );
}

// The overrides are ONE module constant; the data they read (names, Tasks,
// the overlay opener) arrives through context. hast-util-to-jsx-runtime uses
// each override as the element TYPE, so a new function identity is a new
// component to React and everything under it remounts. They used to be built
// per render from buddyNames/tasks, which the workspace poll (activity every
// 10s, Tasks every 15s, plus WS pushes) re-creates — so an embedded <video>
// remounted and restarted a few seconds into playback (#bugfixes, 2026-09-26).
interface ChannelMarkdownData {
  buddyNames: Readonly<Record<string, string>>;
  tasks: ReadonlyMap<string, ChannelTask>;
  onOpenTask(taskId: string): void;
  onOpenFile(file: ChannelFile): void;
}

const ChannelMarkdownDataContext = createContext<ChannelMarkdownData | null>(null);

function useChannelMarkdownData(): ChannelMarkdownData {
  const data = useContext(ChannelMarkdownDataContext);
  if (!data) throw new Error('channel markdown overrides render only inside ChannelMarkdown');
  return data;
}

function ChannelImage({ src, alt }: { src: string; alt: string }) {
  // Fix-guard: target=_blank trapped iOS/PWA users in a full-screen document with no back
  // control; channel-markdown.test.tsx keeps image opens inside the app-owned viewer.
  const { onOpenFile } = useChannelMarkdownData();
  return (
    <button
      type="button"
      className="channel-media-link"
      onClick={() => onOpenFile({ kind: 'image', src, label: alt || 'Image preview' })}
      aria-label={alt ? `Open image: ${alt}` : 'Open image'}
    >
      <img className="channel-media" src={src} alt={alt} loading="lazy" />
    </button>
  );
}

function ChannelTaskBlock({ taskId }: { taskId: string }) {
  const { tasks, onOpenTask } = useChannelMarkdownData();
  return <TaskBlock taskId={taskId} task={tasks.get(taskId)} onOpen={onOpenTask} />;
}

function ChannelLink({ href, children }: { href?: string; children?: ReactNode }) {
  const { buddyNames, tasks, onOpenTask, onOpenFile } = useChannelMarkdownData();
  const link = parseChannelLink(href ?? '');
  switch (link.kind) {
    case 'buddy':
      return (
        // Copying a rendered mention carries its id: the composer's paste reads this attribute.
        <Link
          className="channel-mention"
          to={`/buddies/${encodeURIComponent(link.id)}`}
          {...{ [REF_ATTRIBUTE]: `buddy:${link.id}` }}
        >
          @{buddyNames[link.id] ?? String(children).replace(/^@/, '')}
        </Link>
      );
    case 'task':
      return (
        <TaskChip taskId={link.id} label={children} task={tasks.get(link.id)} onOpen={onOpenTask} />
      );
    case 'web': {
      const preview = channelFilePreview(link.href);
      return (
        <a
          href={mediaUrl(link.href)}
          target="_blank"
          rel="noreferrer"
          onClick={
            preview
              ? (event) => {
                  if (
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  )
                    return;
                  event.preventDefault();
                  onOpenFile({
                    ...preview,
                    label: event.currentTarget.textContent || 'File preview',
                  });
                }
              : undefined
          }
        >
          {children}
        </a>
      );
    }
  }
}

const CHANNEL_COMPONENTS: Components = {
  p: ({ node, children }) => {
    const taskId = standaloneTaskId(node);
    return taskId === null ? <p>{children}</p> : <ChannelTaskBlock taskId={taskId} />;
  },
  li: ({ node, children, className }) => {
    const taskId = standaloneTaskId(node);
    return taskId === null ? (
      <li className={className}>{children}</li>
    ) : (
      <li className="channel-task-block-item">
        <ChannelTaskBlock taskId={taskId} />
      </li>
    );
  },
  a: ({ href, children }) => <ChannelLink href={href}>{children}</ChannelLink>,
  img: ({ src, alt }) => {
    const source = typeof src === 'string' ? src : '';
    const url = mediaUrl(source);
    if (!isImageSource(source) && !isVideoSource(source))
      return (
        <ChannelLink href={source}>
          {alt || source.split('/').at(-1) || 'Download file'}
        </ChannelLink>
      );
    return isVideoSource(source) ? (
      // biome-ignore lint/a11y/useMediaCaption: user-posted clips carry no caption track
      <video className="channel-media" src={url} controls preload="metadata" title={alt} />
    ) : (
      <ChannelImage src={url} alt={alt ?? ''} />
    );
  },
};

type ChannelFile = { kind: ChannelFileKind; src: string; label: string };

function useFileText(src: string) {
  // Pattern: one-store-one-index (docs/patterns.md#one-store-one-index)
  // The existing text cache also serves hover previews; reopening a file retains its contents.
  const source = useMemo(
    () =>
      resource(`text:${src}`, async (signal) => {
        const response = await fetch(src, { signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
      }),
    [src]
  );
  return usePolledFetch(source, 0);
}

function MarkdownFile({ src }: { src: string }) {
  const file = useFileText(src);
  const pipeline = useMarkdownPipeline(CHANNEL_MARKDOWN);
  return (
    <>
      {(file.kind === 'failed' || file.kind === 'stale') && (
        <p role="alert">
          Could not {file.kind === 'stale' ? 'refresh' : 'load'} this document.{' '}
          <button type="button" onClick={() => void file.refetch()}>
            Retry
          </button>
        </p>
      )}
      {file.data === null ? (
        file.kind !== 'failed' && <output>Loading document…</output>
      ) : (
        <div className="channel-markdown">
          {renderMarkdownCached(pipeline, file.data, CHANNEL_COMPONENTS)}
        </div>
      )}
    </>
  );
}

// Pattern: sum-types (docs/patterns.md#sum-types)
// Fix-guard: HTML attachment links downloaded instead of opening the viewer.
// Render fetched text in an opaque-origin sandbox; never grant allow-same-origin.
// The browser viewer regression checks scripts work without access to the parent.
function HtmlFile({ src, label }: { src: string; label: string }) {
  const file = useFileText(src);
  return (
    <>
      {(file.kind === 'failed' || file.kind === 'stale') && (
        <p role="alert">
          Could not {file.kind === 'stale' ? 'refresh' : 'load'} this document.{' '}
          <button type="button" onClick={() => void file.refetch()}>
            Retry
          </button>
        </p>
      )}
      {file.data === null ? (
        file.kind !== 'failed' && <output>Loading document…</output>
      ) : (
        <iframe
          className="channel-file-pdf"
          title={label}
          sandbox="allow-scripts allow-downloads"
          srcDoc={`<!doctype html><base href="about:srcdoc">${file.data}`}
        />
      )}
    </>
  );
}

// Pattern: sum-types (docs/patterns.md#sum-types)
// Fix-guard: Markdown attachments downloaded instead of opening a readable document.
// channel-markdown.test.tsx and the browser viewer checks cover the shared overlay and file route.
function ChannelFileOverlay({ file, onClose }: { file: ChannelFile; onClose(): void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    dialog.focus();
    const onCancel = (event: Event) => {
      event.preventDefault();
      onClose();
    };
    dialog.addEventListener('cancel', onCancel);
    return () => {
      dialog.removeEventListener('cancel', onCancel);
      if (dialog.open) dialog.close();
    };
  }, [onClose]);
  return (
    <dialog
      ref={dialogRef}
      className="channel-file-overlay"
      tabIndex={-1}
      aria-label={file.label}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <button
        type="button"
        className="channel-file-close"
        onClick={onClose}
        aria-label="Close file"
        title="Close file"
      >
        ✕
      </button>
      {file.kind === 'image' ? (
        <img className="channel-media" src={file.src} alt={file.label} />
      ) : file.kind === 'video' ? (
        // biome-ignore lint/a11y/useMediaCaption: user attachments carry no caption track
        <video className="channel-media" src={file.src} controls autoPlay playsInline />
      ) : (
        <section className="channel-file-document ui-stack">
          <header className="channel-file-header ui-row">
            <span className="ui-truncate">{file.label}</span>
            <a href={file.src} download>
              Download
            </a>
          </header>
          {file.kind === 'markdown' ? (
            <article className="channel-file-scroll">
              <MarkdownFile src={file.src} />
            </article>
          ) : file.kind === 'html' ? (
            <HtmlFile src={file.src} label={file.label} />
          ) : (
            <iframe className="channel-file-pdf" src={`${file.src}&preview=1`} title={file.label} />
          )}
        </section>
      )}
    </dialog>
  );
}

// Memoized: a markdown render still walks the hast into React, and a row re-renders
// whenever who is replying changes. The cache keeps an unchanged post's body,
// names and Tasks identical (atoms/resources.ts settledEntry), so only a post
// that actually changed is parsed again.
type ChannelPart =
  | ContentPart
  | {
      t: 'tool_calls';
      calls: Extract<ContentPart, { t: 'tool' }>[];
      workers: Extract<ContentPart, { t: 'buddy_worker_thread' }>[];
    };

function channelParts(body: MessageBody): ChannelPart[] {
  if (body.t === 'text') return [{ t: 'text', text: body.text }];
  const result: ChannelPart[] = [];
  for (const part of body.parts) {
    if (part.t === 'text' && !part.text.trim() && result.at(-1)?.t === 'tool_calls') continue;
    if (part.t === 'tool' || part.t === 'buddy_worker_thread') {
      let last = result.at(-1);
      if (last?.t !== 'tool_calls') {
        last = { t: 'tool_calls', calls: [], workers: [] };
        result.push(last);
      }
      if (part.t === 'tool') last.calls.push(part);
      else last.workers.push(part);
    } else result.push(part);
  }
  return result;
}

export const ChannelMarkdown = memo(function ChannelMarkdown({
  body,
  buddyNames,
  tasks,
}: {
  body: MessageBody;
  buddyNames: Readonly<Record<string, string>>;
  tasks: ReadonlyMap<string, ChannelTask>;
}) {
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<ChannelFile | null>(null);
  const closeTask = useCallback(() => setOpenTaskId(null), []);
  const closeFile = useCallback(() => setOpenFile(null), []);
  const data = useMemo(
    () => ({
      buddyNames,
      tasks,
      onOpenTask: setOpenTaskId,
      onOpenFile: setOpenFile,
    }),
    [buddyNames, tasks]
  );
  const openTask = openTaskId === null ? undefined : tasks.get(openTaskId);
  const parts = useMemo(() => channelParts(body), [body]);
  const pipeline = useMarkdownPipeline(CHANNEL_MARKDOWN);
  const markdown = (text: string, key?: number) => (
    <Fragment key={key}>{renderMarkdownCached(pipeline, text, CHANNEL_COMPONENTS)}</Fragment>
  );
  return (
    <ChannelMarkdownDataContext.Provider value={data}>
      <div className="channel-markdown">
        {openTask && <ChannelTaskOverlay task={openTask} names={buddyNames} onClose={closeTask} />}
        {openFile && <ChannelFileOverlay file={openFile} onClose={closeFile} />}
        {parts.map((part, index) => {
          switch (part.t) {
            case 'text':
              return part.text.trim() ? markdown(part.text, index) : null;
            case 'tool_calls':
              return (
                <ChatActivity
                  key={index}
                  label={
                    part.calls.length
                      ? `${part.calls.length} tool ${part.calls.length === 1 ? 'call' : 'calls'}`
                      : 'Work launched'
                  }
                  workerThreads={part.workers.map((worker) => worker.thread)}
                >
                  {part.calls.map((call, callIndex) =>
                    markdown(
                      formatToolUse(call.name, call.input, call.displayText) +
                        (call.status && call.status !== 'completed' && call.status !== 'done'
                          ? ` (${call.status})`
                          : ''),
                      callIndex
                    )
                  )}
                </ChatActivity>
              );
            case 'tool':
              return markdown(formatToolUse(part.name, part.input, part.displayText), index);
            case 'question':
              return <AskUserQuestionWidget key={index} data={part.question} />;
            case 'buddy_builder_result':
              return <BuddyBuilderResultCard key={index} event={part.event} />;
            case 'buddy_worker_thread':
              return null;
            case 'swarm_launch':
              return markdown(part.command, index);
          }
        })}
      </div>
    </ChannelMarkdownDataContext.Provider>
  );
});

/** Three pulsing dots: "is replying" / "is checking". Respects reduced motion. */
export function TypingDots() {
  return (
    <span className="channel-typing-dots" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}
