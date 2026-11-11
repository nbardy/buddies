// Solarized Dark theme for syntax highlighting - matches app aesthetic
// highlight.js + katex stylesheets load lazily with their plugins —
// see utils/lazyMarkdownPlugins.ts. Do not re-add a static CSS import here.
import type { BuddyContext, ConversationRow, QueuedMessage } from '@unleashd/shared';
import { useAtomValue } from 'jotai';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { clearQueue, endConversation, interruptAndSend, queueMessage } from '../atoms/actions';
import { createConversation, setConversationConfig } from '../atoms/commands';
import {
  childRowsFamily,
  commandFor,
  connectionAtom,
  detailOf,
  groupsFamily,
  listField,
  loadCompleteOf,
  messagesOf,
  queueOf,
  rowFamily,
  streamFamily,
  subAgentsOf,
  transcriptFamily,
} from '../atoms/conversations';
import { forkConversation } from '../atoms/fork-actions';
import { markMessagesSeen } from '../atoms/ui';
import { useComposerSubmission } from '../hooks/useComposerSubmission';
import { useConversationBodies } from '../hooks/useConversationBodies';
import { useConversationDraft } from '../hooks/useConversationDraft';
import { usePendingAttachments } from '../hooks/usePendingAttachments';
import { useProviderCatalog } from '../hooks/useProviderCatalog';
import { useRestartRecovery } from '../hooks/useRestartRecovery';
import { useSavedPrompts } from '../hooks/useSavedPrompts';
import { useTurnDiagnostics } from '../hooks/useTurnDiagnostics';
import { RestartRecoveryPrompt } from '../restart/RestartRecoveryPrompt';
import { SwarmConvoPrefix } from '../swarm';
import { copyText } from '../utils/clipboard';
import { buildThreadTranscript } from '../utils/conversation-transcript';
import { buildUnifiedSubAgents } from '../utils/subAgents';
import { formatTimeAgo } from '../utils/time';
import {
  shouldPresentTurnAttempt,
  shouldShowTypingIndicator,
  turnDiagnosticsFromAttempt,
} from '../utils/turn-diagnostics';
import { ComposerAttachments, UploadErrorNotice } from '../views/composer/ComposerAttachments';
import { PromptPalette } from '../views/composer/PromptPalette';
import { SendControls } from '../views/composer/SendControls';
import { ConfigOverlay } from '../views/config/ConfigOverlay';
import { QueuedMessages } from '../views/conversation/QueuedMessages';
import { ResumeSource } from '../views/conversation/ResumeSource';
import { SubAgentPanel } from '../views/conversation/SubAgentPanel';
import { TurnStatus } from '../views/conversation/TurnStatus';
import { COPY_GLYPH } from '../views/transcript/markdown-components';
import { BuddyConvoHeader } from './BuddyConvoHeader';
import { BuilderChatRoute } from './buddies/BuilderChatRoute';
import { lastOwnerText } from './buddies/channel-dm';
import { DmChannelsNotice } from './buddies/DmChannelsNotice';
import { HarnessPicker } from './buddies/HarnessPicker';
import { ContextBreakdownMeter } from './ContextBreakdownMeter';
import { VirtualizedMessageList } from './VirtualizedMessageList';
import './Chat.css';
import { useTimeTick } from '../hooks/useTimeTick';
import { rowBuddy } from '../utils/conversation-row';
import { shortenHomePath } from '../utils/directories';

const BUDDY_STARTER_PROMPTS = [
  'Create a Buddy who owns product research for my team.',
  'Create a team for this workspace: a researcher, a designer, and an engineer.',
] as const;

// The Buddy header needs only the ids the row carries (run data stays on the server, T09).
function headerBuddyContext(kind: ConversationRow['kind'] | undefined): BuddyContext | undefined {
  return kind?.t === 'buddy'
    ? { buddyId: kind.buddyId, workspaceId: kind.workspaceId, buddyProjectId: null }
    : undefined;
}

/**
 * Returns a live-updating "time ago" string for a Date.
 * Ticks every 30s to stay reasonably current without excessive renders.
 */
function useTimeAgo(date: Date | undefined): string | null {
  useTimeTick();
  if (!date) return null;
  return formatTimeAgo(date);
}

