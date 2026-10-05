import type { ConversationConfig } from '@unleashd/shared';
import { useAtomValue } from 'jotai';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { queueMessage, readConversation, setConversationDone } from '../../atoms/actions';
import { setConversationConfig } from '../../atoms/commands';
import {
  commandFor,
  detailOf,
  groupsFamily,
  messagesOf,
  queueOf,
  rowFamily,
  streamFamily,
  transcriptFamily,
} from '../../atoms/conversations';
import { useConversationBodies } from '../../hooks/useConversationBodies';
import { useConversationDraft } from '../../hooks/useConversationDraft';
import { uploadFilesWithDrainRetry } from '../../hooks/usePendingAttachments';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { useProviderCatalog } from '../../hooks/useProviderCatalog';
import { useTurnDiagnostics } from '../../hooks/useTurnDiagnostics';
import { ConfigOverlay } from '../../views/config/ConfigOverlay';
import { modelSummary } from '../../views/config/config-options';
import { BuddyAbout } from './BuddyAboutCard';
import { BuddySigil } from './BuddySigil';
import type { ComposerSubmit } from './ChannelComposer';
import { ChannelLoader } from './ChannelLoader';
import { ChannelMarkdown, TypingDots } from './ChannelMarkdown';
import { CopyLinkButton } from './CopyLinkButton';
import { HarnessPicker } from './HarnessPicker';
import { buddyWrite, errorText } from './api';
import { clockTime, useFollowBottom } from './channel-data';
import { type DmRow, dmRows, lastOwnerText, startFailureText } from './channel-dm';
import { type ChannelTask, mediaMarkdown } from './channel-text';
import './ChannelComposer.css';
import './ChannelDm.css';

// A Buddy DM inside Channels (493c1c7), drawn as a thread: sigil, name, time and ChannelMarkdown
// for both sides, and a channel-style composer. It is still the Buddy's ongoing owner
// conversation. "New chat" starts the next generation without a handoff; earlier generations
// stay above a divider, and a link to an earlier one offers "Latest". An out-of-tokens turn offers
// a retry: a new chat on another harness that resends the owner's last message.
// Desktop and phone differ only in class names (the channel pane vs the phone channel screen).

export type DmFrame = 'desktop' | 'mobile';

// Pattern: table-driven (docs/patterns.md#table-driven)
const FRAMES = {
  desktop: {
    pane: 'channel-browser-pane ui-stack',
    header: 'channel-browser-pane-header ui-row',
    heading: 'channel-browser-pane-title',
    link: 'channel-browser-header-action',
    scroll: 'channel-browser-scroll ui-stack',
    error: 'channel-browser-error',
    list: 'channel-browser-messages',
    day: 'channel-browser-day ui-row',
    lead: 'channel-browser-message channel-browser-message--lead',
    continuation: 'channel-browser-message channel-browser-message--continuation',
    avatar: 'channel-browser-avatar',
    content: 'channel-browser-message-content',
    meta: 'channel-browser-message-heading',
    author: 'channel-browser-author',
    note: 'channel-dm-replying channel-browser-replying ui-row ui-muted',
  },
  mobile: {
    pane: 'mobile-channel ui-stack',
    header: 'mobile-channel-header ui-row',
    heading: 'mobile-channel-header__heading',
    link: 'mobile-channel-header__link ui-muted',
    scroll: 'mobile-channel__scroll',
    error: 'mobile-channel__error',
    list: 'mobile-channel__posts',
    day: 'mobile-channel-day',
    lead: 'mobile-channel-post mobile-channel-post--lead',
    continuation: 'mobile-channel-post mobile-channel-post--continuation',
    avatar: 'mobile-channel-post__avatar',
    content: 'mobile-channel-post__content',
    meta: 'mobile-channel-post__heading',
    author: 'mobile-channel-post__author',
    note: 'mobile-channel__replying',
  },
} as const;
type Frame = (typeof FRAMES)[DmFrame];

/** GET /api/buddies/:buddyId/direct/chain: live DM generations, oldest first. */
export type DirectChain = { buddyId: string; generations: string[] };

export const directChainUrl = (buddyId: string) =>
  `/api/buddies/${encodeURIComponent(buddyId)}/direct/chain`;

