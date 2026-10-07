import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { type ExecutionHandle, executeCommand } from '@nbardy/agent-cli';
import type {
  BuddyContext,
  ConfigResolution,
  ConversationConfig,
  ConversationConfigState,
  ConversationDetail,
  ConversationKind,
  ConversationRow,
  Message,
  OompaRuntimeSnapshot,
  Provider as ProviderName,
  ProviderTurnUsage,
  QueuedMessage,
  ResolvedExecutionConfig,
  RowPatch,
  RunState,
  ServerMessageInput,
  SubAgent,
} from '@unleashd/shared';
import {
  bodyText,
  encodeRows,
  kindBuddyContext,
  matchConversationKind,
  providerSupportsFork,
  rowKind,
} from '@unleashd/shared';
import {
  BuddyBuilderTurnPolicy,
  type BuddyPolicyHost,
  BuddyTurnPolicy,
  type BuddyTurnPolicyDependencies,
  type BuddyTurnPolicySeed,
  type MemoryGenerationInput,
  createMemorySnapshot,
} from '../buddies/turn-policy';
import { SWARM_POLL_INTERVAL_MS, SWARM_POLL_THROTTLE_MS } from '../constants/timeouts';
import type { RuntimeTurnAttemptObserver } from '../observability';
import { resolveConfigAgainstProviderCatalog } from '../providers/catalog-service';
import { SwarmObservers } from '../swarm';
import type { Effect, Phase } from '../turns/execution-state';
import type { TurnOwner } from '../turns/executions';
import {
  type OwnerInput,
  type SessionRelativePrompt,
  type TurnInput,
  sameEitherWay,
} from '../turns/input';
import { type InputCarrier, decodeEntry, volatileCarrier } from '../turns/intake';
import { keepAwake } from '../turns/keep-awake';
import { ChatTurnPolicy, type MemorySnapshot, type TurnPolicy } from '../turns/policy';
import { type QueueEntry, TurnQueue } from '../turns/queue';
import { TurnRunner, type TurnRunnerPorts } from '../turns/runner';

// The conversation: record + queue + kind policy + the runner of its current turn. Turn
// mechanics live in turns/, kind behavior in the policy chosen once by kind.

export type { SessionRelativePrompt } from '../turns/input';

export type ConversationBroadcast = ServerMessageInput;

export interface ConversationRuntimeView {
  id: string;
  sessionId: string;
  config: ConversationConfig;
  readonly provider: ProviderName;
  /** Derived from `kind` (never a second identity): the Buddy run data or null. */
  readonly buddyContext: BuddyContext | null;
  readonly memoryGeneration: string | null;
  kind: ConversationKind;
  getMemorySnapshot(): MemorySnapshot | null;
  isRunning: boolean;
  toRow(): ConversationRow;
}

/** Input with no recorded producer: no owner authority, workspace audience. */
function unknownInput(): TurnInput {
  return { origin: 'unknown', inputId: crypto.randomUUID() };
}

/** The host server's ports: the runner's, the Buddy policies', and the conversation's own. */
export interface ConversationRuntimeDependencies
  extends BuddyTurnPolicyDependencies,
    Omit<TurnRunnerPorts, 'executeTurn' | 'turnAttempts' | 'swarmObservers'> {
  persistCurrentSession(
    conversation: ConversationRuntimeView,
    sessionId: string,
    buddyAudienceKey?: string
  ): Promise<void>;
  getConversation(id: string):
    | {
        isRunning: boolean;
        provider: ProviderName;
        sessionId: string;
        hasStartedSession(): boolean;
        getMemorySnapshot?: () => MemorySnapshot | null;
      }
    | undefined;
  readLatestOompaRuntime(projectRoot: string): Promise<OompaRuntimeSnapshot>;
  /** Test seam for the real provider boundary; production uses agent-cli directly. */
  executeTurn?: typeof executeCommand;
  turnAttempts?: RuntimeTurnAttemptObserver;
  /** Where chat and Builder owner messages are durable (turns/intake.ts); absent = nowhere. */
  inputs?: InputCarrier;
  /** The ingest list (production); absent = a host with no transcripts (the overlay is all). */
  history?: RuntimeHistory;
}

/** What the history owns in a runtime's row: label, times and the served history's length. */
export interface HistoryRowFields {
  label: string;
  createdAt: number;
  activityAt: number;
  messageCount: number;
}

/** A runtime as the history reads it. */
export interface HistorySubject {
  readonly id: string;
  readonly title?: string;
  readonly messages: readonly Message[];
  readonly createdAt: Date;
  hasActiveProcess(): boolean;
}

