import type { ConversationConfig, OwnerPostMentionConfig, ProviderCatalog } from '@unleashd/shared';
import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { outboxDrop, outboxSending, outboxSent } from '../../atoms/channel-outbox';
import { useConversationDraft } from '../../hooks/useConversationDraft';
import { useProviderCatalog } from '../../hooks/useProviderCatalog';
import { newId } from '../../utils/ids';
import { ConversationConfigPicker } from '../../views/config/ConversationConfigPicker';
import { BuddySigil } from './BuddySigil';
import { buddyApi, buddyWrite, errorText } from './api';
import {
  type BuddyReference,
  type ChannelReference,
  type MentionChoice,
  activeReferenceQuery,
  channelDraftId,
  choiceLabel,
  completesPickedReference,
  composerReferenceMarks,
  decodeChannelDraft,
  encodeChannelDraft,
  encodeReferences,
  insertReference,
  mediaMarkdown,
  mentionChoice,
  mentionedBuddies,
  rankReferences,
} from './channel-text';
import type { PostResult, ThreadSeat } from './types';
import './ChannelComposer.css';

type UploadedFile = { originalName: string; absolutePath: string };

const MAX_TEXTAREA_HEIGHT = 240;

const NO_CHOICES: ReadonlyMap<string, ConversationConfig> = new Map();
const NO_SEATS: readonly ThreadSeat[] = [];

// The owner's composer. Posts as the owner (never a stand-in Buddy). One
// universal @ menu fuzzy-finds Buddies and Tasks: a Buddy becomes a mention
// (which starts that Buddy's reply), a Task becomes a live chip. Pasted or
// dropped images/videos upload into the channel and are inserted as inline
// markdown at the caret.
//
// Every Buddy the text mentions gets a chip on the bar; clicking it opens the
// chat's harness/model picker for that Buddy's reply. The choice is sent
// beside the post (mentionConfigs) and becomes the Buddy's seat in the thread:
// every later reply there keeps it (channels.ts). In a thread the chip opens
// on that Buddy's latest seat (the thread read's `seats`), so a change
// continues from there instead of the profile default.
//
// Unsent text survives navigation and reload through the chat's own draft
// hook (useConversationDraft), one draft per channel and per thread. The
// picks are saved with the text, so a restored `@Lead` still mentions Lead.
//
// submit: 'enter' (desktop — Enter sends, Shift+Enter breaks a line) or
// 'button' (touch — Return is a newline, as in Slack mobile; Send sends).
export type ComposerSubmit = 'enter' | 'button';

