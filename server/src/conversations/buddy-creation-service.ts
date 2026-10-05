import type {
  BuddyContext,
  BuddyVisibility,
  ConversationBranch,
  ConversationConfig,
} from '@unleashd/shared';
import { bodyText, buddyKind } from '@unleashd/shared';
import { NO_AGENT_INSTALLED, configFromProviderPreferences } from '@unleashd/shared';
import type { ResolvedBuddyConversation } from '../buddies/briefing';
import { type ConfigProvenance, INITIAL_MESSAGE_DISPATCH_LEASE_MS } from './config-records';
import type { ConversationConfigService } from './config-service';
import { createConversationService } from './creation-service';
import type {
  ConversationBroadcast,
  ConversationOptions,
  ConversationRuntime,
  ConversationRuntimeView,
} from './runtime';

export interface CreateServerBuddyConversationInput {
  config?: ConversationConfig;
  provenance?: ConfigProvenance;
  context: BuddyContext;
  initialMessage?: string;
  commandId: string;
  conversationId?: string;
  /** Register/link the transcript but leave its first provider turn dormant. */
  deferInitialMessage?: boolean;
  /** Default: decided from the context (defaultBuddyVisibility). */
  visibility?: BuddyVisibility;
  branch?: ConversationBranch;
  ownerInput?: Readonly<{ origin: 'owner_input'; inputId: string }>;
}

export interface InitialMessageDispatchOptions {
  ownerInput?: Readonly<{ origin: 'owner_input'; inputId: string }>;
  /**
   * Run the synchronous enqueue inside the caller's authority transaction.
   * Throwing leaves the child dormant and disables automatic retry.
   */
  enqueueAuthorized?(enqueue: () => void): void;
}

export interface CreateBuddyBuilderConversationInput {
  commandId: string;
  workingDirectory: string;
  conversationId?: string;
}

export interface BuddyCreationServicePorts {
  configService: Pick<
    ConversationConfigService,
    | 'claimInitialMessageDispatch'
    | 'completeInitialMessageDispatch'
    | 'createOrReplay'
    | 'getRecord'
    | 'setCurrentSession'
  >;
  resolveBuddyConversation(context: BuddyContext): Promise<ResolvedBuddyConversation>;
  resolveWorkingDirectory(input: string): string;
  createId(): string;
  getConversation(id: string): ConversationRuntime | undefined;
  createConversation(options: ConversationOptions): ConversationRuntime;
  registerConversation(conversation: ConversationRuntime): void;
  createConversationLink(conversation: ConversationRuntime): Promise<void>;
  updateConversationStatus(
    conversation: ConversationRuntime,
    status: 'active' | 'complete' | 'failed' | 'cancelled'
  ): void;
  broadcast(data: ConversationBroadcast): void;
  logger?: Pick<Console, 'warn'>;
}

export interface BuddyCreationService {
  ensureConversationReady(conversation: ConversationRuntime): Promise<ConversationRuntime>;
  persistCurrentSession(
    conversation: ConversationRuntimeView,
    sessionId: string,
    buddyAudienceKey?: string
  ): Promise<void>;
  dispatchInitialMessageIfPending(
    conversation: ConversationRuntime,
    options?: InitialMessageDispatchOptions
  ): Promise<void>;
  createServerBuddyConversation(
    input: CreateServerBuddyConversationInput
  ): Promise<ConversationRuntime>;
  createBuddyBuilderConversation(
    input: CreateBuddyBuilderConversationInput
  ): Promise<ConversationRuntime>;
}