/** The history port (ingest/conversation-list.ts): one row rule; `idle` applies held-back changes. */
export interface RuntimeHistory {
  fields(conversation: HistorySubject): HistoryRowFields;
  idle(conversationId: string): void;
}

/** A conversation with no transcript yet (app-created, first turn not flushed): its overlay. */
export function overlayHistoryFields(conversation: HistorySubject): HistoryRowFields {
  const createdAt = conversation.createdAt.getTime();
  const last = conversation.messages.at(-1);
  return {
    label: conversationLabel(conversation.title, conversation.messages),
    createdAt,
    activityAt: last ? new Date(last.timestamp).getTime() : createdAt,
    messageCount: conversation.messages.length,
  };
}

const OVERLAY_ONLY_HISTORY: RuntimeHistory = {
  fields: overlayHistoryFields,
  idle: () => undefined,
};

const LOG_CONTENT_PREVIEW_CHARS = 140;

function formatLogPreview(content: string, maxChars = LOG_CONTENT_PREVIEW_CHARS): string {
  return content.replace(/\s+/g, ' ').slice(0, maxChars);
}

export interface ConversationOptions {
  id: string;
  workingDirectory?: string | null;
  configState: ConversationConfigState;
  /** Required, so no load path can forget it and resurrect a hidden conversation. */
  done: boolean;
  existingSessionId?: string;
  /** Host-owned metadata from the matching durable provider-session binding. */
  existingSessionAudienceKey?: string;
  /** The one identity; chosen at creation or read from the record. */
  kind: ConversationKind;
  parentConversationId?: string | null;
  resumedFromConversationId?: string | null;
  /** Provider-reported model from the latest turn / transcript. */
  observedModel?: string | null;
  /** Provider-generated label (Claude ai-title/custom-title) restored on hydration. */
  title?: string | null;
  swarmDebugPrefix?: string | null;
  buddyBriefing?: string | null;
  /** Native generation when the Buddy resolver provides one; otherwise derived from the briefing. */
  buddyMemoryGeneration?: MemoryGenerationInput | null;
  /** Usage restored from the persisted session binding on reload. */
  existingProviderUsage?: ProviderTurnUsage | null;
}

export type ConversationConstructor = new (options: ConversationOptions) => ConversationRuntime;

const NOOP_TURN_ATTEMPT_OBSERVER: RuntimeTurnAttemptObserver = {
  queued: () => undefined,
  starting: () => undefined,
  running: () => undefined,
  bindProviderSession: () => undefined,
  activity: () => undefined,
  stopping: () => undefined,
  terminal: () => undefined,
};

/** What every conversation of one host shares: its ports and the history port. */
interface ConversationEnv {
  deps: ConversationRuntimeDependencies;
  history: RuntimeHistory;
  runnerPorts: TurnRunnerPorts;
}

export type ConversationRuntime = Conversation;

export function createConversationRuntime(
  dependencies: ConversationRuntimeDependencies
): ConversationConstructor {
  const env: ConversationEnv = {
    deps: dependencies,
    history: dependencies.history ?? OVERLAY_ONLY_HISTORY,
    runnerPorts: {
      ...dependencies,
      executeTurn: dependencies.executeTurn ?? executeCommand,
      turnAttempts: dependencies.turnAttempts ?? NOOP_TURN_ATTEMPT_OBSERVER,
      // One async swarm poller per working directory, shared by all turns there.
      swarmObservers: new SwarmObservers(dependencies.readLatestOompaRuntime, {
        intervalMs: SWARM_POLL_INTERVAL_MS,
        throttleMs: SWARM_POLL_THROTTLE_MS,
      }),
    },
  };
  return class extends Conversation {
    constructor(options: ConversationOptions) {
      super(options, env);
    }
  };
}