/**
 * Start the DM's next generation. Earlier rows remain visible until the new row arrives;
 * ChannelDm then marks them done so the sidebar lists only the current chat.
 */
export async function startNewDirectChat(
  buddyId: string,
  input: { config: ConversationConfig; message?: string }
): Promise<string> {
  const { conversationId } = await buddyWrite<{ conversationId: string }>(
    `/api/buddies/${encodeURIComponent(buddyId)}/direct/new-chat`,
    'POST',
    input
  );
  // Fix guard: marking the visible DM done before its replacement arrives collapses the
  // channel while creation is pending (channel-dm.test.tsx).
  // Keep earlier generations available; the chain view already groups them as one DM.
  return conversationId;
}

// The header's model pick is the Buddy's default: new @mention seats start from the profile
// (channels.ts profileConfig), so a pick that only changed this DM would be forgotten there.
const profileOf = (config: ConversationConfig) => ({
  provider: config.provider,
  model: config.model.mode === 'explicit' ? config.model.modelId : null,
  reasoningEffort: config.reasoning.mode === 'explicit' ? config.reasoning.effort : null,
});
const saveBuddyDefault = (buddyId: string, config: ConversationConfig) =>
  buddyWrite(`/api/buddies/${encodeURIComponent(buddyId)}`, 'PATCH', profileOf(config));

