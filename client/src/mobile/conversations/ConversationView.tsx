import { useAtomValue } from 'jotai';
import {
  type MouseEventHandler,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { setConversationConfig } from '../../atoms/commands';
import {
  childRowsFamily,
  commandFor,
  connectionAtom,
  detailOf,
  groupsFamily,
  loadCompleteOf,
  messagesOf,
  queueOf,
  rowFamily,
  streamFamily,
  subAgentsOf,
  transcriptFamily,
} from '../../atoms/conversations';
import { forkConversation } from '../../atoms/fork-actions';
import { markMessagesSeen } from '../../atoms/ui';
import { DmChannelsNotice } from '../../components/buddies/DmChannelsNotice';
import { useConversationBodies } from '../../hooks/useConversationBodies';
import { useCopyAction } from '../../hooks/useCopyAction';
import { useProviderCatalog } from '../../hooks/useProviderCatalog';
import { useTurnDiagnostics } from '../../hooks/useTurnDiagnostics';
import { SwarmConvoPrefix } from '../../swarm';
import {
  mobileConversationRouteState,
  resolveMobileConversationDestination,
} from '../../utils/conversation-route-state';
import { rowBuddy } from '../../utils/conversation-row';
import { type OpenConversation, buildThreadTranscript } from '../../utils/conversation-transcript';
import { shortenHomePath } from '../../utils/directories';
import { buildUnifiedSubAgents } from '../../utils/subAgents';
import {
  shouldPresentTurnAttempt,
  shouldShowTypingIndicator,
  turnDiagnosticsFromAttempt,
} from '../../utils/turn-diagnostics';
import { ConfigOverlay } from '../../views/config/ConfigOverlay';
import { modelSummary } from '../../views/config/config-options';
import { QueuedMessages } from '../../views/conversation/QueuedMessages';
import { ResumeSource } from '../../views/conversation/ResumeSource';
import { SubAgentPanel } from '../../views/conversation/SubAgentPanel';
import { TranscriptGroup } from '../../views/transcript/TranscriptGroup';
import { ComposerMobile } from '../components/ComposerMobile';

/**
 * The one mobile conversation pane (plain chats and Buddy threads). It fills its PARENT (height:
 * 100%, never 100dvh, or the composer hides under the tab bar); "not found" only after load
 * completes with no pending creation. See docs/client-rationale.md#conversation-view.
 */

/** Message groups mounted on open, and added per "Show earlier" tap. */
const MOBILE_GROUP_PAGE = 30;

/** First shown group index, pinned per conversation (see `groupWindow`). */
type GroupWindow = { readonly conversationId: string; readonly firstShown: number };
/** Matches no conversation, so the first render with history pins a window. */
const UNPINNED_GROUP_WINDOW: GroupWindow = { conversationId: '', firstShown: 0 };

function CopyThreadButton({ conversation }: { conversation: OpenConversation }) {
  const text = buildThreadTranscript(conversation);
  const { state, copy } = useCopyAction(text);
  const label = state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy thread';
  return (
    <button
      type="button"
      className="mobile-chat__action"
      onClick={copy}
      title={label}
      aria-label={label}
    >
      {label}
    </button>
  );
}

function ForkButton({ conversation }: { conversation: OpenConversation }) {
  const navigate = useNavigate();
  const location = useLocation();
  // Offered only once the source is loaded (row + detail + bodies).
  return (
    <button
      type="button"
      className="mobile-chat__action"
      title="Fork into a new thread (soft handoff — carries the transcript as a draft)"
      onClick={() => {
        const forkedId = forkConversation(conversation);
        void navigate(`/chat/${forkedId}`, { state: mobileConversationRouteState(location) });
      }}
    >
      Fork
    </button>
  );
}

type BackProps = { backTo?: string; onBack?: MouseEventHandler<HTMLAnchorElement> };

/** The header's ← link; absent when embedded without a back target. */
function BackArrow({ backTo, onBack }: BackProps) {
  return backTo ? (
    <Link to={backTo} replace className="mobile-chat__back" onClick={onBack} aria-label="Back">
      ←
    </Link>
  ) : null;
}

export function ConversationView({
  conversationId,
  backTo,
  onBack,
  headerAside,
}: {
  conversationId: string;
  headerAside?: ReactNode;
} & BackProps) {
  const conversation = useAtomValue(rowFamily(conversationId));
  const dmBuddy = rowBuddy(conversation);
  const transcript = useAtomValue(transcriptFamily(conversationId));
  const detail = detailOf(transcript);
  const messages = messagesOf(transcript);
  const subAgents = subAgentsOf(transcript);
  const { loaded: detailsLoaded, error: detailError } = useConversationBodies(conversationId);
  const streamingText = useAtomValue(streamFamily(conversationId));
  const messageGroups = useAtomValue(groupsFamily(conversationId));
  const totalMessageCount = messages.length;
  const { create: pendingCreation, config: pendingConfigCommand } = useAtomValue(
    commandFor(conversationId)
  );
  const conversationLoadComplete = loadCompleteOf(useAtomValue(connectionAtom).server);
  const childConversations = useAtomValue(childRowsFamily(conversationId));
  const queue = queueOf(transcript);
  const { catalog } = useProviderCatalog();

  const [modelSheetOpen, setModelSheetOpen] = useState(false);
  const lastMessageRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Mount groups from a pinned first index (not a count from the end, which shifted content mid-
  // read); moved only by "Show earlier", re-pinned per conversation. See docs/client-
  // rationale.md#mobile-group-window.
  const newestPageStart = Math.max(0, messageGroups.length - MOBILE_GROUP_PAGE);
  const [groupWindow, setGroupWindow] = useState(UNPINNED_GROUP_WINDOW);
  if (detailsLoaded && groupWindow.conversationId !== conversationId) {
    setGroupWindow({ conversationId, firstShown: newestPageStart });
  }
  // min(): if the history shrinks below the pinned start, show the newest page.
  const firstShownGroup =
    groupWindow.conversationId === conversationId
      ? Math.min(groupWindow.firstShown, newestPageStart)
      : newestPageStart;
  // Distance from the bottom captured just before "load earlier" grows the
  // window; restored after layout so the reader's place does not jump.
  const bottomOffsetBeforeGrow = useRef<number | null>(null);

  // Same derivation as Chat.tsx: unified sub-agents + swarm prefix + resume lineage.
  // Reuses shared utils so desktop and mobile cannot drift.
  const unifiedSubAgents = useMemo(
    () => buildUnifiedSubAgents(subAgents, childConversations),
    [subAgents, childConversations]
  );

  // The server sets a swarm prefix only on chats (T09), so no kind check here.
  const visibleSwarmDebugPrefix = detail?.swarmDebugPrefix ?? null;

  const resumedFromConversationId = conversation?.resumedFrom ?? '';
  const resumedFromConversation = useAtomValue(rowFamily(resumedFromConversationId));

  // Mark seen when last message becomes visible (IntersectionObserver plumbing §4)
  useEffect(() => {
    if (messageGroups.length === 0) return;
    const el = lastMessageRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            markMessagesSeen(conversationId, totalMessageCount - 1);
          }
        }
      },
      { threshold: 0.5 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [conversationId, totalMessageCount, messageGroups.length]);

  // Auto-scroll to bottom on new messages (flat list, not virtualized — iOS momentum)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Only auto-scroll if near bottom (avoid fighting user scroll)
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    if (nearBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messageGroups, streamingText]);

  // Also scroll to bottom on mount / conversation switch
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conversationId]);

  const showEarlierGroups = () => {
    const el = scrollRef.current;
    if (el) bottomOffsetBeforeGrow.current = el.scrollHeight - el.scrollTop;
    setGroupWindow({
      conversationId,
      firstShown: Math.max(0, firstShownGroup - MOBILE_GROUP_PAGE),
    });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the window grows
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const offset = bottomOffsetBeforeGrow.current;
    if (!el || offset === null) return;
    bottomOffsetBeforeGrow.current = null;
    el.scrollTop = el.scrollHeight - offset;
  }, [firstShownGroup]);

  // Turn diagnostics — same hook desktop Chat.tsx uses (hooks/useTurnDiagnostics)
  // + same derived view model (utils/turn-diagnostics). Reuses existing atoms
  // and detail patches, not new state. Must stay before early returns.
  const runtimeIsRunning = conversation?.run === 'running' || conversation?.run === 'streaming';
  const runtimeIsStreaming = conversation?.run === 'streaming';
  const runtimeTurnActive = runtimeIsRunning || runtimeIsStreaming;
  const { attempt: latestTurnAttempt } = useTurnDiagnostics(conversationId || undefined);
  const turnDiagnostics =
    latestTurnAttempt && shouldPresentTurnAttempt(latestTurnAttempt, runtimeTurnActive)
      ? turnDiagnosticsFromAttempt(latestTurnAttempt)
      : null;
  const showTyping = shouldShowTypingIndicator(runtimeIsStreaming, streamingText ?? '');

  // All hooks above early returns (React hook ordering)
  if (!conversationId) {
    return <div className="mobile-chat__notice">No conversation selected.</div>;
  }

  // A pending creation is a real conversation the server has not acked yet.
  // Showing "not found" here is what made every new plain conversation look
  // broken; buddy threads dodged it only because their POST creates the
  // conversation server-side before the client ever routes to it.
  if (!conversation && pendingCreation) {
    const { workingDirectory, config } = pendingCreation.args;
    const creationError =
      pendingCreation.state.tag === 'rejected' ? pendingCreation.state.message : null;
    const pendingDir = shortenHomePath(workingDirectory);
    return (
      <div className="mobile-chat">
        <div className="mobile-chat__header ui-stack">
          <div className="mobile-chat__titlebar ui-row">
            <BackArrow backTo={backTo} onBack={onBack} />
            <div className="mobile-chat__heading">
              <div className="mobile-chat__dir ui-truncate" title={workingDirectory}>
                {pendingDir}
              </div>
              <div className="mobile-chat__status ui-muted">
                {creationError ? 'creation failed' : `starting ${config.provider}…`}
              </div>
            </div>
          </div>
        </div>
        <div className="mobile-chat__loading">
          {creationError ? (
            <div className="mobile-chat__creation-error" role="alert">
              <p>Could not create this conversation.</p>
              <p className="mobile-chat__creation-error-detail">{creationError}</p>
              {backTo ? (
                <Link to={backTo} replace className="mobile-chat__back-link" onClick={onBack}>
                  ← Back
                </Link>
              ) : null}
            </div>
          ) : (
            `Starting ${config.provider} in ${pendingDir}…`
          )}
        </div>
        {/* Composer stays mounted but inert: the server has no session to
            accept a message for yet, and a queued send would hang forever. */}
        <ComposerMobile
          conversationId={conversationId}
          isRunning={false}
          isStreaming={false}
          queue={[]}
          disabledReason={creationError ? 'Creation failed' : 'Waiting for the server to confirm…'}
        />
      </div>
    );
  }

  if (!conversation) {
    // Genuinely absent — but only once the list has actually finished loading.
    if (!conversationLoadComplete) {
      return <div className="mobile-chat__notice">Loading conversations…</div>;
    }
    return (
      <div className="mobile-chat__notice">
        {backTo ? (
          <div style={{ marginBottom: 12 }}>
            <Link to={backTo} replace className="mobile-chat__back-link" onClick={onBack}>
              ← Back
            </Link>
          </div>
        ) : null}
        Conversation not found. It may have been deleted.
      </div>
    );
  }

  if (!detailsLoaded || !detail) {
    return (
      <div className="mobile-chat">
        <div className="mobile-chat__header ui-stack">
          <div className="mobile-chat__titlebar ui-row">
            <BackArrow backTo={backTo} onBack={onBack} />
            <span style={{ fontSize: 13, fontWeight: 600 }}>{conversationId.slice(0, 8)}</span>
          </div>
        </div>
        <div className="mobile-chat__loading">{detailError ?? 'Loading conversation history…'}</div>
      </div>
    );
  }

  const dirDisplay = shortenHomePath(conversation.cwd);
  const isRunning = runtimeIsRunning;
  const isStreaming = runtimeIsStreaming;
  const open: OpenConversation = { row: conversation, detail, messages };
  const turnActive = isRunning || isStreaming;
  // The live assistant bubble hosts its own working indicator when it has no
  // renderable parts yet; the standalone row below covers every other shape
  // (user-last transcripts, non-empty responses) so the two never double up.
  const lastGroup = messageGroups.length > 0 ? messageGroups[messageGroups.length - 1] : null;
  const liveBubbleHostsWorking =
    !!lastGroup && lastGroup.type === 'assistant' && lastGroup.parts.length === 0 && turnActive;
  // queue already derived via queueAtomFamily before early returns — keeps hook order
  const configSaving = pendingConfigCommand?.state.tag === 'sent';
  const configError =
    pendingConfigCommand?.state.tag === 'rejected' ? pendingConfigCommand.state.message : null;

  const hasThreadContext = unifiedSubAgents.length > 0 || !!conversation.resumedFrom;
  const showSwarmPrefix = !!visibleSwarmDebugPrefix;

  return (
    <div className="mobile-chat">
      <div className="mobile-chat__header ui-stack">
        <div className="mobile-chat__titlebar ui-row">
          <BackArrow backTo={backTo} onBack={onBack} />
          <div className="mobile-chat__heading">
            <div className="mobile-chat__dir ui-truncate" title={conversation.cwd}>
              {dirDisplay}
              {conversation.kind.t === 'builder' && (
                <span className="buddy-helper-kicker"> · Buddy Builder</span>
              )}
            </div>
            <div className="mobile-chat__status ui-muted">
              {/* One compact line: status + model. The model used to be three
                  always-visible dropdown chips that wrapped onto two or three
                  rows on a phone and ate a third of the screen. */}
              <button
                type="button"
                className="mobile-chat__model"
                onClick={() => setModelSheetOpen(true)}
                aria-haspopup="dialog"
                title="Change model"
              >
                {modelSummary(detail.config.config, catalog)}
                {configSaving ? ' …' : ''}
                <span aria-hidden="true"> ▾</span>
              </button>
            </div>
          </div>
          <div className="mobile-chat__actions ui-row">
            {headerAside}
            <CopyThreadButton conversation={open} />
            <ForkButton conversation={open} />
          </div>
        </div>

        {/* Config rejections were previously invisible on mobile — the picker
            closed and the label silently reverted on the next server snapshot. */}
        {configError ? (
          <div className="mobile-chat__config-error" role="alert">
            {configError}
          </div>
        ) : null}
      </div>

      {dmBuddy !== null && (
        <DmChannelsNotice
          conversationId={conversation.id}
          buddy={dmBuddy}
          className="dm-channels-notice ui-row ui-muted"
        />
      )}

      {/* Thread-context strip: the same views Chat.tsx renders, in their card presentations. */}
      {(hasThreadContext || showSwarmPrefix) && (
        <div className="mobile-chat__thread-context">
          {unifiedSubAgents.length > 0 ? (
            <SubAgentPanel presentation="cards" subAgents={unifiedSubAgents} />
          ) : null}
          {conversation.resumedFrom ? (
            <ResumeSource
              presentation="card"
              sourceConversationId={conversation.resumedFrom}
              sourceConversation={resumedFromConversation ?? null}
            />
          ) : null}
          {showSwarmPrefix ? (
            <SwarmConvoPrefix
              layout="narrow"
              prefix={visibleSwarmDebugPrefix!}
              swarmId={conversation.kind.t === 'worker' ? conversation.kind.swarmId : null}
            />
          ) : null}
        </div>
      )}

      {/* Flat message list — not virtualized (iOS momentum-scroll, §10 Phase 1),
          but windowed from a pinned first group; see `groupWindow`. */}
      <div ref={scrollRef} className="mobile-chat__messages ui-stack">
        {firstShownGroup > 0 && (
          <button
            type="button"
            className="mobile-chat__load-earlier ui-muted"
            onClick={showEarlierGroups}
          >
            Show {Math.min(firstShownGroup, MOBILE_GROUP_PAGE)} earlier ({firstShownGroup} hidden)
          </button>
        )}
        {messageGroups.length === 0 ? (
          <div className="mobile-chat__empty">
            {conversation.kind.t === 'builder'
              ? 'Describe a Buddy or a whole team, their workspace, and what they should accomplish.'
              : 'No messages yet. Send a message to start.'}
          </div>
        ) : (
          messageGroups.slice(firstShownGroup).map((group, windowIndex) => {
            const index = firstShownGroup + windowIndex;
            return (
              <TranscriptGroup
                key={group.firstMessageIndex}
                presentation="footer"
                group={group}
                isLastGroup={index === messageGroups.length - 1}
                lastMessageRef={lastMessageRef}
                workingDirectory={conversation.cwd}
                isLiveTurn={turnActive && index === messageGroups.length - 1}
              />
            );
          })
        )}
        {turnActive && !streamingText && !turnDiagnostics && !liveBubbleHostsWorking && (
          <div className="mobile-chat__thinking">Thinking…</div>
        )}
        {showTyping && (
          <div className="mobile-chat__typing" aria-live="polite">
            <span className="mobile-chat__typing-dot" />
            <span className="mobile-chat__typing-dot" />
            <span className="mobile-chat__typing-dot" />
          </div>
        )}
      </div>

      <QueuedMessages presentation="disclosure" conversationId={conversation.id} queue={queue} />

      <ComposerMobile
        conversationId={conversation.id}
        isRunning={isRunning}
        isStreaming={isStreaming}
        queue={queue}
      />

      {modelSheetOpen ? (
        <ConfigOverlay
          presentation="sheet"
          value={detail.config.config}
          onChange={(config) =>
            setConversationConfig({
              conversationId: conversation.id,
              expectedRevision: detail.config.revision,
              patch: { kind: 'replace', config },
            })
          }
          onClose={() => setModelSheetOpen(false)}
        />
      ) : null}
    </div>
  );
}

/** The /chat/:id route: a wrapper only, so Buddy surfaces embedding ConversationView miss nothing. */
export function ChatMobile() {
  const { id = '' } = useParams<{ id: string }>();
  const conversation = useAtomValue(rowFamily(id));
  const location = useLocation();
  const navigate = useNavigate();
  const destination = resolveMobileConversationDestination(location.state, conversation);
  const handleBack: MouseEventHandler<HTMLAnchorElement> = (event) => {
    // A direct deep link (router key `default`) lets the anchor use the fallback path.
    if (location.key === 'default') return;
    event.preventDefault();
    void navigate(-1);
  };
  return <ConversationView conversationId={id} backTo={destination.path} onBack={handleBack} />;
}