export class Conversation extends EventEmitter {
  id: string; // UI conversation ID (persists across resets)
  sessionId: string; // Provider CLI session ID (can be reset for fresh context)
  // The live-turn overlay (messages appended this run); ingest merges it with disk history.
  messages: Message[] = [];
  // The last run state sent, so a status change publishes one `run` patch.
  private _publishedRun: RunState = 'idle';
  private _process: ExecutionHandle | null = null;
  get process(): ExecutionHandle | null {
    return this._process;
  }
  // Process exit is the idle boundary: held-back transcript changes replace the overlay now.
  set process(value: ExecutionHandle | null) {
    const ended = this._process !== null && value === null;
    this._process = value;
    if (ended) this.env.history.idle(this.id);
  }
  isRunning: boolean;
  // INVARIANT: !isRunning → !isStreaming (the runner's completion paths enforce it).
  isStreaming: boolean;
  createdAt: Date;
  workingDirectory: string;
  config: ConversationConfig;
  configRevision: number;
  configResolution: ConfigResolution;
  // Mirror of record.done, written only after set_conversation_done's record write.
  done: boolean;
  // Parent of a provider-native sub-agent thread (Codex: thread_spawn.parent_thread_id).
  parentConversationId: string | null;
  // Chat "Fork" lineage (UI), not a provider-session fork (docs/turn-lifecycle.md#chat-fork).
  resumedFromConversationId: string | null;
  // The latest turn's reported model: an observation, never configuration (that is `config`).
  observedModel: string | null;
  // Provider-generated label; until observed the row label is the first message.
  title: string | undefined;
  private _titleSource: 'ai' | 'custom' | null = null;
  // Swarm debug prefix for the first CLI message; kept so the detail can render it.
  swarmDebugPrefix: string | null;
  // Latest request's usage on the current session (docs/turn-lifecycle.md#provider-usage).
  providerUsage: ProviderTurnUsage | null;
  subAgents: SubAgent[];
  // Server-owned queue; clients mirror it from `queue` patches.
  readonly turnQueue = new TurnQueue();
  get queue(): QueuedMessage[] {
    return this.turnQueue.items;
  }
  // Track if we've started a CLI session (for --resume vs --session-id)
  private _hasStartedSession: boolean;
  private _sendingFromQueue = false;
  private readonly runner: TurnRunner;

  // The one identity, fixed at construction; it selects the turn policy (`policyFor`).
  private readonly _kind: ConversationKind;
  private _policy: TurnPolicy;
  get kind(): ConversationKind {
    return this._kind;
  }
  get buddyContext(): BuddyContext | null {
    return kindBuddyContext(this._kind);
  }

  constructor(
    opts: ConversationOptions,
    private readonly env: ConversationEnv
  ) {
    super();
    const {
      id,
      workingDirectory = null,
      configState,
      existingSessionId,
      kind,
      parentConversationId = null,
      resumedFromConversationId = null,
      observedModel = null,
      title = null,
      swarmDebugPrefix = null,
      buddyBriefing = null,
      buddyMemoryGeneration = null,
    } = opts;
    this.id = id;
    // Defaults to id (transcript name = conversation id) until resetProcess rotates it.
    this.sessionId = existingSessionId ?? id;
    this.env.deps.registerSessionAlias(this.sessionId, this.id);
    this.process = null;
    this.isRunning = false;
    this.isStreaming = false;
    this.createdAt = new Date();
    // Resolve to absolute path: sessions are identified by absolute path in oompa
    this.workingDirectory = path.resolve(workingDirectory || process.cwd());
    this.config = configState.config;
    this.configRevision = configState.revision;
    this.configResolution = configState.resolution;
    this.done = opts.done;
    this._kind = kind;
    // A Buddy chat's background branch is its child: the chat lists it among its workers
    // (mcp.ts `subscriber`). Its native parent, if a provider ever reports one, wins.
    this.parentConversationId =
      parentConversationId ?? kindBuddyContext(kind)?.parentBuddyConversationId ?? null;
    this.resumedFromConversationId = resumedFromConversationId;
    this.observedModel = observedModel;
    this.title = title ?? undefined;
    this._titleSource = this.title !== undefined ? 'custom' : null;
    this.swarmDebugPrefix = kind.t === 'chat' ? swarmDebugPrefix : null;
    this._policy = this.policyFor(this._kind, {
      memorySnapshot: createMemorySnapshot(buddyBriefing, buddyMemoryGeneration),
      audienceKey: existingSessionId ? (opts.existingSessionAudienceKey ?? null) : null,
    });
    this.providerUsage = opts.existingProviderUsage ?? null;
    this.subAgents = [];
    // Mark session as started if loading existing (use --resume for next message)
    this._hasStartedSession = existingSessionId !== undefined;
    this.runner = new TurnRunner(this, env.runnerPorts);
  }

  get memoryGeneration(): string | null {
    return this._policy.memorySnapshot()?.generation ?? null;
  }

  getMemorySnapshot(): MemorySnapshot | null {
    return this._policy.memorySnapshot();
  }

  // Pattern: sum-types (docs/patterns.md#sum-types)
  /** One policy per kind; Buddy code lives only in buddies/turn-policy.ts. */
  private policyFor(kind: ConversationKind, seed: BuddyTurnPolicySeed): TurnPolicy {
    return matchConversationKind<TurnPolicy>(kind, {
      chat: () => new ChatTurnPolicy(() => this.swarmDebugPrefix, this.inputCarrier()),
      buddy: (buddyKind) => new BuddyTurnPolicy(buddyKind, this.policyHost(), this.env.deps, seed),
      builder: () =>
        new BuddyBuilderTurnPolicy(this.policyHost(), this.env.deps, this.inputCarrier()),
      // A swarm worker is an external oompa transcript; typing into it is a plain chat turn.
      worker: () => new ChatTurnPolicy(() => null, this.inputCarrier()),
    });
  }