export function ChannelDm({
  conversationId,
  buddyId,
  buddyName,
  buddyRole,
  buddyNames,
  tasks,
  frame,
  linkPath,
  backTo,
  onConversation,
  composeShell,
}: {
  conversationId: string;
  buddyId: string;
  buddyName: string;
  buddyRole: string;
  buddyNames: Readonly<Record<string, string>>;
  tasks: ReadonlyMap<string, ChannelTask>;
  frame: DmFrame;
  linkPath: string;
  /** The phone's Back; the desktop pane has the rail instead. */
  backTo: string | null;
  onConversation(nextId: string): void;
  /** The phone wraps the composer in its fullscreen frame. */
  composeShell(composer: ReactNode): ReactNode;
}) {
  const f = FRAMES[frame];
  const row = useAtomValue(rowFamily(conversationId));
  const transcript = useAtomValue(transcriptFamily(conversationId));
  const configCommand = useAtomValue(commandFor(conversationId)).config;
  const bodies = useConversationBodies(conversationId);
  const { catalog } = useProviderCatalog();
  const buddyHarness = (providerId: string) =>
    catalog?.providers.some((p) => p.id === providerId && p.supportsRequiredMcp) ?? false;
  const [modelOpen, setModelOpen] = useState(false);
  // A pick on another harness cannot change this chat (a started session keeps its provider), so
  // it waits here until "New convo" confirms it.
  const [harnessDraft, setHarnessDraft] = useState<ConversationConfig | null>(null);
  const [defaultError, setDefaultError] = useState<string | null>(null);
  const stream = useAtomValue(streamFamily(conversationId));
  const groups = useAtomValue(groupsFamily(conversationId));
  const chain = usePolledFetch<DirectChain>(directChainUrl(buddyId), 15_000);
  const running = row !== null && row.run !== 'idle';
  const diagnostics = useTurnDiagnostics(conversationId);
  const queue = queueOf(transcript);
  const messages = messagesOf(transcript);
  const follow = useFollowBottom(messages.length + queue.length, groups, null);
  const generations = chain.data?.generations ?? [conversationId];
  const latest = generations.at(-1) ?? conversationId;
  useEffect(() => {
    // Fix guard: wait for the new row before hiding older sidebar generations.
    // Marking them during the POST collapsed the DM while the new row was still pending.
    if (row === null || latest !== conversationId || chain.data === null) return;
    for (const id of chain.data.generations.slice(0, -1)) {
      if (readConversation(id)?.done === false) setConversationDone(id, true);
    }
  }, [row, latest, conversationId, chain.data]);
  // An earlier generation shows alone, with a way to the latest; the latest shows every one.
  const shown = latest === conversationId ? generations : [conversationId];
  const newChat = async (input: { config: ConversationConfig; message?: string }) => {
    const next = await startNewDirectChat(buddyId, input);
    await chain.refetch();
    follow.pin();
    onConversation(next);
  };
  const retryText = lastOwnerText(messages);
  const detail = detailOf(transcript);
  const config = detail?.config.config ?? null;
  const configSaving = configCommand?.state.tag === 'sent';
  const configError = configCommand?.state.tag === 'rejected' ? configCommand.state.message : null;
  const outOfTokens =
    !running && diagnostics.attempt?.terminalCause === 'out_of_tokens' && retryText !== null;
  const refreshContextControl =
    latest === conversationId && messages.length + queue.length > 0 && config !== null ? (
      <button
        type="button"
        className="channel-inline-action"
        title={`Start a fresh chat with ${buddyName} to save token cost. Saved Buddy memories carry forward; this chat remains above it.`}
        onClick={() => void newChat({ config })}
      >
        Refresh context
      </button>
    ) : null;
  const shownConfig = harnessDraft ?? config;
  const modelControl = (
    <button
      type="button"
      className="channel-dm-model channel-inline-action ui-truncate"
      title="Set the default model for this DM and every @mention of this Buddy"
      aria-label={`Default model for ${buddyName}: ${config ? modelSummary(config, catalog) : 'loading'}`}
      aria-haspopup="dialog"
      aria-expanded={modelOpen}
      disabled={config === null}
      onClick={() => setModelOpen(true)}
    >
      Model: {config ? modelSummary(config, catalog) : 'Loading'}
      {configSaving ? ' …' : ''} ▾
    </button>
  );
  const closeModel = () => {
    setModelOpen(false);
    setHarnessDraft(null);
    setDefaultError(null);
  };
  const pickModel = (next: ConversationConfig) => {
    if (!detail || config === null) return;
    setDefaultError(null);
    if (next.provider !== config.provider) {
      setHarnessDraft(next);
      return;
    }
    setHarnessDraft(null);
    setConversationConfig({
      conversationId,
      expectedRevision: detail.config.revision,
      patch: { kind: 'replace', config: next },
    });
    saveBuddyDefault(buddyId, next).catch((cause: unknown) => setDefaultError(errorText(cause)));
  };
  const startConvoOnDraft = () => {
    if (harnessDraft === null) return;
    const next = harnessDraft;
    saveBuddyDefault(buddyId, next)
      .then(() => newChat({ config: next }))
      .then(closeModel, (cause: unknown) => setDefaultError(errorText(cause)));
  };
  return (
    <section className={f.pane} aria-label={`Direct message with ${buddyName}`}>
      <header className={f.header} style={frame === 'mobile' ? { flexWrap: 'wrap' } : undefined}>
        {backTo !== null && (
          <Link className="mobile-channel-header__back" to={backTo} aria-label="Back">
            ‹
          </Link>
        )}
        <div className={f.heading} style={frame === 'mobile' ? { flex: 1 } : undefined}>
          {frame === 'desktop' ? <h2>{buddyName}</h2> : <h1>{buddyName}</h1>}
        </div>
        <BuddyAbout
          buddyId={buddyId}
          name={buddyName}
          role={buddyRole}
          facts={config ? [modelSummary(config, catalog)] : []}
        />
        {frame === 'mobile' && (
          <CopyLinkButton className={f.link} path={linkPath} label="Copy link to DM" />
        )}
        {frame === 'mobile' ? (
          <div className="mobile-channel-header__dm-actions ui-row">
            {refreshContextControl}
            {modelControl}
          </div>
        ) : (
          <>
            {refreshContextControl}
            {modelControl}
            <CopyLinkButton className={f.link} path={linkPath} label="Copy link to DM" />
          </>
        )}
      </header>
      {modelOpen && (
        <ConfigOverlay
          presentation={frame === 'mobile' ? 'sheet' : 'popover'}
          value={shownConfig}
          onClose={closeModel}
          onChange={pickModel}
          holdOpen={harnessDraft !== null}
          picker={{
            disabled: configSaving,
            defaults: 'inline',
            providerFilter: buddyHarness,
          }}
          notes={[
            {
              tone: 'info',
              text: 'This is the default model for this DM and every @mention of this Buddy.',
            },
            ...(harnessDraft
              ? [
                  {
                    tone: 'info' as const,
                    text: 'Changing the harness clears this chat’s context and starts a new convo. Saved Buddy memory persists.',
                  },
                ]
              : []),
            ...(configSaving ? [{ tone: 'info' as const, text: 'Saving…' }] : []),
            ...(configError ? [{ tone: 'error' as const, text: configError }] : []),
            ...(defaultError ? [{ tone: 'error' as const, text: defaultError }] : []),
          ]}
          actions={
            harnessDraft && (
              <button
                type="button"
                className="channel-composer-model-done"
                onClick={startConvoOnDraft}
              >
                New convo
              </button>
            )
          }
        />
      )}
      <div className={f.scroll} ref={follow.scrollRef} onScroll={follow.onScroll}>
        {bodies.error && (
          <p className={f.error} role="alert">
            {bodies.error}
          </p>
        )}
        {row === null ? (
          <ChannelLoader label="Opening DM…" />
        ) : (
          <div className="channel-dm-timeline" ref={follow.contentRef}>
            {shown.map((id, index) => (
              <DmGeneration
                key={id}
                conversationId={id}
                previousId={index > 0 ? shown[index - 1] : null}
                frame={f}
                buddyName={buddyName}
                buddyNames={buddyNames}
                tasks={tasks}
              />
            ))}
          </div>
        )}
        {running && stream.length === 0 && (
          <p className={f.note}>
            <TypingDots />
            <span>{buddyName} is replying…</span>
          </p>
        )}
        {outOfTokens && (
          <HarnessPicker
            label="Retry with a different harness"
            note="This harness is out of tokens. The retry opens a new chat on the one you pick and resends your last message."
            confirm="Retry"
            seed={null}
            excluded={row?.provider ?? null}
            buddy
            onConfirm={(config) => newChat({ config, message: retryText })}
            placement="above"
          />
        )}
        {latest !== conversationId && (
          <button
            type="button"
            className="channel-inline-action"
            onClick={() => onConversation(latest)}
          >
            Latest chat
          </button>
        )}
      </div>
      {composeShell(
        <DmComposer
          conversationId={conversationId}
          placeholder={`Message ${buddyName}`}
          submit={frame === 'desktop' ? 'enter' : 'button'}
          ready={row !== null}
          onSent={follow.pin}
        />
      )}
    </section>
  );
}