export function createBuddyCreationService(ports: BuddyCreationServicePorts): BuddyCreationService {
  const logger = ports.logger ?? console;
  const createOrReuse = createConversationService(ports);
  const dispatchRetryTimers = new Map<string, NodeJS.Timeout>();
  const dispatchOptions = new Map<string, InitialMessageDispatchOptions>();

  class InitialMessageAuthorityRejectedError extends Error {}

  async function persistCurrentSession(
    conversation: ConversationRuntimeView,
    sessionId: string,
    buddyAudienceKey?: string
  ): Promise<void> {
    try {
      await ports.configService.setCurrentSession(conversation.id, {
        provider: conversation.config.provider,
        sessionId,
        ...(buddyAudienceKey ? { buddyAudienceKey } : {}),
      });
    } catch (error) {
      logger.warn(
        `[conversation-config] Failed to bind session ${sessionId} to ${conversation.id}:`,
        error
      );
    }
  }

  async function dispatchInitialMessageIfPending(
    conversation: ConversationRuntime,
    options?: InitialMessageDispatchOptions
  ): Promise<void> {
    if (options) dispatchOptions.set(conversation.id, options);
    const claimed = await ports.configService.claimInitialMessageDispatch(conversation.id);
    if (!claimed) {
      const current = await ports.configService.getRecord(conversation.id);
      if (
        current?.creation?.initialMessage &&
        !current.creation.initialMessageDispatchedAt &&
        current.creation.initialMessageDispatchClaimedAt
      ) {
        scheduleInitialMessageRetry(conversation, current.creation.initialMessageDispatchClaimedAt);
      }
      return;
    }
    const initialMessage = claimed?.creation?.initialMessage;
    const claimToken = claimed?.creation?.initialMessageDispatchClaimToken;
    if (!initialMessage || !claimToken) return;
    try {
      const alreadyVisible = conversation.messages.some(
        (message) => message.role === 'user' && bodyText(message.body) === initialMessage
      );
      if (!alreadyVisible) {
        const currentOptions = dispatchOptions.get(conversation.id);
        const enqueue = () =>
          conversation.enqueueMessage(initialMessage, currentOptions?.ownerInput);
        if (currentOptions?.enqueueAuthorized) {
          try {
            // Authority check, binding and enqueue: one synchronous critical section (I2/I7).
            currentOptions.enqueueAuthorized(enqueue);
          } catch (error) {
            dispatchOptions.delete(conversation.id);
            throw new InitialMessageAuthorityRejectedError(
              error instanceof Error ? error.message : String(error)
            );
          }
        } else {
          enqueue();
        }
      }
      dispatchOptions.delete(conversation.id);
      const completed = await ports.configService.completeInitialMessageDispatch(
        conversation.id,
        claimToken
      );
      if (!completed) {
        logger.warn(
          `[conversation-config] Initial message delivery acknowledgement lost for ${conversation.id}`
        );
      }
      const timer = dispatchRetryTimers.get(conversation.id);
      if (timer) clearTimeout(timer);
      dispatchRetryTimers.delete(conversation.id);
    } catch (error) {
      if (error instanceof InitialMessageAuthorityRejectedError) throw error;
      logger.warn(
        `[conversation-config] Initial message enqueue failed for ${conversation.id}; retrying after lease:`,
        error
      );
      scheduleInitialMessageRetry(conversation, claimed.creation?.initialMessageDispatchClaimedAt);
    }
  }

  function scheduleInitialMessageRetry(
    conversation: ConversationRuntime,
    claimedAt: string | undefined
  ): void {
    if (dispatchRetryTimers.has(conversation.id)) return;
    const claimedAtMs = claimedAt ? Date.parse(claimedAt) : Date.now();
    const delay = Math.max(0, claimedAtMs + INITIAL_MESSAGE_DISPATCH_LEASE_MS - Date.now()) + 25;
    const timer = setTimeout(() => {
      dispatchRetryTimers.delete(conversation.id);
      void dispatchInitialMessageIfPending(conversation).catch((error) => {
        logger.warn(
          `[conversation-config] Initial message retry failed for ${conversation.id}:`,
          error
        );
      });
    }, delay);
    timer.unref?.();
    dispatchRetryTimers.set(conversation.id, timer);
  }

  // Only a conversation with no config yet asks its profile, so `no-agent` refuses exactly the
  // opens that would otherwise spawn a missing binary; existing conversations keep theirs.
  function resolveConfig(resolved: ResolvedBuddyConversation): ConversationConfig {
    switch (resolved.execution.kind) {
      case 'run':
        return configFromProviderPreferences(resolved.execution);
      case 'no-agent':
        throw new Error(NO_AGENT_INSTALLED);
    }
  }

  async function createServerBuddyConversation(
    input: CreateServerBuddyConversationInput
  ): Promise<ConversationRuntime> {
    const resolved = await ports.resolveBuddyConversation(input.context);
    const conversation = await createOrReuse({
      conversationId: input.conversationId ?? ports.createId(),
      workingDirectory: ports.resolveWorkingDirectory(resolved.workingDirectory),
      config: input.config ?? resolveConfig(resolved),
      provenance: input.provenance,
      commandId: input.commandId,
      initialMessage: input.initialMessage,
      branch: input.branch,
      kind: buddyKind(resolved.context, input.visibility),
      buddyBriefing: resolved.briefing,
    });
    conversation.publishRow();
    if (!input.deferInitialMessage)
      await dispatchInitialMessageIfPending(
        conversation,
        input.ownerInput ? { ownerInput: input.ownerInput } : undefined
      );
    return conversation;
  }

  async function createBuddyBuilderConversation(
    input: CreateBuddyBuilderConversationInput
  ): Promise<ConversationRuntime> {
    const conversationId = input.conversationId ?? ports.createId();
    const workingDirectory = ports.resolveWorkingDirectory(input.workingDirectory);
    const config = configFromProviderPreferences({
      provider: 'codex',
      model: 'gpt-6-astra',
      reasoningEffort: 'low',
    });
    const conversation = await createOrReuse({
      conversationId,
      workingDirectory,
      config,
      kind: { t: 'builder' },
      commandId: input.commandId,
    });
    conversation.publishRow();
    return conversation;
  }

  return {
    ensureConversationReady: createOrReuse.ensureReady,
    persistCurrentSession,
    dispatchInitialMessageIfPending,
    createServerBuddyConversation,
    createBuddyBuilderConversation,
  };
}