  private inputCarrier(): InputCarrier {
    return this.env.deps.inputs ?? volatileCarrier;
  }

  private policyHost(): BuddyPolicyHost {
    return {
      id: this.id,
      workingDirectory: this.workingDirectory,
      visibility: () => (this._kind.t === 'buddy' ? this._kind.visibility : 'foreground'),
      hasProcess: () => this.process !== null,
      hasStartedSession: () => this._hasStartedSession,
      resetProcess: () => this.resetProcess(),
      releaseQueueHead: (announce) => {
        if (this.turnQueue.releaseHead() && announce) this.broadcastQueue();
      },
      dropPendingHead: () => {
        const dropped = this.turnQueue.dropPendingHead();
        if (!dropped) return;
        this.runner.cancelQueuedAttempt(dropped);
        this.broadcastQueue();
      },
      processQueue: () => this.processQueue(),
      maxRuntimeReached: () => this.runner.timeout('max'),
      send: (prompt, input) => this.sendMessageInternal(prompt, input),
      once: (event, listener) => this.once(event, listener),
      off: (event, listener) => this.off(event, listener),
    };
  }

  // --- TurnRunnerHost: the conversation as its runner sees it ---------------

  get policy(): TurnPolicy {
    return this._policy;
  }

  markSessionStarted(started = true): void {
    this._hasStartedSession = started;
  }

  persistSession(sessionId: string, audienceKey: string | undefined): Promise<void> {
    return this.env.deps.persistCurrentSession(this, sessionId, audienceKey);
  }

  // Custom beats ai; a hydrated title counts as custom (the backfill resolved precedence).
  observeTitle(title: string, source: 'ai' | 'custom'): void {
    const next = title.trim();
    if (!next) return;
    if (source !== 'custom' && this._titleSource === 'custom') return;
    if (this.title === next) return;
    this.title = next;
    this._titleSource = source;
    this.publish({ t: 'label', label: this.label() });
  }

  runCoordinationMessage(
    content: string,
    context: BuddyContext,
    claimToken: string,
    deadline: string,
    owner: boolean
  ): Promise<void> {
    if (this._kind.t !== 'buddy') {
      return Promise.reject(new Error('Automated Buddy inputs require a Buddy conversation'));
    }
    // A backstop for the claim gate, which holds a run while this conversation has a running run
    // (`conversation_busy`). Deliveries for a chat the owner talks in run in its background
    // branch (owner decision 2026-10-07, mcp.ts `subscriber`), so no owner chat reaches here.
    if (this.process || this.isRunning) {
      return Promise.reject(new Error('Conversation is busy'));
    }
    return this._policy.runCoordination(content, context, claimToken, deadline, owner);
  }

  sendMessage(content: string, ownerInput?: OwnerInput): void {
    if (this.refusesUserInput()) return;
    this.sendMessageInternal(sameEitherWay(content), ownerInput ?? unknownInput());
  }

  /** Automation transcripts are read-only: refuse (with a system line) and report it. */
  private refusesUserInput(): boolean {
    if (this._policy.acceptsUserInput) return false;
    this.refuseAutomationTranscript();
    return true;
  }

  private refuseAutomationTranscript(): void {
    this.addSystemMessage(
      'This automation transcript is read-only. Start an ordinary Buddy conversation to continue working.'
    );
  }

  private addSystemMessage(content: string): void {
    this.appendMessage({
      role: 'system',
      body: { t: 'text', text: content },
      timestamp: new Date(),
    });
  }

  // The one resume/fresh decision, for both --resume and the prompt's wording.
  private resumesProviderSession(forkSourceSessionId: string | undefined): boolean {
    return !forkSourceSessionId && this._hasStartedSession;
  }

  private sendMessageInternal(prompt: SessionRelativePrompt, input: TurnInput): void {
    console.log(
      `[${this.id}] sendMessage called, isRunning=${this.isRunning}, hasProcess=${this.process !== null}, queueDepth=${this.turnQueue.length}, contentLen=${prompt.fresh.length}, preview="${formatLogPreview(prompt.fresh)}"`
    );

    if (this.process || this.isRunning) {
      console.warn(`[${this.id}] Already processing a message, ignoring`);
      return;
    }
    switch (this._policy.gate(input, this._sendingFromQueue)) {
      case 'send':
        this.sendAdmittedMessage(prompt, input);
        return;
      case 'enqueue':
        this.enqueuePrompt(prompt, input);
        return;
      case 'wait':
        return;
      case 'admitted':
        try {
          this.sendAdmittedMessage(prompt, input);
        } finally {
          this._policy.releaseUnspawned();
        }
        return;
    }
  }