function DmGeneration({
  conversationId,
  previousId,
  frame,
  buddyName,
  buddyNames,
  tasks,
}: {
  conversationId: string;
  /** The generation before this one; null for the first, which has no divider. */
  previousId: string | null;
  frame: Frame;
  buddyName: string;
  buddyNames: Readonly<Record<string, string>>;
  tasks: ReadonlyMap<string, ChannelTask>;
}) {
  useConversationBodies(conversationId);
  const groups = useAtomValue(groupsFamily(conversationId));
  const queue = queueOf(useAtomValue(transcriptFamily(conversationId)));
  const { catalog } = useProviderCatalog();
  const generation = useAtomValue(rowFamily(conversationId));
  const divider = previousId !== null;
  const config = detailOf(useAtomValue(transcriptFamily(conversationId)))?.config.config ?? null;
  const before = detailOf(useAtomValue(transcriptFamily(previousId ?? conversationId)))?.config
    .config;
  const summary = (c: ConversationConfig) => modelSummary(c, catalog);
  const changedTo =
    config && before && (config.provider !== before.provider || summary(config) !== summary(before))
      ? `${config.provider} · ${summary(config)}`
      : null;
  const attempt = detailOf(useAtomValue(transcriptFamily(conversationId)))?.latestAttempt ?? null;
  const rows = dmRows(
    groups,
    queue,
    divider && generation
      ? {
          at: new Date(generation.createdAt),
          label: changedTo
            ? `New chat · harness and model changed to ${changedTo}`
            : 'Context refreshed · New chat',
        }
      : undefined,
    config && attempt?.terminalCause === 'spawn_failed'
      ? startFailureText(config.provider)
      : undefined
  );
  return (
    <>
      {rows.length === 0 && !divider ? (
        <p className={frame.note}>Send a message to start the conversation.</p>
      ) : (
        <ol className={frame.list}>
          {rows.map((row) => (
            <DmRowView
              key={row.key}
              row={row}
              frame={frame}
              name={
                (row.kind === 'lead' || row.kind === 'continuation') && row.author === 'buddy'
                  ? buddyName
                  : 'You'
              }
              buddyNames={buddyNames}
              tasks={tasks}
            />
          ))}
        </ol>
      )}
    </>
  );
}