export function ChannelComposer({
  channelId,
  placeholder,
  rootId,
  references,
  seats,
  autoFocus = false,
  submit,
  onPosted,
}: {
  channelId: string;
  placeholder: string;
  /** The thread this composer replies in; null posts at the top level. */
  rootId: string | null;
  references: readonly ChannelReference[];
  /** Each thread Buddy's latest seat; none at the top level (no thread yet). */
  seats?: readonly ThreadSeat[];
  /** Focus the textarea on mount: the desktop thread pane, opened by a Reply click. */
  autoFocus?: boolean;
  submit: ComposerSubmit;
  onPosted(result: PostResult): void;
}) {
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const [picked, setPicked] = useState<ChannelReference[]>([]);
  const [highlight, setHighlight] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [uploading, setUploading] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [choices, setChoices] = useState(NO_CHOICES);
  const [choosingFor, setChoosingFor] = useState<string | null>(null);
  const { catalog } = useProviderCatalog();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // The POST settles after later renders; its failure path reads the text now.
  const textRef = useRef(text);
  textRef.current = text;
  const draft = useConversationDraft({
    conversationId: channelDraftId(channelId, rootId),
    textareaRef,
    controlled: true,
    autoFocus,
    maxHeight: MAX_TEXTAREA_HEIGHT,
    onDraftLoaded: (stored) => {
      const restored = decodeChannelDraft(stored);
      setText(restored.text);
      setPicked(restored.picked);
      setChoices(new Map(restored.mentionConfigs?.map(({ buddyId, config }) => [buddyId, config])));
      setCaret(restored.text.length);
    },
  });

  const trigger = activeReferenceQuery(text, caret);
  const open =
    trigger !== null &&
    trigger.start !== dismissedAt &&
    !completesPickedReference(trigger.query, picked, references);
  const query = open && trigger ? trigger.query : null;
  const matches = useMemo(
    () => (query === null ? [] : rankReferences(query, references)),
    [query, references]
  );
  const selected = matches[Math.min(highlight, matches.length - 1)];
  const mentions = useMemo(
    () => mentionedBuddies(text, picked, references),
    [text, picked, references]
  );
  const referenceMarks = useMemo(() => composerReferenceMarks(text, picked), [text, picked]);
  // Pattern: one-definition (docs/patterns.md#one-definition)
  // A mention initializes the bottom picker from the thread, not an independent default.
  // Guard: explicit thread choice survives a failed attempt; desktop/phone model captures.
  const selections = mentions.map((buddy) => ({
    buddy,
    choice: mentionChoice(buddy, choices, rootId === null ? NO_SEATS : seats),
  }));
  const choosing = selections.find(({ buddy }) => buddy.id === choosingFor);
  const openModel = (buddyId: string) => {
    if (submit === 'button') textareaRef.current?.blur();
    setChoosingFor(buddyId === choosingFor ? null : buddyId);
  };
  // The model picker and the @ menu share the space above the composer.
  const showPicker = open && matches.length > 0 && !choosing;

  // Re-measure placeholders and width changes too: a long reply target can wrap.
  // biome-ignore lint/correctness/useExhaustiveDependencies: text and placeholder trigger re-measurement
  useLayoutEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    const fit = () => {
      node.style.height = 'auto';
      node.style.height = `${Math.min(node.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
      if (!node.value) node.scrollTop = 0;
      const mirror = highlightRef.current;
      if (mirror) mirror.scrollTop = node.scrollTop;
    };
    fit();
    let width = node.clientWidth;
    const observer = new ResizeObserver(() => {
      if (node.clientWidth === width) return;
      width = node.clientWidth;
      fit();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [text, placeholder]);

  const edit = (next: string, nextCaret: number, nextPicked: ChannelReference[] = picked) => {
    setText(next);
    saveDraft(next, nextPicked, choices);
    setCaret(nextCaret);
    setHighlight(0);
    // React's onSelect fires during the same keydown (Enter in the @ menu)
    // with the DOM caret from BEFORE the edit, overwriting the caret set
    // above; the menu then saw an empty query and stayed open after a pick.
    // Re-assert the caret once the DOM selection matches.
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.setSelectionRange(nextCaret, nextCaret);
      setCaret(nextCaret);
    });
  };

  const saveDraft = (
    text: string,
    picked: ChannelReference[],
    choices: ReadonlyMap<string, ConversationConfig>
  ) =>
    draft.setDraft(
      encodeChannelDraft({
        text,
        picked,
        mentionConfigs: [...choices].map(([buddyId, config]) => ({ buddyId, config })),
      })
    );
  const changeChoices = (next: ReadonlyMap<string, ConversationConfig>) => {
    setChoices(next);
    saveDraft(text, picked, next);
  };

  const pick = (reference: ChannelReference) => {
    if (!trigger) return;
    const result = insertReference(text, trigger, reference);
    const nextPicked = [...picked, reference];
    setPicked(nextPicked);
    edit(result.text, result.caret, nextPicked);
    textareaRef.current?.focus();
  };

  const insertAtCaret = (snippet: string) => {
    const node = textareaRef.current;
    const at = node?.selectionStart ?? text.length;
    const before = text.slice(0, at);
    const spacer = before.length === 0 || /\s$/.test(before) ? '' : '\n';
    const inserted = `${spacer}${snippet}\n`;
    edit(before + inserted + text.slice(at), at + inserted.length);
  };

  const upload = (files: readonly File[]) => {
    if (files.length === 0) return;
    setProblem(null);
    setUploading((count) => count + 1);
    const form = new FormData();
    for (const file of files) form.append('files', file);
    void buddyApi<{ files: UploadedFile[] }>(
      `/api/buddies/channels/${encodeURIComponent(channelId)}/media`,
      { method: 'POST', body: form }
    )
      .then((result) => insertAtCaret(result.files.map(mediaMarkdown).join('\n')))
      .catch((cause: unknown) => setProblem(errorText(cause)))
      .finally(() => setUploading((count) => count - 1));
  };

  // Optimistic: the post lands in the channel outbox and the composer clears
  // the moment Send is pressed; waiting for the POST made Send feel broken
  // whenever the server was busy. A failed POST takes the post back out and
  // returns the text, unless the owner has already started a new message.
  const send = () => {
    const body = encodeReferences(text, picked).trim();
    if (!body || uploading > 0 || selections.some(({ choice }) => choice.kind === 'loading'))
      return;
    const mentionConfigs = selections.flatMap(({ buddy, choice }): OwnerPostMentionConfig[] =>
      choice.kind === 'chosen' ? [{ buddyId: buddy.id, config: choice.config }] : []
    );
    const unsent = { text, picked, choices };
    const key = newId();
    outboxSending({
      kind: 'sending',
      key,
      channelId,
      rootId,
      body,
      createdAt: new Date().toISOString(),
    });
    draft.clear();
    setText('');
    setCaret(0);
    setPicked([]);
    setChoices(NO_CHOICES);
    setChoosingFor(null);
    setProblem(null);
    void buddyWrite<PostResult>(
      `/api/buddies/channels/${encodeURIComponent(channelId)}/posts`,
      'POST',
      { key, body, mentionConfigs, ...(rootId === null ? {} : { replyToId: rootId }) }
    )
      .then((result) => {
        outboxSent(key, result.post);
        onPosted(result);
      })
      .catch((cause: unknown) => {
        outboxDrop(new Set([key]));
        setProblem(errorText(cause));
        if (textRef.current.trim().length > 0) return;
        setText(unsent.text);
        setCaret(unsent.text.length);
        setPicked(unsent.picked);
        setChoices(unsent.choices);
        saveDraft(unsent.text, unsent.picked, unsent.choices);
      });
  };

  return (
    <div
      className="channel-composer"
      data-dragging={dragging || undefined}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        if (event.dataTransfer.files.length === 0) return;
        event.preventDefault();
        setDragging(false);
        upload([...event.dataTransfer.files]);
      }}
    >
      {choosing && (
        <MentionModelPopover
          buddy={choosing.buddy}
          choice={choosing.choice}
          catalog={catalog}
          onChange={(config) => changeChoices(new Map(choices).set(choosing.buddy.id, config))}
          onReset={() => {
            const next = new Map(choices);
            next.delete(choosing.buddy.id);
            changeChoices(next);
          }}
          onClose={() => {
            setChoosingFor(null);
            if (submit === 'enter') textareaRef.current?.focus();
          }}
        />
      )}
      {showPicker && (
        <ul className="channel-composer-picker" aria-label="Mention a Buddy or Task">
          {matches.map((reference, index) => (
            <li key={`${reference.kind}:${reference.id}`}>
              <button
                type="button"
                data-selected={reference === selected || undefined}
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(reference);
                }}
                onMouseEnter={() => setHighlight(index)}
              >
                <ReferenceIcon reference={reference} />
                <span className="channel-composer-picker-label ui-truncate">{reference.label}</span>
                <span className="channel-composer-picker-detail ui-truncate ui-muted">
                  {reference.detail}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="channel-composer-field">
        {text.length > 0 && (
          <div ref={highlightRef} className="channel-composer-highlight" aria-hidden="true">
            <ComposerHighlight text={text} marks={referenceMarks} />
          </div>
        )}
        <textarea
          ref={textareaRef}
          className={text.length > 0 ? 'channel-composer-mirrored' : undefined}
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label={placeholder}
          onScroll={(event) => {
            const mirror = highlightRef.current;
            if (mirror) mirror.scrollTop = event.currentTarget.scrollTop;
          }}
          onChange={(event) => {
            setText(event.target.value);
            saveDraft(event.target.value, picked, choices);
            setCaret(event.target.selectionStart);
            setHighlight(0);
            setDismissedAt(null);
          }}
          onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
          onPaste={(event) => {
            const files = [...event.clipboardData.files];
            if (files.length === 0) return;
            event.preventDefault();
            upload(files);
          }}
          onKeyDown={(event) => {
            if (showPicker) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const step = event.key === 'ArrowDown' ? 1 : -1;
                setHighlight((index) => (index + step + matches.length) % matches.length);
                return;
              }
              if ((event.key === 'Enter' || event.key === 'Tab') && selected) {
                event.preventDefault();
                pick(selected);
                return;
              }
              if (event.key === 'Escape' && trigger) {
                event.preventDefault();
                setDismissedAt(trigger.start);
                return;
              }
            }
            if (
              submit === 'enter' &&
              event.key === 'Enter' &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              send();
            }
          }}
        />
      </div>
      <div className="channel-composer-bar ui-row">
        <button
          type="button"
          className="channel-composer-attach"
          onClick={() => fileInputRef.current?.click()}
          title="Attach images or video"
          aria-label="Attach images or video"
        >
          +
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,video/mp4,video/webm,video/quicktime"
          multiple
          hidden
          onChange={(event) => {
            upload([...(event.target.files ?? [])]);
            event.target.value = '';
          }}
        />
        {mentions.length > 0 && (
          <div className="channel-composer-mentions">
            {selections.map(({ buddy, choice }) => (
              <MentionChip
                key={buddy.id}
                buddy={buddy}
                choice={choice}
                catalog={catalog}
                open={buddy.id === choosingFor}
                onOpen={() => openModel(buddy.id)}
              />
            ))}
          </div>
        )}
        <span className="channel-composer-hint ui-truncate ui-muted">
          {problem ? (
            <span className="channel-composer-problem" role="alert">
              {problem}
            </span>
          ) : uploading > 0 ? (
            'Uploading…'
          ) : mentions.length > 0 ? null : (
            <SubmitHint submit={submit} />
          )}
        </span>
        <button
          type="button"
          className="channel-composer-send"
          onClick={send}
          disabled={
            uploading > 0 ||
            text.trim().length === 0 ||
            selections.some(({ choice }) => choice.kind === 'loading')
          }
        >
          Send
        </button>
      </div>
    </div>
  );
}

function ComposerHighlight({
  text,
  marks,
}: {
  text: string;
  marks: ReturnType<typeof composerReferenceMarks>;
}): ReactNode {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [index, mark] of marks.entries()) {
    if (mark.start > cursor) parts.push(text.slice(cursor, mark.start));
    parts.push(
      <mark key={index} data-kind={mark.kind}>
        {text.slice(mark.start, mark.end)}
      </mark>
    );
    cursor = mark.end;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  if (text.endsWith('\n')) parts.push(<br key="trail" />);
  return parts;
}

function MentionChip({
  buddy,
  choice,
  catalog,
  open,
  onOpen,
}: {
  buddy: BuddyReference;
  choice: MentionChoice;
  catalog: ProviderCatalog | null;
  open: boolean;
  onOpen(): void;
}) {
  return (
    <button
      type="button"
      className="channel-composer-mention ui-inline-row"
      data-chosen={choice.kind === 'chosen' || undefined}
      aria-haspopup="dialog"
      aria-expanded={open}
      disabled={
        choice.kind === 'unreported' || choice.kind === 'loading' || choice.kind === 'no-agent'
      }
      data-no-agent={choice.kind === 'no-agent' || undefined}
      title={
        choice.kind === 'loading'
          ? 'Loading this thread’s reply model'
          : choice.kind === 'unreported'
            ? 'This Buddy runs on a harness the picker does not know'
            : choice.kind === 'no-agent'
              ? `No agent is installed, so ${buddy.label} cannot reply. Install Claude Code or Codex from Setup.`
              : `Choose the harness and model for ${buddy.label}’s reply`
      }
      onMouseDown={(event) => event.preventDefault()}
      onClick={onOpen}
    >
      <BuddySigil className="channel-composer-mention-sigil" name={buddy.label} />
      <span className="channel-composer-mention-name ui-truncate">{buddy.label}</span>
      <span className="channel-composer-mention-model ui-muted">
        {choiceLabel(choice, catalog)}
      </span>
    </button>
  );
}

function MentionModelPopover({
  buddy,
  choice,
  catalog,
  onChange,
  onReset,
  onClose,
}: {
  buddy: BuddyReference;
  choice: MentionChoice;
  catalog: ProviderCatalog | null;
  onChange(config: ConversationConfig): void;
  onReset(): void;
  onClose(): void;
}) {
  const value = 'config' in choice ? choice.config : null;
  return (
    <>
      <button
        type="button"
        className="channel-composer-model-backdrop"
        aria-label="Close model picker"
        tabIndex={-1}
        onClick={onClose}
      />
      <dialog
        open
        className="channel-composer-model ui-stack"
        aria-label={`Model for ${buddy.label}`}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          onClose();
        }}
      >
        <div className="channel-composer-model-head ui-row ui-muted">
          <BuddySigil className="channel-composer-mention-sigil" name={buddy.label} />
          <div className="channel-composer-model-title">
            <strong>Reply settings</strong>
            <span>{buddy.label}</span>
          </div>
        </div>
        {catalog && value ? (
          <ConversationConfigPicker
            value={value}
            catalog={catalog}
            reasoningControl="slider"
            // Buddy turns need the Buddy MCP tools.
            providerFilter={(providerId) =>
              catalog.providers.some(
                (provider) => provider.id === providerId && provider.supportsRequiredMcp
              )
            }
            onChange={onChange}
          />
        ) : (
          <p className="channel-composer-model-note ui-muted">Loading harness options…</p>
        )}
        <p className="channel-composer-model-note ui-muted">
          {choice.kind === 'seat'
            ? 'Updates this thread’s current harness, model, and thinking level.'
            : 'Applies to future replies in this thread.'}
        </p>
        <div className="channel-composer-model-actions">
          <button
            type="button"
            onClick={onReset}
            disabled={choice.kind !== 'chosen'}
            aria-label="Discard this unsent model change"
          >
            Reset
          </button>
          <button type="button" className="channel-composer-model-done" onClick={onClose}>
            Done
          </button>
        </div>
      </dialog>
    </>
  );
}

function ReferenceIcon({ reference }: { reference: ChannelReference }) {
  switch (reference.kind) {
    case 'buddy':
      return <BuddySigil className="channel-composer-picker-icon" name={reference.label} />;
    case 'task':
      return (
        <span
          className="channel-composer-picker-icon channel-composer-picker-task ui-muted"
          aria-hidden="true"
        >
          {reference.status === 'done' ? '✓' : '◇'}
        </span>
      );
  }
}

function SubmitHint({ submit }: { submit: ComposerSubmit }) {
  switch (submit) {
    case 'enter':
      return (
        <>
          <kbd>@</kbd> mention a Buddy or Task · <kbd>⇧⏎</kbd> new line
        </>
      );
    case 'button':
      return (
        <>
          <kbd>@</kbd> Mention
        </>
      );
  }
}