  private sendAdmittedMessage(prompt: SessionRelativePrompt, input: TurnInput): void {
    const refreshBriefing = this._policy.prepare(input);
    const fork = this.chatForkSource();
    if (fork.t === 'rejected') {
      this.rejectFork(fork.message);
      return;
    }
    const forkSourceSessionId = fork.t === 'session' ? fork.sessionId : undefined;
    // Worded at admission, by the decision the runner resumes on.
    const resume = this.resumesProviderSession(forkSourceSessionId);
    const content = resume ? prompt.resumed : prompt.fresh;

    this.runner.beginAttempt();
    const executionConfig = this.preflightExecution();
    if (!executionConfig) return;

    // History keeps the clean text; the provider gets the policy's prompt (none after a
    // session fork: the CLI has the source transcript).
    const cliContent =
      forkSourceSessionId && !refreshBriefing
        ? content
        : this._policy.providerPrompt({
            content,
            messageCount: this.messages.length,
            hasStartedSession: this._hasStartedSession,
            refreshBriefing,
          });

    const timestamp = new Date();
    this.appendMessage({ role: 'user', body: { t: 'text', text: content }, timestamp });
    this._policy.admitted(input, content);
    // Provenance comes from the host producer, never transcript text.
    this.runner.start({
      content: cliContent,
      config: executionConfig,
      forkSourceSessionId,
      resume,
      input,
      userMessage: { text: content, timestamp },
    });
  }

  /**
   * This backend replaced the one that spawned `owner`'s turn, which may still be running. The
   * overlay gets the turn's user row back (same text and time, so the history merge pairs it with
   * the native transcript as it did live), the policy its grant and run, and the runner follows
   * the journal from byte 0. Adoption happens before any run is claimed, so a conversation with
   * an adopted turn is busy and no second writer can start on its session.
   */
  adoptTurn(
    owner: TurnOwner,
    handle: ExecutionHandle,
    phase: Phase,
    effects: readonly Effect[]
  ): void {
    if (this.process || this.isRunning)
      throw new Error(`Conversation ${this.id} is already running`);
    this.appendMessage({
      role: 'user',
      body: { t: 'text', text: owner.userMessage.text },
      timestamp: new Date(owner.userMessage.timestamp),
    });
    this._policy.adopt(owner.policy, { attemptId: owner.attemptId, messageStart: 0 });
    this.runner.adopt(owner, handle, phase, effects);
  }

  // Soft handoff, upgraded to session inheritance by capability, never rejecting the send
  // (docs/turn-lifecycle.md#chat-fork; guard `same-provider fork on a fork-incapable harness …`).
  private chatForkSource():
    | { t: 'none' }
    | { t: 'session'; sessionId: string }
    | { t: 'rejected'; message: string } {
    if (this._hasStartedSession || this.messages.length > 0 || !this.resumedFromConversationId)
      return { t: 'none' };
    const source = this.env.deps.getConversation(this.resumedFromConversationId);
    if (!source) {
      return {
        t: 'rejected',
        message: `Cannot fork: source conversation ${this.resumedFromConversationId} is not loaded`,
      };
    }
    const sourceMemorySnapshot = source.getMemorySnapshot?.() ?? null;
    const memorySnapshot = this._policy.memorySnapshot();
    const memoryGenerationMatches =
      sourceMemorySnapshot === null && memorySnapshot === null
        ? true
        : sourceMemorySnapshot !== null &&
          memorySnapshot !== null &&
          sourceMemorySnapshot.generation === memorySnapshot.generation;
    if (
      source.provider !== this.provider ||
      !providerSupportsFork(this.provider) ||
      !memoryGenerationMatches
    ) {
      const memoryDetail = memoryGenerationMatches
        ? ''
        : ', memory generation changed so native session inheritance is disabled';
      console.log(
        `[${this.id}] Soft fork ${source.provider} -> ${this.provider} (${source.provider === this.provider ? 'harness cannot fork sessions' : 'cross-provider'}${memoryDetail}), using string context handoff (no provider session fork)`
      );
      return { t: 'none' };
    }
    if (!source.hasStartedSession()) {
      return {
        t: 'rejected',
        message: 'Cannot fork: the source conversation has no provider session yet',
      };
    }
    return { t: 'session', sessionId: source.sessionId };
  }