function DmRowView({
  row,
  frame,
  name,
  buddyNames,
  tasks,
}: {
  row: DmRow;
  frame: Frame;
  name: string;
  buddyNames: Readonly<Record<string, string>>;
  tasks: ReadonlyMap<string, ChannelTask>;
}) {
  switch (row.kind) {
    case 'day':
      return (
        <li className={frame.day}>
          <span>{row.label}</span>
        </li>
      );
    case 'notice':
      return <li className="channel-dm-notice">{row.label}</li>;
    case 'failure':
      return (
        <li className="channel-dm-failure" role="alert">
          {row.label}
        </li>
      );
    case 'lead':
      return (
        <li className={frame.lead}>
          <BuddySigil className={frame.avatar} name={name} />
          <div className={frame.content}>
            <div className={frame.meta}>
              <span className={frame.author}>{name}</span>
              <time dateTime={row.at}>{clockTime(row.at)}</time>
            </div>
            <ChannelMarkdown body={row.body} buddyNames={buddyNames} tasks={tasks} />
          </div>
        </li>
      );
    case 'continuation':
      return (
        <li className={frame.continuation}>
          <div className={frame.content}>
            <ChannelMarkdown body={row.body} buddyNames={buddyNames} tasks={tasks} />
          </div>
        </li>
      );
  }
}

const MAX_TEXTAREA_HEIGHT = 240;

// The thread's chat box, sending into the DM conversation instead of posting to a channel. Same
// field, attach and Send; attachments land as the image markdown a post uses.
function DmComposer({
  conversationId,
  placeholder,
  submit,
  ready,
  onSent,
}: {
  conversationId: string;
  placeholder: string;
  submit: ComposerSubmit;
  ready: boolean;
  onSent(): void;
}) {
  const [text, setText] = useState('');
  const [uploading, setUploading] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const draft = useConversationDraft({
    conversationId,
    textareaRef,
    controlled: true,
    autoFocus: false,
    maxHeight: MAX_TEXTAREA_HEIGHT,
    onDraftLoaded: setText,
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: text is the re-measure trigger
  useLayoutEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [text]);
  const change = (next: string) => {
    setText(next);
    draft.setDraft(next);
  };
  const upload = (files: File[]) => {
    if (files.length === 0) return;
    setProblem(null);
    setUploading((count) => count + 1);
    uploadFilesWithDrainRetry(conversationId, files)
      .then((result) => {
        const media = result.files.map(mediaMarkdown).join('\n');
        change(text.trim() ? `${text}\n${media}` : media);
      })
      .catch((cause: unknown) => setProblem(errorText(cause)))
      .finally(() => setUploading((count) => count - 1));
  };
  const send = () => {
    const body = text.trim();
    if (!body || uploading > 0 || !ready) return;
    draft.clear();
    setText('');
    setProblem(null);
    onSent();
    queueMessage(conversationId, body).catch((cause: unknown) => {
      setProblem(errorText(cause));
      change(body);
    });
  };
  return (
    <div className="channel-composer">
      <div className="channel-composer-field">
        <textarea
          ref={textareaRef}
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(event) => change(event.target.value)}
          onPaste={(event) => {
            const files = [...event.clipboardData.files];
            if (files.length === 0) return;
            event.preventDefault();
            upload(files);
          }}
          onKeyDown={(event) => {
            if (submit !== 'enter' || event.key !== 'Enter' || event.shiftKey) return;
            if (event.nativeEvent.isComposing) return;
            event.preventDefault();
            send();
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
        <span className="channel-composer-hint ui-truncate ui-muted">
          {problem ? (
            <span className="channel-composer-problem" role="alert">
              {problem}
            </span>
          ) : uploading > 0 ? (
            'Uploading…'
          ) : null}
        </span>
        <button
          type="button"
          className="channel-composer-send"
          onClick={send}
          disabled={!ready || uploading > 0 || text.trim().length === 0}
        >
          Send
        </button>
      </div>
    </div>
  );
}