// The desktop /chat/:id page.
export function ChatRoute() {
  const { id = '' } = useParams<{ id: string }>();
  return (
    <BuilderChatRoute id={id}>
      <Chat id={id} />
    </BuilderChatRoute>
  );
}

// One conversation, by id: the /chat page and the DM pane inside the desktop
// channels view (ChannelBrowser) both render it.
export function Chat({ id }: { id: string }) {
  const navigate = useNavigate();

  // Per-ID atoms — only re-render when THIS conversation changes, not others
  const conversation = useAtomValue(rowFamily(id ?? ''));
  const transcript = useAtomValue(transcriptFamily(id ?? ''));
  const detail = detailOf(transcript);
  const messages = messagesOf(transcript);
  const subAgents = subAgentsOf(transcript);
  const { loaded: conversationDetailsLoaded, error: detailLoadError } = useConversationBodies(
    id || null
  );
  const conversationLoadComplete = loadCompleteOf(useAtomValue(connectionAtom).server);
  const { create: pendingCreation, config: pendingConfigCommand } = useAtomValue(
    commandFor(id ?? '')
  );
  const configIsSaving = pendingConfigCommand?.state.tag === 'sent';
  const configError =
    pendingConfigCommand?.state.tag === 'rejected' ? pendingConfigCommand.state.message : null;
  const streamingText = useAtomValue(streamFamily(id ?? ''));
  const childSessionConversations = useAtomValue(childRowsFamily(id ?? ''));
  // idSet, not order: a re-sort of other conversations must not re-render this chat.
  const hasConversations = useAtomValue(listField('idSet')).size > 0;
  const queue: readonly QueuedMessage[] = queueOf(transcript);
  const resumedFromConversationId = conversation?.resumedFrom ?? '';
  const resumedFromConversation = useAtomValue(rowFamily(resumedFromConversationId));

  const { catalog, isLoading: catalogIsLoading, retry: retryCatalog } = useProviderCatalog();
  // Header shows a compact "Opus 5 · High" summary; the full provider/model/
  // reasoning pickers only mount once the summary is expanded.
  const [headerConfigExpanded, setHeaderConfigExpanded] = useState(false);

  const {
    savePrompt,
    prompts: savedPrompts,
    fuzzySearch,
    incrementUsage,
    deletePrompt,
  } = useSavedPrompts();
  const [hasInput, setHasInput] = useState(false);
  const [threadCopied, setThreadCopied] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastMessageRef = useRef<HTMLDivElement>(null);

  // Portable draft persistence — same hook mobile uses (localStorage `draft:{id}`).
  // Handles debounced save, flush on pagehide/visibility/HMR, and focus restore
  // without stale-closure bug (refs only).
  const draft = useConversationDraft({
    conversationId: id,
    textareaRef,
    maxHeight: 300,
    autoFocus: true,
    onDraftLoaded: (value) => setHasInput(value.trim().length > 0),
    onDraftChange: (value) => setHasInput(value.trim().length > 0),
  });
  const { setDraft: setDraftValue } = draft;

  // Shared attachment lifecycle — same hook mobile ComposerMobile uses so
  // pending files survive refresh, framing is identical, and upload goes
  // through one path (POST /api/upload). See hooks/usePendingAttachments.ts.
  const attachments = usePendingAttachments(id);
  const {
    pendingFiles,
    isUploading,
    handleFilesUpload,
    uploadError,
    dismissUploadError,
    removeFile: removePendingFile,
    handlePaste,
  } = attachments;

  // One send path, shared with mobile. Owns take/clear/deliver/restore and the
  // rejection message; see hooks/useComposerSubmission.ts.
  const {
    submit,
    error: submissionError,
    setError: setSubmissionError,
  } = useComposerSubmission(id, draft, attachments);

  // A row exists only once the server acknowledged the creation.
  const confirmed = conversation !== null;
  // Persistent Builder identity — canonical kind, never the transient
  // ?helper=buddies query param (lost on refresh/sidebar nav, which made
  // Builder threads indistinguishable from normal chats).
  const isBuddyBuilder = conversation?.kind.t === 'builder';
  // A Buddy DM generation points to Channels (DmChannelsNotice renders only for DM chats).
  const dmBuddy = rowBuddy(conversation);
  const isBuddyBuilderHelper = confirmed && isBuddyBuilder;
  const isRunning = conversation?.run === 'running' || conversation?.run === 'streaming';
  const isStreaming = conversation?.run === 'streaming';
  const runtimeTurnActive = isRunning || isStreaming;
  const { attempt: latestTurnAttempt } = useTurnDiagnostics(id);
  const restartRecovery = useRestartRecovery(id ?? '', latestTurnAttempt, runtimeTurnActive);
  // A plain chat that ran out of tokens can rerun its last message on another harness. Buddy
  // conversations retry inside Channels (the DM's new chat, the thread's new seat).
  const outOfTokensRetry =
    conversation?.kind.t === 'chat' &&
    !runtimeTurnActive &&
    latestTurnAttempt?.terminalCause === 'out_of_tokens'
      ? lastOwnerText(messages)
      : null;
  const turnDiagnostics =
    latestTurnAttempt && shouldPresentTurnAttempt(latestTurnAttempt, runtimeTurnActive)
      ? turnDiagnosticsFromAttempt(latestTurnAttempt)
      : null;
  const canChangeHarness =
    confirmed &&
    (conversation?.messageCount ?? 0) === 0 &&
    queue.length === 0 &&
    !isRunning &&
    !isStreaming;

  const currentMessage = queue.find((m) => m.status === 'sending') ?? null;
  const pendingQueue = queue.filter((m) => m.status === 'pending');
  // Enter should switch to interrupt mode as soon as a turn is in flight,
  // including the short pre-stream window where the queue marks it "sending"
  // before provider status flips to isRunning/isStreaming.
  const hasActiveTurn = confirmed && (isRunning || isStreaming || currentMessage !== null);
  const hasContent = hasInput || pendingFiles.length > 0;

  const {
    getRootProps,
    getInputProps,
    isDragActive,
    open: openFilePicker,
  } = useDropzone({
    onDrop: handleFilesUpload,
    noClick: true,
    noKeyboard: true,
  });

  useEffect(() => {
    if (id && !conversation && !pendingCreation && hasConversations) {
      if (!conversationLoadComplete) return;
      void navigate('/chats');
    }
  }, [id, conversation, pendingCreation, hasConversations, conversationLoadComplete, navigate]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
        e.preventDefault();
        setShowPalette(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleScrollStateChange = useCallback((_isNearBottom: boolean, showButton: boolean) => {
    setShowScrollToBottom(showButton);
  }, []);

  const scrollToBottomRef = useRef<(() => void) | null>(null);

  // setDraft auto-heights the textarea and reports hasInput via onDraftChange.
  const handleInput = () => {
    const textarea = textareaRef.current;
    if (textarea) setDraftValue(textarea.value);
  };

  // IMPORTANT: All hooks must be called before any early return.
  const activityAt = conversation && conversation.messageCount > 0 ? conversation.activityAt : null;
  const lastMessageTime = useMemo(
    () => (activityAt === null ? undefined : new Date(activityAt)),
    [activityAt]
  );

  const timeAgo = useTimeAgo(lastMessageTime);

  const messageGroups = useAtomValue(groupsFamily(id ?? ''));

  // The server sets a swarm prefix only on chats, so no kind check here.
  const visibleSwarmDebugPrefix = detail?.swarmDebugPrefix ?? null;
  // A fresh object each render would invalidate VirtualizedMessageList's memos
  // on every streaming chunk; the row kind only changes on structural updates.
  const rowKind = conversation?.kind;
  const buddyContext = useMemo(() => headerBuddyContext(rowKind), [rowKind]);
  const unifiedSubAgents = useMemo(
    () => buildUnifiedSubAgents(subAgents, childSessionConversations),
    [subAgents, childSessionConversations]
  );

  const conversationConfig = detail?.config.config ?? null;

  // Transcript and fork draft live in utils/conversation-transcript.ts so the
  // mobile conversation header produces byte-identical output. The swarm-debug
  // prefix strip that messageGroups does for display happens in there too.
  const threadCopyText = useMemo(
    () =>
      conversation && detail ? buildThreadTranscript({ row: conversation, detail, messages }) : '',
    [conversation, detail, messages]
  );

  // Was an unguarded navigator.clipboard.writeText: secure-context gated, so
  // over a LAN IP it threw and the button silently never flipped to copied.
  const handleCopyThread = useCallback(async () => {
    const copied = await copyText(threadCopyText);
    if (!copied) {
      setSubmissionError('Could not copy the thread to the clipboard.');
      return;
    }
    setThreadCopied(true);
    setTimeout(() => setThreadCopied(false), 2000);
  }, [threadCopyText, setSubmissionError]);

  // Chat "Fork": new conversation + resumedFromConversationId + draft context.
  // The server upgrades the first send to a native CLI session fork only when
  // source and target share a FORK_CAPABLE_PROVIDERS provider.
  // Shared with the mobile conversation header via atoms/fork-actions.ts —
  // one fork implementation, so the two trees cannot drift on draft contents
  // or lineage.
  const handleForkThread = useCallback(() => {
    if (!conversation || !detail || !id) return;
    void navigate(`/chat/${forkConversation({ row: conversation, detail, messages })}`);
  }, [conversation, detail, messages, id, navigate]);

  if (!conversation) {
    return (
      <div className="chat-view ui-stack">
        <div className="chat-header ui-row">
          <div className="chat-title ui-row">
            {pendingCreation ? 'Creating conversation…' : 'Select a conversation'}
          </div>
        </div>
        <div className="messages-container">
          <div className="empty-state ui-muted">
            {pendingCreation?.state.tag === 'rejected'
              ? `Creation failed: ${pendingCreation.state.message}`
              : pendingCreation
                ? `Starting ${pendingCreation.args.config.provider} in ${pendingCreation.args.workingDirectory}`
                : 'Select a conversation from the sidebar or create a new one.'}
          </div>
        </div>
      </div>
    );
  }

  const dirDisplay = shortenHomePath(conversation.cwd);

  if (!conversationDetailsLoaded) {
    return (
      <div className="chat-view ui-stack">
        <div className="chat-header ui-row">
          <div className="chat-title ui-row">
            <span className="chat-dir ui-truncate ui-muted">{dirDisplay}</span>
          </div>
        </div>
        <div className="messages-container">
          <div className="empty-state ui-muted">
            {detailLoadError ?? 'Loading conversation history…'}
          </div>
        </div>
      </div>
    );
  }

  const headerProvider = catalog?.providers.find(
    (provider) => provider.id === conversationConfig?.provider
  );
  // Buddy and Builder turns need fail-closed MCP state tools, so only
  // supportsRequiredMcp providers are offered. getBuddyContext covers the
  // buddy kind only; the Builder kind needs its own check — the server gate
  // (runtime preflight) enforces both, this menu just steers early.
  const requiresBuddyMcp = conversation.kind.t === 'buddy' || conversation.kind.t === 'builder';
  // The server's resolution names the model and effort; the header only
  // looks up display names (no client-side re-derivation, T09).
  const resolution = detail?.config.resolution;
  const resolvedConfig =
    resolution?.status === 'resolved' ? resolution.value : resolution?.lastResolved;
  const resolvedHeaderModelId = resolvedConfig?.modelId;
  const resolvedHeaderModel = headerProvider?.models.find(
    (model) => model.id === resolvedHeaderModelId
  );
  const headerReasoning = conversationConfig?.reasoning;
  const headerEffort =
    headerReasoning?.mode === 'explicit'
      ? headerReasoning.effort
      : headerReasoning?.mode === 'disabled'
        ? null
        : (resolvedConfig?.reasoningEffort ?? null);
  const headerReasoningLabel =
    headerReasoning?.mode === 'explicit'
      ? headerReasoning.effort
      : headerReasoning?.mode === 'disabled'
        ? 'No reasoning'
        : headerEffort
          ? `Default · ${headerEffort}`
          : 'Default';
  const headerModelLabel = resolvedHeaderModel?.displayName ?? resolvedHeaderModelId ?? 'Default';
  // "Claude Opus 5" under the Claude provider is redundant — the summary drops
  // the vendor prefix and shows "Opus 5". Full name stays in the expanded row.
  const headerModelShortLabel =
    headerProvider && headerModelLabel.startsWith(`${headerProvider.displayName} `)
      ? headerModelLabel.slice(headerProvider.displayName.length + 1)
      : headerModelLabel;
  const headerEffortShortLabel = headerEffort
    ? headerEffort.charAt(0).toUpperCase() + headerEffort.slice(1)
    : null;

  const updateHeaderConfig = (patch: Parameters<typeof setConversationConfig>[0]['patch']) => {
    setConversationConfig({
      conversationId: conversation.id,
      expectedRevision: detail?.config.revision ?? 0,
      patch,
    });
  };

  // Optimistic send: the server only acknowledges after ensureReady plus
  // turn-spawn setup, which can take seconds on a loaded box. Gating the
  // textbox and Send button on that round trip froze the composer with no
  // feedback, so the composer empties on submit and the queue strip carries
  // the in-flight state. Admission (`confirmed`) is enforced
  // at the two entry points below — the Send button and handleKeyDown.
  const handleQueue = () => submit(queueMessage);
  const handleInterrupt = () => submit(interruptAndSend);

  const handleClearQueue = () => {
    if (id) clearQueue(id);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Tab' && !e.shiftKey && hasContent && confirmed) {
      e.preventDefault();
      void handleQueue();
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey && hasContent && confirmed) {
      e.preventDefault();
      if (hasActiveTurn) {
        void handleInterrupt();
      } else {
        void handleQueue();
      }
    }
  };

  const handleSavePrompt = () => {
    const content = draft.getDraft().trim();
    if (content) savePrompt(content);
  };

  return (
    <div className={`chat-view ui-stack${isDragActive ? ' drag-active' : ''}`} {...getRootProps()}>
      <input {...getInputProps()} />
      {isDragActive && (
        <div className="dropzone-overlay ui-row">
          <div className="dropzone-overlay-content ui-stack">
            <span className="dropzone-overlay-icon">&#x1F4CE;</span>
            <span className="dropzone-overlay-text">Drop files here</span>
          </div>
        </div>
      )}
      <div className="chat-header ui-row">
        <div className="chat-title ui-row">
          <div className="header-config-controls ui-inline-row">
            <button
              type="button"
              className={`chat-config-summary ui-control ui-inline-row${headerConfigExpanded ? ' expanded' : ''}`}
              title={`${headerProvider?.displayName ?? conversation.provider} · ${headerModelLabel} · ${headerReasoningLabel}`}
              aria-expanded={headerConfigExpanded}
              aria-haspopup="dialog"
              onClick={() => {
                if (!headerConfigExpanded && !catalog && !catalogIsLoading) retryCatalog();
                setHeaderConfigExpanded((open) => !open);
              }}
            >
              <span className="chat-config-summary-model">{headerModelShortLabel}</span>
              {headerEffortShortLabel && (
                <span className="chat-config-summary-effort ui-muted">
                  {headerEffortShortLabel}
                </span>
              )}
              <span className="model-picker-caret">&#x25BE;</span>
            </button>
          </div>
          {headerConfigExpanded && (
            <ConfigOverlay
              presentation="popover"
              value={conversationConfig}
              onClose={() => setHeaderConfigExpanded(false)}
              onChange={(config) => updateHeaderConfig({ kind: 'replace', config })}
              picker={{
                disabled: configIsSaving,
                providerDisabled: !canChangeHarness,
                defaults: 'inline',
                providerFilter: (providerId) =>
                  !requiresBuddyMcp ||
                  providerId === conversation.provider ||
                  (catalog?.providers.some(
                    (provider) => provider.id === providerId && provider.supportsRequiredMcp
                  ) ??
                    false),
              }}
              notes={[
                ...(canChangeHarness
                  ? []
                  : [
                      {
                        tone: 'info' as const,
                        text: 'Harness is fixed once a conversation starts.',
                      },
                    ]),
                ...(configIsSaving ? [{ tone: 'info' as const, text: 'Saving…' }] : []),
                ...(configError ? [{ tone: 'error' as const, text: configError }] : []),
              ]}
            />
          )}
          <Link
            className="chat-dir ui-truncate ui-muted"
            to={`/?folders=${encodeURIComponent(conversation.cwd)}`}
          >
            {dirDisplay}
          </Link>
          {/* One home for context usage: beside the folder, for buddy and plain
              threads alike. It used to live inside BuddyConvoHeader for buddy
              conversations, so the same number sat in two different places. */}
          <ContextBreakdownMeter conversationId={conversation.id} />
          {timeAgo && <span className="chat-time-ago ui-muted">{timeAgo}</span>}
          {conversation.resumedFrom && (
            <ResumeSource
              presentation="icon"
              sourceConversationId={conversation.resumedFrom}
              sourceConversation={resumedFromConversation}
            />
          )}
          {isBuddyBuilder && (
            <span className="buddy-helper-kicker buddy-helper-kicker--header">Buddy Builder</span>
          )}
        </div>
        <div className="header-status ui-row">
          {dmBuddy !== null && (
            <DmChannelsNotice
              conversationId={conversation.id}
              buddy={dmBuddy}
              className="dm-channels-notice ui-row ui-muted"
            />
          )}
          <button
            type="button"
            className="fork-thread-btn"
            onClick={handleForkThread}
            title="Fork into a new thread (soft handoff — paste/draft context, not CLI --fork)"
          >
            Fork
          </button>
          <button
            type="button"
            className={`copy-thread-btn${threadCopied ? ' copied' : ''}`}
            onClick={handleCopyThread}
            title="Copy full thread"
          >
            {COPY_GLYPH[threadCopied ? 'copied' : 'idle']}
          </button>
          {!confirmed && <div className="ready-badge ui-inline-row waiting">Starting...</div>}
          {pendingQueue.length > 0 && (
            <div className="queue-badge ui-inline-row" title="Messages waiting to send">
              {pendingQueue.length} queued
              <button
                type="button"
                className="clear-queue-btn ui-control"
                onClick={handleClearQueue}
                title="Clear queue"
              >
                Clear
              </button>
            </div>
          )}
          {turnDiagnostics ? (
            <TurnStatus presentation="header" diagnostics={turnDiagnostics} />
          ) : (
            <div className={`chat-status-indicator ${isRunning || isStreaming ? 'running' : ''}`} />
          )}
        </div>
      </div>

      {unifiedSubAgents.length > 0 && (
        <div className="thread-context">
          <SubAgentPanel
            presentation="tree"
            subAgents={unifiedSubAgents}
            workingDirectory={conversation.cwd}
          />
        </div>
      )}

      {messages.length === 0 ? (
        <div className="messages-container">
          {buddyContext && <BuddyConvoHeader context={buddyContext} />}
          {visibleSwarmDebugPrefix && (
            <div style={{ paddingBottom: '24px' }}>
              <SwarmConvoPrefix
                layout="wide"
                prefix={visibleSwarmDebugPrefix}
                swarmId={conversation.kind.t === 'worker' ? conversation.kind.swarmId : null}
              />
            </div>
          )}
          {isBuddyBuilderHelper ? (
            <div className="buddy-helper-panel">
              <span className="buddy-helper-kicker">Buddy Builder · hire a Buddy or a team</span>
              <h2>Let’s build your team.</h2>
              <p>
                Describe one Buddy or a whole team, the workspace they should work in, and what a
                good first outcome looks like. I’ll create each Buddy here with its own role and
                working brief.
              </p>
              {/* biome-ignore lint/a11y/useSemanticElements: a labelled group of content, not a form control set; <fieldset> brings form borders and padding. */}
              <div className="buddy-helper-example" role="group" aria-label="Example team brief">
                “Create a researcher, a designer, and an engineer for unleashd to turn customer
                feedback into shipped product improvements.”
              </div>
              <div className="buddy-helper-prompts">
                {BUDDY_STARTER_PROMPTS.map((prompt) => (
                  <button type="button" key={prompt} onClick={() => setDraftValue(prompt)}>
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="empty-state ui-muted">
              {isBuddyBuilder
                ? 'Describe the Buddy or team you want to create.'
                : 'Send a message to start the conversation.'}
            </div>
          )}
        </div>
      ) : (
        <div className="messages-container-wrapper ui-stack">
          <VirtualizedMessageList
            key={id}
            messageGroups={messageGroups}
            isRunning={isStreaming}
            isTurnActive={runtimeTurnActive}
            lastMessageRef={lastMessageRef}
            onScrollStateChange={handleScrollStateChange}
            conversationId={id!}
            markMessagesSeen={markMessagesSeen}
            totalMessageCount={messages.length}
            scrollToBottomRef={scrollToBottomRef}
            workingDirectory={conversation.cwd}
            swarmDebugPrefix={visibleSwarmDebugPrefix}
            swarmId={conversation.kind.t === 'worker' ? conversation.kind.swarmId : null}
            buddyContext={buddyContext}
          />
          {shouldShowTypingIndicator(isStreaming, streamingText) && (
            <div className="typing-indicator-overlay">
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span className="typing-dot" />
            </div>
          )}
          {showScrollToBottom && (
            <button
              type="button"
              className="scroll-to-bottom-btn ui-row"
              onClick={() => scrollToBottomRef.current?.()}
              aria-label="Scroll to bottom"
            >
              &#x25BC;
            </button>
          )}
        </div>
      )}

      <div className="input-container">
        {restartRecovery ? <RestartRecoveryPrompt recovery={restartRecovery} /> : null}
        {outOfTokensRetry !== null && (
          // 493c1c7: an out-of-tokens chat had no way forward but to copy the message by hand.
          <HarnessPicker
            label="Retry with a different harness"
            note="This harness is out of tokens. The retry starts a new chat on the one you pick and sends your last message there."
            confirm="Retry"
            seed={null}
            excluded={conversation.provider}
            buddy={false}
            placement="above"
            onConfirm={async (config) => {
              const next = createConversation({
                workingDirectory: conversation.cwd,
                config,
                kind: { t: 'chat' },
                initialMessage: outOfTokensRetry,
              });
              void navigate(`/chat/${encodeURIComponent(next)}`);
            }}
          />
        )}
        {currentMessage && (
          <div className="current-message-indicator ui-row">
            <span className="current-message-label">Current message</span>
            <span className="current-message-content ui-truncate">{currentMessage.content}</span>
          </div>
        )}

        <QueuedMessages presentation="list" conversationId={conversation.id} queue={queue} />

        {uploadError && <UploadErrorNotice error={uploadError} onDismiss={dismissUploadError} />}

        <ComposerAttachments
          presentation="chips"
          files={pendingFiles}
          onRemove={removePendingFile}
        />

        {submissionError && (
          <div className="submission-error" role="alert">
            {submissionError}
          </div>
        )}

        <div className="input-wrapper ui-row">
          <textarea
            ref={textareaRef}
            data-conversation-input="true"
            className={`message-input ui-card ${hasActiveTurn ? 'interrupt-mode' : ''}`}
            defaultValue=""
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={
              hasActiveTurn
                ? 'Enter to interrupt, Tab to queue...'
                : isBuddyBuilder
                  ? 'I want a Buddy or team for…'
                  : 'Type your message...'
            }
            disabled={!confirmed}
          />
          <div className="input-actions">
            <button
              type="button"
              className="upload-btn ui-control ui-row"
              onClick={openFilePicker}
              disabled={!confirmed || isUploading}
              title="Attach files (drag & drop also supported)"
            >
              <span className="upload-icon ui-row">&#x1F4CE;</span>
            </button>
            <button
              type="button"
              className="save-prompt-btn"
              onClick={handleSavePrompt}
              title="Save prompt (Ctrl+P to recall)"
              disabled={!hasInput}
            >
              <svg
                className="save-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <title>Save</title>
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                <polyline points="17 21 17 13 7 13 7 21" />
                <polyline points="7 3 7 8 15 8" />
              </svg>
            </button>
            <SendControls
              presentation="labelled"
              turnActive={hasActiveTurn}
              hasQueue={pendingQueue.length > 0}
              canSend={confirmed && hasContent}
              onSend={handleQueue}
              onInterrupt={handleInterrupt}
              onQueue={handleQueue}
              onStop={() => endConversation(conversation.id)}
            />
          </div>
        </div>
      </div>

      <PromptPalette
        presentation="popover"
        isOpen={showPalette}
        onClose={() => setShowPalette(false)}
        prompts={savedPrompts}
        fuzzySearch={fuzzySearch}
        incrementUsage={incrementUsage}
        deletePrompt={deletePrompt}
        onSelect={(content) => {
          setDraftValue(content);
          setHasInput(content.trim().length > 0);
          // Focus is owned by useConversationDraft's rAF; re-assert for palette UX
          requestAnimationFrame(() => textareaRef.current?.focus());
        }}
      />
    </div>
  );
}