  private rejectFork(message: string): void {
    console.error(`[${this.id}] ${message}`);
    this.addSystemMessage(message);
  }

  private preflightExecution(): ResolvedExecutionConfig | undefined {
    // docs/turn-lifecycle.md#preflight
    const resolution = this.refreshConfigResolution();
    if (resolution.status !== 'resolved') {
      this.refusePreflight(`Configuration unavailable: ${resolution.error.message}`);
      return undefined;
    }
    try {
      this._policy.preflight(resolution.value.provider);
    } catch (error) {
      this.refusePreflight(error instanceof Error ? error.message : String(error));
      return undefined;
    }
    return resolution.value;
  }

  // No child, so no later completion: terminalise here (docs/turn-lifecycle.md#one-terminal-path).
  private refusePreflight(errorMessage: string): void {
    console.error(`[${this.id}] ${errorMessage}`);
    this.appendMessage({
      role: 'system',
      body: { t: 'text', text: errorMessage },
      timestamp: new Date(),
      completionReason: 'error',
    });
    if (this.turnQueue.releaseHead()) this.broadcastQueue();
    this.publish({ t: 'config', state: this.configState(), commandId: null });
    this.runner.finishAttempt('failed', 'spawn_failed');
    this.emit('buddy-turn-failed', errorMessage);
  }

  stop(): void {
    if (this._policy.stop()) this.stopOwnedTurn();
  }

  private stopOwnedTurn(): void {
    if (this._policy.dropWaitingTurn()) {
      this.emit('buddy-turn-failed', 'Stopped while waiting for a run slot');
    }
    this.runner.stop();
  }

  // A fresh provider session under the same conversation id.
  resetProcess(): void {
    this.runner.reset();
    const oldSessionId = this.sessionId;
    this.sessionId = this.env.deps.createSessionId();
    this._policy.sessionReset();
    // A new session is an empty context: no carried-over meter.
    this.providerUsage = null;
    this.env.deps.unregisterSessionAlias(oldSessionId, { keepKnown: true });
    this.env.deps.registerSessionAlias(this.sessionId, this.id);
    // Provisional until the provider confirms it; never persisted as resumable here.
    this._hasStartedSession = false;
    console.log(
      `[${this.id}] Reset session: ${oldSessionId.substring(0, 8)}... -> ${this.sessionId.substring(0, 8)}...`
    );
  }

  broadcastQueue(): void {
    this.publish({ t: 'queue', queue: this.queue });
    this.publishRun();
  }

  /** The one run-state field: streaming implies running; `queued` = work waiting, no process. */
  runState(): RunState {
    if (this.isStreaming) return 'streaming';
    if (this.isRunning) return 'running';
    return this.turnQueue.length > 0 ? 'queued' : 'idle';
  }

  /** Send a `run` patch when the run state changed since the last one sent. */
  publishRun(): void {
    const run = this.runState();
    if (run === this._publishedRun) return;
    this._publishedRun = run;
    keepAwake.setRunning(this.id, run === 'running' || run === 'streaming');
    this.publish({ t: 'run', run });
  }

  /** Register the turn attempt and build the entry; the caller places it. */
  private createQueueEntry(prompt: SessionRelativePrompt, input: TurnInput): QueueEntry {
    const message: QueuedMessage = {
      id: crypto.randomUUID(),
      content: prompt.fresh,
      queuedAt: new Date(),
      status: 'pending',
    };
    const attemptId = this.runner.createQueuedAttempt(message.id);
    return { message, input: Object.freeze({ ...input }), prompt, attemptId };
  }

  private logEntry(what: string, { message }: QueueEntry): void {
    console.log(
      `[${this.id}] ${what} id=${message.id.substring(0, 8)}, queueDepth=${this.turnQueue.length}, contentLen=${message.content.length}, preview="${formatLogPreview(message.content)}"`
    );
  }

  private retireInFlightHead(): void {
    const retired = this.turnQueue.finishHead();
    if (retired) {
      this._policy.carrier.settle(retired);
      console.log(
        `[${this.id}] Retiring interrupted in-flight message id=${retired.message.id.substring(0, 8)}`
      );
    }
  }

  /** Queue a message; an idle conversation sends it at once. */
  enqueueMessage(content: string, ownerInput?: OwnerInput): void {
    this.enqueuePrompt(sameEitherWay(content), ownerInput ?? unknownInput());
  }

