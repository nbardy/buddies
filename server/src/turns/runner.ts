import type { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import type { ExecuteCommandRequest, UnifiedAgentEvent, executeCommand } from '@nbardy/agent-cli';
import type {
  ContentPart,
  Message,
  ProviderTurnUsage,
  ResolvedExecutionConfig,
  RowPatch,
  ServerMessageInput,
  SubAgent,
} from '@unleashd/shared';
import { AskUserQuestionSchema, bodyText, toolContentPart } from '@unleashd/shared';
import {
  TURN_BRIDGE_TIMEOUT_MS,
  TURN_MAX_RUNTIME_MS,
  TURN_PROVIDER_IDLE_TIMEOUT_MS,
  TURN_TIMEOUT_KILL_GRACE_MS,
} from '../constants/timeouts';
import type {
  RuntimeTurnAttemptObserver,
  TurnActivitySource,
  TurnAttemptActivity,
  TurnTerminalCause,
} from '../observability';
import { type SwarmObservers, watchSwarmRuns } from '../swarm';
import { type BackgroundWait, backgroundWaitFor } from './background-wait';
import type { TurnInput } from './input';
import type { TurnPolicy } from './policy';
import type { QueueEntry, TurnQueue } from './queue';
import {
  type SubAgentFold,
  type SubAgentHost,
  failRunningSubAgents,
  subAgentFoldFor,
} from './subagents';
import { isCompletionOnlyToolUse } from './tool-format';
import {
  type TurnTimeoutKind,
  TurnWatchdog,
  describeTurnTimeout,
  turnAttemptActivityFromEvent,
} from './watchdog';

// One provider turn through agent-cli, its `UnifiedAgentEvent` stream folded into the
// conversation. Kind behavior comes from the TurnPolicy, harness differences from the
// sub-agent fold table; there is no provider branching here. Notes: docs/turn-lifecycle.md.

type ToolUseEvent = Extract<UnifiedAgentEvent, { type: 'tool.use' }>;
type CompletionReason = Extract<UnifiedAgentEvent, { type: 'turn.complete' }>['reason'];
type AttemptState = 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

const VERBOSE = process.env.VERBOSE === '1' || process.argv.includes('--verbose');
const AGENT_CLI_DEBUG_EVENTS = process.env.AGENT_CLI_DEBUG_EVENTS === '1';
const ATTEMPT_ACTIVITY_INTERVAL_MS = 5_000;
const STOP_KILL_GRACE_MS = 3000;

/** The conversation as one turn sees it. */
export interface TurnRunnerHost {
  readonly id: string;
  readonly workingDirectory: string;
  readonly resumedFromConversationId: string | null;
  sessionId: string;
  messages: Message[];
  subAgents: SubAgent[];
  process: ChildProcess | null;
  isRunning: boolean;
  isStreaming: boolean;
  providerUsage: ProviderTurnUsage | null;
  readonly policy: TurnPolicy;
  readonly turnQueue: TurnQueue;
  readonly provider: ResolvedExecutionConfig['provider'];
  markSessionStarted(started?: boolean): void;
  /** A provider-generated title; the conversation owns custom-over-ai precedence. */
  observeTitle(title: string, source: 'ai' | 'custom'): void;
  persistSession(sessionId: string, audienceKey: string | undefined): Promise<void>;
  broadcastQueue(): void;
  processQueue(): void;
  emit(event: string, ...args: string[]): void;
  /** Push one message: the `message` event plus the row's activity patch. */
  appendMessage(message: Message): void;
  publish(patch: RowPatch): void;
  /** One `run` patch when isRunning/isStreaming/queue moved the run state. */
  publishRun(): void;
  /** Turn end: activity + the latest turn's observations (usage, model). */
  publishTurnEnd(): void;
}

/** The host server's ports a turn uses. */
export interface TurnRunnerPorts {
  broadcast(data: ServerMessageInput | TurnBroadcast): void;
  registerSessionAlias(sessionId: string | null | undefined, conversationId: string): void;
  unregisterSessionAlias(
    sessionId: string | null | undefined,
    options?: { keepKnown?: boolean }
  ): void;
  clearExternalRunningStatus(...ids: Array<string | null | undefined>): void;
  clearLocalCompletionSuppression(...ids: Array<string | null | undefined>): void;
  markLocalCompletionSuppression(...ids: Array<string | null | undefined>): void;
  persistSessionUsage?(
    conversationId: string,
    sessionId: string,
    usage: ProviderTurnUsage
  ): Promise<void>;
  createSessionId(): string;
  executeTurn: typeof executeCommand;
  turnAttempts: RuntimeTurnAttemptObserver;
  swarmObservers: SwarmObservers;
}

/** Streaming frames that are not (yet) part of the shared ServerMessage schema. */
export type TurnBroadcast =
  | { type: 'chunk'; conversationId: string; text: string }
  | { type: 'message_complete'; conversationId: string; reason?: CompletionReason }
  | {
      type: 'message';
      conversationId: string;
      role: 'user' | 'assistant' | 'system';
      content: string;
    };

export class TurnRunner {
  // Per-run token: every late event/completion from a replaced handle is ignored.
  private runToken = 0;
  private stopTurn: ((signal?: NodeJS.Signals) => void) | null = null;
  private activeDrain: Promise<void> | null = null;
  private stderrBuffer = '';
  // Whether assistant text or a tool event reached the unified stream.
  private sawMeaningfulOutput = false;
  // turn.complete (or a timeout) already did the user-visible cleanup; settle takes the fast path.
  private completedCleanly = false;
  // A timeout or stop finalized the turn; later events are dropped. turn.complete does NOT
  // seal (docs/turn-lifecycle.md#early-turn-complete; guard "an early turn.complete does not drop …").
  private sealed = false;
  private terminalCauseHint: TurnTerminalCause | null = null;
  // The provider's own error text, preferred over the generic terminal message.
  private providerFailureMessage: string | null = null;
  private stopCause: 'user_stop' | 'server_restart' | null = null;
  private processStartTime = 0;
  private lastAttemptActivityAt = 0;
  private lastAttemptActivitySource: TurnActivitySource | null = null;
  private lastObservedActivity: TurnAttemptActivity | null = null;
  // Usage changed this turn and is unpersisted (one CAS write per turn, not per event).
  private providerUsageDirty = false;
  private activeAttemptId: string | null = null;
  // Fix-guard: tool events now occupy separate records; completion must collect this turn's prose.
  private turnMessageStart = 0;
  private nextAttempt: string | null = null;
  // Chosen once per turn from the harness capability table (turns/subagents.ts).
  private subAgentFold: SubAgentFold = subAgentFoldFor('claude');
  // Chosen with it: how long the harness may wait silently on background tasks it launched.
  private backgroundWait: BackgroundWait = backgroundWaitFor('claude');
  // This turn's subscription to its folder's swarm observer (swarm/observer.ts).
  private stopSwarmWatch: (() => void) | null = null;
  // The max budget is passed explicitly: foreground Buddy turns never inherit a shorter
  // claim default (docs/incident-2026-09-10-buddy-chat-timeout.md).
  private readonly watchdog = new TurnWatchdog(
    {
      bridgeMs: TURN_BRIDGE_TIMEOUT_MS,
      providerIdleMs: TURN_PROVIDER_IDLE_TIMEOUT_MS,
      maxRuntimeMs: TURN_MAX_RUNTIME_MS,
    },
    (kind) => this.timeout(kind)
  );
  private readonly subAgentHost: SubAgentHost;

  constructor(
    private readonly host: TurnRunnerHost,
    private readonly ports: TurnRunnerPorts
  ) {
    this.subAgentHost = {
      conversationId: host.id,
      get agents() {
        return host.subAgents;
      },
      changed: (agent) => host.publish({ t: 'subagent', subAgent: { ...agent } }),
      newId: () => ports.createSessionId(),
    };
  }

  // --- attempt records ---------------------------------------------------------

  /** Register a queued attempt (for a queue entry, or a direct send when absent). */
  createQueuedAttempt(queueMessageId?: string): string {
    const attemptId = crypto.randomUUID();
    this.ports.turnAttempts.queued({
      attemptId,
      conversationId: this.host.id,
      queueMessageId,
      providerSessionId: this.host.sessionId,
    });
    return attemptId;
  }

  /** The queue head about to be sent reuses its registered attempt. */
  prepareQueuedAttempt(entry: QueueEntry): void {
    entry.attemptId ??= this.createQueuedAttempt(entry.message.id);
    this.nextAttempt = entry.attemptId;
  }

  /** Make the prepared (or a new) attempt the active one. */
  beginAttempt(): void {
    this.activeAttemptId = this.nextAttempt ?? this.createQueuedAttempt();
    this.nextAttempt = null;
  }

  finishAttempt(state: AttemptState, terminalCause: TurnTerminalCause): void {
    this.host.policy.attemptFinished(terminalCause);
    if (!this.activeAttemptId) return;
    this.ports.turnAttempts.terminal({
      attemptId: this.activeAttemptId,
      state,
      terminalCause,
      providerSessionId: this.host.sessionId,
    });
    this.host.turnQueue.forgetAttempt(this.activeAttemptId);
    this.activeAttemptId = null;
    this.terminalCauseHint = null;
    this.providerFailureMessage = null;
    this.stopCause = null;
  }

  /** A stop's terminal record: a restart interrupts, an owner stop cancels. */
  private finishStopped(cause: 'user_stop' | 'server_restart'): void {
    this.finishAttempt(cause === 'server_restart' ? 'interrupted' : 'cancelled', cause);
  }

  cancelQueuedAttempt(entry: QueueEntry): void {
    if (!entry.attemptId) return;
    this.ports.turnAttempts.terminal({
      attemptId: entry.attemptId,
      state: 'cancelled',
      terminalCause: 'user_stop',
      providerSessionId: this.host.sessionId,
    });
    entry.attemptId = null;
  }

  drain(): Promise<void> | null {
    return this.activeDrain;
  }

  // --- start ---------------------------------------------------------------------

  start(turn: {
    content: string;
    config: ResolvedExecutionConfig;
    forkSourceSessionId: string | undefined;
    resume: boolean;
    input: TurnInput;
  }): void {
    const host = this.host;
    if (host.process || host.isRunning) {
      console.warn(`[${host.id}] Already processing a message, ignoring`);
      return;
    }
    const runToken = ++this.runToken;

    // This session is now being handled locally; clear any stale external flags.
    this.ports.clearExternalRunningStatus(host.id, host.sessionId);
    this.ports.clearLocalCompletionSuppression(host.id, host.sessionId);

    const forking = !!turn.forkSourceSessionId;
    const executionMode = forking ? 'fork' : turn.resume ? 'resume' : 'fresh';
    console.log(
      `[${host.id}] Spawning ${turn.config.provider} (mode=${executionMode}, provider-session=${host.sessionId.substring(0, 8)}...${turn.forkSourceSessionId ? `, fork-source-session=${turn.forkSourceSessionId.substring(0, 8)}...` : ''}${host.resumedFromConversationId ? `, parent-conversation=${host.resumedFromConversationId.substring(0, 8)}...` : ''})`
    );
    console.log(`[${host.id}] Message: "${turn.content.substring(0, 50)}"`);

    this.stderrBuffer = '';
    this.turnMessageStart = host.messages.length;
    this.sawMeaningfulOutput = false;
    this.completedCleanly = false;
    this.sealed = false;
    this.terminalCauseHint = null;
    this.providerFailureMessage = null;
    this.stopCause = null;
    this.processStartTime = Date.now();
    this.lastAttemptActivityAt = 0;
    this.lastAttemptActivitySource = null;
    this.lastObservedActivity = null;
    this.subAgentFold = subAgentFoldFor(turn.config.provider);
    this.backgroundWait = backgroundWaitFor(turn.config.provider);
    if (this.activeAttemptId) {
      this.ports.turnAttempts.starting(this.activeAttemptId);
      this.ports.turnAttempts.activity(
        this.activeAttemptId,
        {
          source: 'runtime',
          providerEventType: `execution.${executionMode}`,
          providerEventSource: host.resumedFromConversationId
            ? `parent-conversation:${host.resumedFromConversationId}`
            : 'unleashd.runtime',
        },
        host.sessionId
      );
    }

    let handle: ReturnType<typeof executeCommand>;
    try {
      const extras = host.policy.startTurn(turn.input, turn.config);
      // One request shape for every harness; the cast covers agent-cli's `never` effort typing
      // on harnesses without effort (docs/turn-lifecycle.md#one-request-shape).
      handle = this.ports.executeTurn({
        harness: turn.config.provider,
        mode: 'conversation',
        prompt: turn.content,
        cwd: host.workingDirectory,
        model: turn.config.modelId,
        resumeSessionId: turn.resume ? host.sessionId : undefined,
        forkSessionId: forking ? turn.forkSourceSessionId : undefined,
        yolo: true,
        detached: true,
        debugRawEvents: AGENT_CLI_DEBUG_EVENTS,
        reasoningEffort: turn.config.reasoningEffort,
        ...extras,
      } as ExecuteCommandRequest);
    } catch (error) {
      host.policy.spawnFailed();
      this.finishAttempt('failed', 'spawn_failed');
      const message = error instanceof Error ? error.message : String(error);
      // A synchronous spawn failure has no child to complete: signal it here so an
      // automation's run sees one terminal result (docs/turn-lifecycle.md#one-terminal-path).
      host.emit('buddy-turn-failed', message);
      throw error;
    }

    host.policy.spawned({
      attemptId: this.activeAttemptId ?? crypto.randomUUID(),
      messageStart: Math.max(0, host.messages.length - 1),
    });
    host.process = handle.child;
    this.stopTurn = handle.stop;
    host.isRunning = true;
    if (this.activeAttemptId) this.ports.turnAttempts.running(this.activeAttemptId, host.sessionId);
    host.emit('buddy-turn-started');
    this.startWatchdogs();
    this.broadcastStatus();

    const fold = new EventFold(this, runToken);
    const eventConsumption = fold.consume(handle.events).catch((err: unknown) => {
      if (runToken !== this.runToken) return;
      fold.streamError = err instanceof Error ? err : new Error(String(err));
      console.error(`[${host.id}] Event stream error: ${fold.streamError.message}`);
      this.terminalCauseHint = 'provider_error';
      this.surfaceError(
        this.describeFailure(normalizeProviderErrorMessage(fold.streamError.message))
      );
    });

    const turnDrain = handle.completed
      .then(async (completion) => {
        if (runToken !== this.runToken) return;
        // Child exit is not event-stream EOF: settle only after both join
        // (docs/turn-lifecycle.md#one-terminal-path).
        await eventConsumption;
        if (runToken !== this.runToken) return;
        await this.settle(completion, fold);
      })
      .catch((err: unknown) => {
        if (runToken !== this.runToken) return;
        this.completionBroke(err);
      });
    this.activeDrain = turnDrain;
    void turnDrain.finally(() => {
      if (this.activeDrain === turnDrain) this.activeDrain = null;
    });
  }

  // --- event fold (called by EventFold) ----------------------------------------

  isCurrent(runToken: number): boolean {
    return runToken === this.runToken;
  }

  get streamClosed(): boolean {
    return this.sealed;
  }

  async bindSession(sessionId: string): Promise<void> {
    await this.adoptSession(sessionId, this.host.policy.audienceKey());
    this.host.publish({ t: 'session', sessionId });
  }

  /** The provider named its session: alias it, persist it, bind the attempt to it. */
  private async adoptSession(sessionId: string, audienceKey: string | undefined): Promise<void> {
    const host = this.host;
    // Spawning a CLI is not proof of a resumable session. Guard: Codex startup retry.
    host.markSessionStarted();
    const oldSessionId = host.sessionId;
    host.sessionId = sessionId;
    if (oldSessionId !== sessionId) {
      console.log(`[${host.id}] Session captured: ${sessionId}`);
      this.ports.unregisterSessionAlias(oldSessionId, { keepKnown: true });
    }
    this.ports.registerSessionAlias(sessionId, host.id);
    await host.persistSession(sessionId, audienceKey);
    if (this.activeAttemptId) {
      this.ports.turnAttempts.bindProviderSession(this.activeAttemptId, sessionId);
    }
  }

  noteActivity(event: UnifiedAgentEvent): void {
    if (!this.host.isRunning) return;
    const now = Date.now();
    const activity = turnAttemptActivityFromEvent(event);
    this.lastObservedActivity = activity;
    if (
      this.activeAttemptId &&
      (now - this.lastAttemptActivityAt >= ATTEMPT_ACTIVITY_INTERVAL_MS ||
        this.lastAttemptActivitySource !== activity.source)
    ) {
      this.lastAttemptActivityAt = now;
      this.lastAttemptActivitySource = activity.source;
      this.ports.turnAttempts.activity(this.activeAttemptId, activity, this.host.sessionId);
    }
    this.watchdog.note(event);
    this.ports.swarmObservers.poke(this.host.workingDirectory);
  }

  sawOutput(): void {
    this.sawMeaningfulOutput = true;
  }

  observeTitle(title: string, source: 'ai' | 'custom'): void {
    this.host.observeTitle(title, source);
  }

  logProgress(event: Extract<UnifiedAgentEvent, { type: 'progress' }>): void {
    // Provider warnings are operational signals; other progress logs only with debug on.
    if (event.source === 'gemini.warning') {
      console.warn(
        `[${this.host.id}] provider warning:`,
        event.data?.message ?? JSON.stringify(event)
      );
    } else if (AGENT_CLI_DEBUG_EVENTS) {
      console.error(`[${this.host.id}] progress:`, JSON.stringify(event));
    }
  }

  noteStderr(text: string): void {
    this.stderrBuffer = (this.stderrBuffer + text).slice(-4096);
    if (VERBOSE) console.error(`[${this.host.id}] stderr:`, text);
  }

  noteFailure(cause: 'out_of_tokens' | 'provider_error', message: string): void {
    if (this.host.provider === 'codex' && message.includes('no rollout found for thread id')) {
      // Repair old phantom bindings so the next explicit retry starts a real thread.
      this.host.markSessionStarted(false);
    }
    this.terminalCauseHint = cause;
    this.providerFailureMessage = this.describeFailure(normalizeProviderErrorMessage(message));
    this.surfaceError(this.providerFailureMessage);
  }

  noteUsage(usage: Omit<ProviderTurnUsage, 'observedAt'>): void {
    // Verbatim from agent-cli, last write wins; it may go down on compaction
    // (docs/turn-lifecycle.md#provider-usage).
    this.host.providerUsage = { ...usage, observedAt: new Date().toISOString() };
    this.providerUsageDirty = true;
  }

  ensureAssistantMessage(): void {
    const host = this.host;
    const lastMsg = host.messages[host.messages.length - 1];
    if (lastMsg && lastMsg.role === 'assistant') return;
    console.log(`[${host.id}] Creating NEW assistant message (msg #${host.messages.length + 1})`);
    host.appendMessage({ role: 'assistant', body: { t: 'text', text: '' }, timestamp: new Date() });
    if (!host.isStreaming) {
      host.isStreaming = true;
      this.broadcastStatus();
    }
  }

  appendText(text: string): void {
    this.ensureAssistantMessage();
    let currentMsg = this.host.messages[this.host.messages.length - 1];
    if (currentMsg.body.t === 'parts') {
      this.host.appendMessage({
        role: 'assistant',
        body: { t: 'text', text: '' },
        timestamp: new Date(),
      });
      currentMsg = this.host.messages[this.host.messages.length - 1];
    }
    if (currentMsg.role === 'assistant' && currentMsg.body.t === 'text')
      currentMsg.body.text += text;
    if (VERBOSE)
      console.log(
        `[${this.host.id}] chunk (${text.length} chars): "${text.substring(0, 30).replace(/\n/g, '\\n')}..."`
      );
    this.ports.broadcast({ type: 'chunk', conversationId: this.host.id, text });
  }

  applyToolUse(event: ToolUseEvent): void {
    this.ensureAssistantMessage();
    this.backgroundWait.toolUse(event, this.watchdog);
    if (this.subAgentFold.toolUse(this.subAgentHost, event) === 'hide') return;
    // Codex shell completion-only events would duplicate the tool line.
    if (isCompletionOnlyToolUse(event.name, event.input, event.displayText)) return;
    const question =
      event.name === 'AskUserQuestion' ? AskUserQuestionSchema.safeParse(event.input) : null;
    const part: ContentPart = question?.success
      ? { t: 'question', question: question.data }
      : toolContentPart(event.name, event.input, event.displayText);
    this.host.appendMessage({
      role: 'assistant',
      body: { t: 'parts', parts: [part] },
      timestamp: new Date(),
    });
  }

  applySubagentState(event: Extract<UnifiedAgentEvent, { type: 'subagent.state' }>): void {
    this.ensureAssistantMessage();
    this.subAgentFold.state(this.subAgentHost, event);
  }

  applyTaskStarted(event: Extract<UnifiedAgentEvent, { type: 'task.started' }>): void {
    this.backgroundWait.taskStarted(event);
    this.subAgentFold.taskStarted(this.subAgentHost, event);
  }

  applyTaskFinished(event: Extract<UnifiedAgentEvent, { type: 'task.finished' }>): void {
    this.backgroundWait.taskFinished(event, this.watchdog);
    this.subAgentFold.taskFinished(this.subAgentHost, event);
  }

  applyToolResult(output: unknown): void {
    const parts = this.host.policy.toolResultParts(output);
    if (parts.length)
      this.host.appendMessage({
        role: 'assistant',
        body: { t: 'parts', parts },
        timestamp: new Date(),
      });
  }

  /** turn.complete: close the UI stream. Execution ownership ends only at drain. */
  completeMessage(reason: CompletionReason): void {
    const host = this.host;
    // Clear now or the timers dangle until close and can fire a spurious timeout. The
    // attempt is terminalized only at the joined drain.
    this.clearWatchdogs();
    const completedAt = new Date();
    this.closeAssistantMessage(completedAt, reason);
    this.subAgentFold.parentCompleted(this.subAgentHost, completedAt);

    // message_complete BEFORE run=idle: the client flushes its chunk buffer on it.
    this.ports.broadcast({ type: 'message_complete', conversationId: host.id, reason });

    // Finished from the user's view: clear busy now, not at child teardown.
    host.isStreaming = false;
    host.isRunning = false;
    this.releaseRunFlags();
    host.publishTurnEnd();
    this.completedCleanly = true;
    host.policy.streamCompleted();
  }

  /** Surface provider errors (usage limits, auth failures, turn errors) as a system message. */
  surfaceError(message: string): void {
    console.error(`[${this.host.id}] Provider error: ${message}`);
    // A failed spawn is reported by both the event stream and the completion promise.
    const last = this.host.messages.at(-1);
    if (last?.role === 'system' && last.body.t === 'text' && last.body.text === message) return;
    this.host.appendMessage({
      role: 'system',
      body: { t: 'text', text: message },
      timestamp: new Date(),
    });
  }

  /**
   * Fix guard: a provider binary missing from PATH surfaced as the raw `spawn codex ENOENT`, which
   * the DM view then hid, leaving an empty bubble (fresh-install trial 2026-10-05). Name the
   * provider and the command and point at Setup, in the one text every shell and every path
   * (chat, DM, @mention `Couldn't reply: …`) shows. Guard: conversation-runtime.test.ts
   * "a missing provider binary".
   */
  private describeFailure(message: string): string {
    const missing = /(?:^|[\s:])spawn (\S+) ENOENT$/.exec(message);
    if (!missing) return message;
    const provider = this.host.provider;
    return `Couldn't start ${provider}: the \`${missing[1]}\` command was not found on this server's PATH. Open Setup to install it, then send your message again.`;
  }

  // --- drain -------------------------------------------------------------------------

  private async settle(
    completion: {
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      sessionId: string;
      reason: CompletionReason;
    },
    fold: EventFold
  ): Promise<void> {
    const host = this.host;
    const { exitCode, signal, sessionId, reason } = completion;
    this.clearWatchdogs();
    if (sessionId && sessionId !== host.sessionId) await this.adoptSession(sessionId, undefined);

    // Once per turn, filed under the session settled above (docs/turn-lifecycle.md#provider-usage).
    if (this.providerUsageDirty && host.providerUsage) {
      this.providerUsageDirty = false;
      try {
        await this.ports.persistSessionUsage?.(host.id, host.sessionId, host.providerUsage);
      } catch (error) {
        // The meter is observability; a lost write never fails the turn.
        console.warn(
          `[${host.id}] Failed to persist provider usage:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    const durationMs = Date.now() - this.processStartTime;
    console.log(
      `[${host.id}] Process closed with code ${exitCode} signal=${signal ?? 'none'} (reason=${reason}) after ${durationMs}ms`
    );
    if (this.completedCleanly) {
      this.settleCleanStream(completion, fold);
      return;
    }
    this.settleCrash(completion, durationMs);
  }

  /** turn.complete (or a timeout) already closed the stream: release ownership. */
  private settleCleanStream(
    completion: { exitCode: number | null; reason: CompletionReason },
    fold: EventFold
  ): void {
    const host = this.host;
    host.policy.revoke();
    this.detachProcess();
    this.ports.clearExternalRunningStatus(host.id, host.sessionId);
    this.ports.markLocalCompletionSuppression(host.id, host.sessionId);
    if (host.turnQueue.finishHead()) host.broadcastQueue();
    const completionFailure =
      this.providerFailureMessage ??
      fold.streamError?.message ??
      fold.completionError ??
      (this.terminalCauseHint === 'out_of_tokens'
        ? 'Provider ran out of tokens'
        : this.terminalCauseHint === 'provider_error'
          ? 'Provider reported an error'
          : null);
    if (completionFailure) {
      if (this.stopCause) this.finishStopped(this.stopCause);
      else
        this.finishAttempt(
          'failed',
          this.terminalCauseHint === 'out_of_tokens' ? 'out_of_tokens' : 'provider_error'
        );
      host.emit('buddy-turn-failed', completionFailure);
    } else {
      // Review is enqueued before listeners or processQueue can start another turn.
      if (completion.reason === 'success' && completion.exitCode === 0 && !this.stopCause) {
        host.policy.reviewCompleted(host.messages);
      }
      this.finishAttempt('succeeded', 'provider_complete');
      host.emit(
        'buddy-turn-complete',
        host.messages
          .slice(this.turnMessageStart)
          .filter((message) => message.role === 'assistant')
          .map((message) => bodyText(message.body))
          .join('')
      );
    }
    host.processQueue();
  }

  /** The process ended without turn.complete: crash, kill, OOM or a silent exit. */
  private settleCrash(
    completion: { exitCode: number | null; reason: CompletionReason },
    durationMs: number
  ): void {
    const host = this.host;
    const { exitCode, reason } = completion;
    if (reason === 'killed' && this.stopCause) {
      this.finishStopped(this.stopCause);
    } else if (reason === 'out_of_tokens' || this.terminalCauseHint === 'out_of_tokens') {
      this.finishAttempt('failed', 'out_of_tokens');
    } else if (this.terminalCauseHint === 'provider_error') {
      this.finishAttempt('failed', 'provider_error');
    } else if (reason === 'killed') {
      this.finishAttempt('failed', 'process_killed');
    } else {
      this.finishAttempt('failed', 'process_exit');
    }

    const systemMessage = crashMessage(completion, stderrSnippet(this.stderrBuffer), {
      sawOutput: this.sawMeaningfulOutput,
      durationMs,
    });
    if (systemMessage) {
      if (systemMessage.level === 'error') console.error(`[${host.id}] ${systemMessage.text}`);
      host.appendMessage({
        role: 'system',
        body: { t: 'text', text: systemMessage.text },
        timestamp: new Date(),
      });
    }

    // INVARIANT: a dead process cannot stream (every path that skipped turn.complete).
    this.closeAssistantMessage(new Date(), reason || (exitCode === 0 ? 'success' : 'error'));
    host.isStreaming = false;
    host.isRunning = false;
    this.detachProcess();
    this.releaseRunFlags();
    host.policy.ended(
      reason === 'killed' ? { t: 'cancelled', detail: reason } : { t: 'failed', detail: reason }
    );
    host.emit('buddy-turn-failed', reason);
    if (host.turnQueue.finishHead()) host.broadcastQueue();
    host.processQueue();
  }

  /** The completion promise itself rejected. */
  private completionBroke(err: unknown): void {
    const host = this.host;
    this.clearWatchdogs();
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${host.id}] Process completion error: ${message}`);
    this.finishAttempt('failed', 'process_exit');
    const shown = this.describeFailure(normalizeProviderErrorMessage(message));
    this.surfaceError(shown);
    host.isStreaming = false;
    host.isRunning = false;
    this.detachProcess();
    this.broadcastStatus();
    host.policy.ended({ t: 'failed', detail: shown });
    host.emit('buddy-turn-failed', shown);
    if (host.turnQueue.length === 0) return;
    const removed = host.turnQueue.length;
    for (const entry of host.turnQueue.clearAll()) this.cancelQueuedAttempt(entry);
    console.warn(
      `[${host.id}] Cleared ${removed} pending message(s) due to process error to prevent retry loops.`
    );
    host.broadcastQueue();
  }

  // --- stop, reset, timeout ----------------------------------------------------------

  /** Stop the live process; the close handler finishes the turn. */
  stop(reason: 'user_stop' | 'server_restart'): void {
    const host = this.host;
    this.clearWatchdogs();
    const proc = host.process;
    if (!proc) return;
    this.sealed = true;
    this.stopCause = reason;
    if (this.activeAttemptId) {
      this.ports.turnAttempts.stopping(this.activeAttemptId);
      if (reason === 'server_restart') this.finishStopped(reason);
    }
    const stopTurn = this.stopTurn;
    // Never clear isRunning here: settle does, after exit, so processQueue cannot
    // start while the old process lives (start()'s guard would drop the message).
    stopTurn?.('SIGTERM');
    host.policy.ended({ t: 'cancelled' });
    escalateKill(proc, stopTurn, STOP_KILL_GRACE_MS, () =>
      console.warn(`[${host.id}] Process did not exit after SIGTERM, sending SIGKILL`)
    );
  }

  /** Kill the live process for a fresh context; late events of the old handle are ignored. */
  reset(): void {
    const host = this.host;
    this.clearWatchdogs();
    this.providerUsageDirty = false;
    const proc = host.process;
    if (!proc) return;
    const stopTurn = this.stopTurn;
    this.finishAttempt('interrupted', 'process_killed');
    this.runToken += 1;
    stopTurn?.('SIGTERM');
    escalateKill(proc, stopTurn, TURN_TIMEOUT_KILL_GRACE_MS, () =>
      console.warn(`[${host.id}] Reset process did not exit after SIGTERM, sending SIGKILL`)
    );
    this.detachProcess();
    host.isStreaming = false;
    host.isRunning = false;
    this.broadcastStatus();
  }

  /**
   * A watchdog or run deadline expired. The user-visible turn ends now, as
   * the timeout's own terminal cause (max_runtime_timeout for a deadline,
   * never user_stop); ownership still waits for the joined drain.
   */
  timeout(kind: TurnTimeoutKind): void {
    const host = this.host;
    const proc = host.process;
    if (!proc || !host.isRunning) return;
    host.policy.revoke();
    const idle = this.watchdog.idle();
    const timeout = describeTurnTimeout(kind, {
      ...idle,
      sawMeaningfulOutput: this.sawMeaningfulOutput,
    });
    const lastActivity = this.lastObservedActivity;
    console.error(
      `[${host.id}] ${timeout.message} | timeoutKind=${kind} terminalCause=${timeout.terminalCause} sawMeaningfulOutput=${this.sawMeaningfulOutput} elapsed=${idle.elapsedSeconds}s bridgeIdle=${idle.bridgeIdleSeconds}s providerIdle=${idle.providerIdleSeconds}s lastActivitySource=${lastActivity?.source ?? 'none'} lastProviderEvent=${lastActivity?.providerEventType ?? 'none'} stderr=${this.stderrBuffer.length > 0 ? 'yes' : 'no'}`
    );
    this.clearWatchdogs();
    this.surfaceError(timeout.message);
    this.finishAttempt('failed', timeout.terminalCause);

    const completedAt = new Date();
    this.closeAssistantMessage(completedAt, 'error');
    failRunningSubAgents(host.subAgents, completedAt);
    // Commit buffered text before run=idle discards the client's streaming buffer.
    this.ports.broadcast({ type: 'message_complete', conversationId: host.id, reason: 'error' });
    host.isStreaming = false;
    host.isRunning = false;
    this.releaseRunFlags();
    host.publishTurnEnd();
    // Settle takes the fast path (no duplicate message); sealed drops late answers.
    this.sealed = true;
    this.completedCleanly = true;
    host.policy.ended({ t: 'failed', detail: timeout.message });
    host.emit('buddy-turn-failed', timeout.message);

    const stopTurn = this.stopTurn;
    stopTurn?.('SIGTERM');
    escalateKill(proc, stopTurn, TURN_TIMEOUT_KILL_GRACE_MS, () =>
      console.warn(`[${host.id}] Timeout kill escalation: sending SIGKILL`)
    );
  }

  clearWatchdogs(): void {
    this.stopSwarmWatch?.();
    this.stopSwarmWatch = null;
    this.watchdog.clear();
  }

  private startWatchdogs(): void {
    this.watchdog.start();
    this.stopSwarmWatch?.();
    this.stopSwarmWatch = watchSwarmRuns(
      this.ports.swarmObservers,
      this.host.workingDirectory,
      this.subAgentHost
    );
  }

  broadcastStatus(): void {
    this.host.publishRun();
  }

  private detachProcess(): void {
    this.host.process = null;
    this.stopTurn = null;
  }

  // The local run ended: clear stale external-running flags and suppress
  // external-running detection for this run's trailing disk writes.
  private releaseRunFlags(): void {
    this.ports.clearExternalRunningStatus(this.host.id, this.host.sessionId);
    this.ports.markLocalCompletionSuppression(this.host.id, this.host.sessionId);
    this.broadcastStatus();
  }

  private closeAssistantMessage(completedAt: Date, reason: CompletionReason): void {
    const last = this.host.messages.at(-1);
    if (last?.role !== 'assistant' || last.completedAt) return;
    last.completedAt = completedAt;
    last.completionReason = reason;
  }
}

/** One turn's event stream folded into its runner: one handler per event type. */
class EventFold {
  streamError: Error | null = null;
  // A failing turn.complete fails automation although the stream closed cleanly.
  completionError: string | null = null;

  constructor(
    private readonly runner: TurnRunner,
    private readonly runToken: number
  ) {}

  async consume(events: AsyncIterable<UnifiedAgentEvent>): Promise<void> {
    for await (const event of events) {
      if (!this.runner.isCurrent(this.runToken)) return;
      // Late events after a timeout/stop cannot resurrect the turn.
      if (this.runner.streamClosed) continue;
      this.runner.noteActivity(event);
      await this.apply(event);
    }
  }

  private async apply(event: UnifiedAgentEvent): Promise<void> {
    const runner = this.runner;
    switch (event.type) {
      case 'session.started':
        await runner.bindSession(event.sessionId);
        return;
      case 'session.title':
        runner.observeTitle(event.title, event.source);
        return;
      case 'turn.started':
        runner.ensureAssistantMessage();
        return;
      case 'text.delta':
        runner.sawOutput();
        runner.appendText(event.text);
        return;
      case 'tool.use':
        runner.sawOutput();
        runner.applyToolUse(event);
        return;
      case 'tool.result':
        if (!event.isError) runner.applyToolResult(event.output);
        return;
      case 'turn.complete':
        this.completionError = completionFailure(event.reason);
        runner.completeMessage(event.reason);
        return;
      case 'out_of_tokens':
        runner.noteFailure('out_of_tokens', event.message);
        return;
      case 'error':
        runner.noteFailure('provider_error', event.message);
        return;
      case 'stderr':
        runner.noteStderr(event.text);
        return;
      case 'progress':
        runner.logProgress(event);
        return;
      case 'usage':
        runner.noteUsage(event.usage);
        return;
      case 'subagent.state':
        runner.sawOutput();
        runner.applySubagentState(event);
        return;
      case 'task.started':
        runner.applyTaskStarted(event);
        return;
      case 'task.finished':
        runner.applyTaskFinished(event);
        return;
    }
  }
}

function completionFailure(reason: CompletionReason): string | null {
  switch (reason) {
    case 'success':
      return null;
    case 'error':
    case 'out_of_tokens':
      return `Provider completed the turn with reason: ${reason}`;
    case 'killed':
      return 'Provider turn was interrupted';
  }
}

/** The system line a crashed turn leaves, by how it ended. */
function crashMessage(
  completion: { exitCode: number | null; reason: CompletionReason },
  details: string,
  run: { sawOutput: boolean; durationMs: number }
): { level: 'error' | 'info'; text: string } | null {
  const { exitCode, reason } = completion;
  // The completion reason first: it carries protocol failures that look like clean exits.
  if (reason === 'killed') {
    return {
      level: 'error',
      text: details
        ? `Process interrupted before completion: ${details}`
        : 'Process interrupted before completion',
    };
  }
  if (reason === 'error') {
    const text =
      exitCode !== null && exitCode !== 0
        ? details
          ? `Process exited with code ${exitCode}: ${details}`
          : `Process exited with code ${exitCode}`
        : details
          ? `Provider exited before completing the turn: ${details}`
          : 'Provider exited before completing the turn';
    return { level: 'error', text };
  }
  if (exitCode === 0 && !run.sawOutput) {
    // A silent zero-exit without any streamed output is a provider failure.
    return {
      level: 'error',
      text: details
        ? `Provider reported an error without response output: ${details}`
        : 'Provider exited without response output',
    };
  }
  if (reason === 'out_of_tokens') return null;
  return {
    level: 'info',
    text: `Process completed successfully in ${(run.durationMs / 1000).toFixed(1)}s`,
  };
}

function escalateKill(
  proc: ChildProcess,
  stopTurn: ((signal?: NodeJS.Signals) => void) | null,
  graceMs: number,
  warn: () => void
): void {
  const killTimer = setTimeout(() => {
    if (proc.exitCode !== null) return;
    warn();
    stopTurn?.('SIGKILL');
  }, graceMs);
  proc.once('close', () => clearTimeout(killTimer));
}

function stripAnsi(value: string): string {
  const ansiEscapeSequence = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  return value.replace(ansiEscapeSequence, '');
}

function stderrSnippet(value: string, maxLength = 400): string {
  const cleaned = stripAnsi(value).replace(/\r/g, '\n').trim();
  if (!cleaned) return '';
  const tail = cleaned.slice(-1200).replace(/\s+/g, ' ').trim();
  if (!tail) return '';
  return tail.length > maxLength ? `${tail.slice(0, maxLength - 3)}...` : tail;
}

const OUT_OF_TOKENS_PATTERN =
  /out of tokens|token limit|usage limit|insufficient (?:credits|balance)|exceeded(?: your)?(?: current)? quota|credit balance|rate limit exceeded/i;

// Harnesses sometimes hand back the raw API error envelope
// ({"error":{"message":…}}); the owner should read the message, not the JSON.
function providerErrorText(message: string): string {
  const trimmed = message.trim();
  if (!trimmed.startsWith('{')) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as { error?: { message?: unknown }; message?: unknown };
    const inner = parsed.error?.message ?? parsed.message;
    if (typeof inner === 'string' && inner.trim()) return inner.trim();
  } catch {
    // Prose that starts with a brace, not an envelope.
  }
  return trimmed;
}

function normalizeProviderErrorMessage(message: string): string {
  const trimmed = providerErrorText(message);
  if (!trimmed) return 'Unknown provider error';
  if (!OUT_OF_TOKENS_PATTERN.test(trimmed)) return trimmed;
  if (/^out of tokens:/i.test(trimmed)) return trimmed;
  return `Out of tokens: ${trimmed}`;
}