  private enqueuePrompt(prompt: SessionRelativePrompt, input: TurnInput): void {
    if (this.refusesUserInput()) return;
    const entry = this.createQueueEntry(prompt, input);
    this.turnQueue.pushBack(entry);
    this._policy.carrier.put(this.id, entry);
    this.logEntry('Queued message', entry);
    this.broadcastQueue();
    this.processQueue();
  }

  /** Stop the turn and send first; pending work is KEPT, only the in-flight head retires. */
  interruptAndSend(content: string, ownerInput?: OwnerInput): void {
    if (this.refusesUserInput()) return;
    this.retireInFlightHead();

    if (this.process) {
      this.stop();
    }

    const entry = this.createQueueEntry(sameEitherWay(content), ownerInput ?? unknownInput());
    this.turnQueue.pushFront(entry);
    // Durable order: written at the back, then moved first (a promote), like the queue itself.
    this._policy.carrier.put(this.id, entry);
    this._policy.carrier.promote(entry);
    this.logEntry('interrupt_and_send', entry);
    this.broadcastQueue();
    this.processQueue();
  }

  /** Move a pending message first and interrupt the turn; unknown ids are a no-op. */
  promoteQueuedMessage(messageId: string): void {
    if (this.refusesUserInput()) return;
    const promoted = this.turnQueue.promote(messageId);
    if (!promoted) return;
    this._policy.carrier.promote(promoted);
    console.log(
      `[${this.id}] Promoted queued message id=${promoted.message.id.substring(0, 8)} to front, queueDepth=${this.turnQueue.length}`
    );
    this.broadcastQueue();
    if (this.process) {
      this.stop();
    }
    this.processQueue();
  }

  /** Cancel a pending message (never one already sending). */
  cancelQueuedMessage(messageId: string): void {
    const removed = this.turnQueue.removePending(messageId);
    if (!removed) return;
    console.log(`[${this.id}] Cancelled queued message: ${messageId.substring(0, 8)}`);
    this.runner.cancelQueuedAttempt(removed);
    this.broadcastQueue();
  }

  /** Drop every pending message; one sending is kept. */
  clearQueue(): void {
    const removed = this.turnQueue.clearPending();
    for (const entry of removed) this.runner.cancelQueuedAttempt(entry);
    console.log(`[${this.id}] Cleared queue: removed ${removed.length} messages`);
    this.broadcastQueue();
  }

  /** Send the next queued message when idle (after a drain, or on enqueue). */
  processQueue(): void {
    if (!this._policy.acceptsUserInput) {
      // Queued state must never bypass a closed (automation) transcript.
      this.clearQueue();
      return;
    }
    if (this.process || this.isRunning) return;
    const next = this.turnQueue.startHead();
    if (!next) return; // empty, or the head is already in flight
    // The head starts only once its durable row says it executes (turns/intake.ts, `stamp`): a
    // turn spawned before that could be adopted after a crash AND requeued, and run twice. Not
    // yet: it stays pending, and the carrier's landing (or the runner's claim) calls this again.
    if (!this._policy.carrier.stamp(next, () => this.processQueue())) {
      this.turnQueue.releaseHead();
      return;
    }

    this.runner.prepareQueuedAttempt(next);
    this.logEntry('processQueue sending', next);
    this.broadcastQueue();
    try {
      this._sendingFromQueue = true;
      try {
        // sendMessage without the refusal, with the item's own wording and provenance.
        this.sendMessageInternal(next.prompt, next.input);
      } finally {
        this._sendingFromQueue = false;
      }
    } catch (error) {
      // A synchronous failure must never strand the head in "sending".
      if (this.turnQueue.head() === next && this.turnQueue.releaseHead()) {
        this.broadcastQueue();
      }
      throw error;
    }
  }

  hasActiveProcess(): boolean {
    return this.process !== null;
  }

  /**
   * The runner claimed the `chat` run of one queued owner message of this Buddy conversation. After
   * a restart the message is not in memory: it comes back from the run's body. The durable claim
   * order is the queue order, so the claimed message goes first (nothing is running: the claim gate
   * lets one chat run per conversation).
   */
  admitChatClaim(
    turnId: string,
    body: string,
    run: { id: string; claim_token: string; deadline: string }
  ): void {
    if (!this.turnQueue.has(turnId)) this.turnQueue.pushBack(decodeEntry(turnId, body));
    this.turnQueue.moveFirst(turnId);
    this.broadcastQueue();
    this._policy.admitClaim(turnId, run);
  }

  /**
   * Boot: this conversation's owner messages from the records store. A row stamped executing ran
   * in the previous backend (adopted from its journal, or ended visibly there), so it is only
   * settled; the rest are queued again, in order, and run once.
   */
  hydrateInputs(rows: readonly { id: string; body: string; executingAt?: string | null }[]): void {
    for (const row of rows) {
      const entry = decodeEntry(row.id, row.body);
      if (row.executingAt) this._policy.carrier.settle(entry);
      else this.turnQueue.pushBack(entry);
    }
    this.broadcastQueue();
    this.processQueue();
  }

  async waitForTurnDrain(): Promise<void> {
    await this.runner.drain();
  }

  hasStartedSession(): boolean {
    return this._hasStartedSession;
  }

  get provider(): ProviderName {
    return this.config.provider;
  }

  private get effectiveConfig() {
    return this.configResolution.status === 'resolved'
      ? this.configResolution.value
      : this.configResolution.lastResolved;
  }

  applyConfigState(state: ConversationConfigState): void {
    this.config = state.config;
    this.configRevision = state.revision;
    this.configResolution = state.resolution;
  }

  refreshConfigResolution(): ConfigResolution {
    this.configResolution = resolveConfigAgainstProviderCatalog(this.config, this.effectiveConfig);
    return this.configResolution;
  }

  // Only before the first turn: session files and resume ids are provider-specific.
  canChangeProvider(): boolean {
    return (
      !this._hasStartedSession &&
      this.messages.length === 0 &&
      this.turnQueue.length === 0 &&
      !this.isRunning &&
      !this.isStreaming
    );
  }

  configState(): ConversationConfigState {
    return {
      config: this.config,
      revision: this.configRevision,
      resolution: this.configResolution,
    };
  }

  /** Provider title, else the first user line with hidden envelopes stripped. */
  label(): string {
    return this.env.history.fields(this).label;
  }

  // Pattern: patches-not-snapshots (docs/patterns.md#patches-not-snapshots)
  toRow(): ConversationRow {
    return {
      id: this.id,
      kind: rowKind(this._kind),
      parent: this.parentConversationId,
      resumedFrom: this.resumedFromConversationId,
      provider: this.provider,
      cwd: this.workingDirectory,
      ...this.env.history.fields(this),
      run: this.runState(),
      done: this.done,
    };
  }

  toDetail(): ConversationDetail {
    return {
      id: this.id,
      sessionId: this.sessionId,
      config: this.configState(),
      queue: this.queue,
      subAgents: this.subAgents,
      latestTurn: { observedModel: this.observedModel, usage: this.providerUsage },
      latestAttempt: null,
      swarmDebugPrefix: this.swarmDebugPrefix,
    };
  }

  appendMessage(message: Message): void {
    this.messages.push(message);
    this.env.deps.broadcast({
      type: 'message',
      conversationId: this.id,
      role: message.role,
      body: message.body,
    });
    this.publishActivity();
  }

  publishActivity(): void {
    const { activityAt, messageCount } = this.env.history.fields(this);
    this.publish({ t: 'activity', activityAt, messageCount });
  }

  /** Turn end: the new history length and the provider's observations. */
  publishTurnEnd(): void {
    this.publishActivity();
    this.publish({
      t: 'turn',
      latestTurn: { observedModel: this.observedModel, usage: this.providerUsage },
    });
  }

  publish(patch: RowPatch): void {
    this.env.deps.broadcast({ type: 'patch', id: this.id, patch });
  }

  publishRow(): void {
    this.env.deps.broadcast({ type: 'rows', ...encodeRows([this.toRow()]) });
  }
}

// The crate's rule (markers.rs `label`): 60 UTF-16 units, whitespace folded onto one line.
const LABEL_MAX_UNITS = 60;
const HIDDEN_ENVELOPE_RE = /<!--[\s\S]*?-->/g;
const OOMPA_TAG_RE = /^\[oompa[^\]]*\]\s*/i;

/**
 * The label before ingest reads the transcript: provider title, else the first user message
 * without hidden envelopes or the oompa tag. The crate's rule, so it does not change when the
 * transcript lands (T13b S2: two rules showed multi-line prompts under two labels).
 */
export function conversationLabel(title: string | undefined, messages: readonly Message[]): string {
  if (title?.trim()) return title.trim();
  const source = messages.find((message) => message.role === 'user') ?? messages[0];
  if (!source) return 'New conversation';
  const visible = bodyText(source.body)
    .replace(HIDDEN_ENVELOPE_RE, '')
    .trim()
    .replace(OOMPA_TAG_RE, '');
  const line = visible.split(/\s+/).filter(Boolean).join(' ');
  if (!line) return 'New conversation';
  return line.length > LABEL_MAX_UNITS ? `${line.slice(0, LABEL_MAX_UNITS - 1)}…` : line;
}
