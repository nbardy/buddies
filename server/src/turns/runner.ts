import crypto from 'node:crypto';
import type {
  ExecuteCommandRequest,
  ExecutionHandle,
  UnifiedAgentEvent,
  executeCommand,
} from '@nbardy/agent-cli';
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
import type { BackgroundWork } from './background-work';
import type { Effect, Execution, ExecutionOutcome, Phase, StopIntent } from './execution-state';
import type { ExecutionJournals, TurnOwner } from './executions';
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
const SETTLE_RETRY_MS = 5_000;

/** The conversation as one turn sees it. */
export interface TurnRunnerHost {
  readonly id: string;
  readonly workingDirectory: string;
  readonly resumedFromConversationId: string | null;
  sessionId: string;
  messages: Message[];
  subAgents: SubAgent[];
  /** The live execution (spawned here or adopted): its journal, not a child pipe. */
  process: ExecutionHandle | null;
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
  broadcast(data: ServerMessageInput): void;
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
  /** Where each turn's execution is journaled, so a replacement backend can adopt it. */
  executions: ExecutionJournals;
  turnAttempts: RuntimeTurnAttemptObserver;
  swarmObservers: SwarmObservers;
  /** Which background tasks of a turn finished, for a turn whose model is idle (background-work.ts). */
  backgroundWork: BackgroundWork;
}

/** The command named by agent-cli's canonical `spawn <cmd> ENOENT` failure, or null. */
function missingCommand(message: string): string | null {
  return /(?:^|[\s:])spawn (\S+) ENOENT$/.exec(message)?.[1] ?? null;
}

export class TurnRunner {
  // Per-run token: every late event/completion from a replaced handle is ignored.
  private runToken = 0;
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
  // The live execution's journal and phase (execution-state.ts); null between turns.
  private execution: Execution | null = null;
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

  /** Make the prepared (or a new) attempt the active one; `start` takes its id (core review T5). */
  beginAttempt(): string {
    const attemptId = this.nextAttempt ?? this.createQueuedAttempt();
    this.activeAttemptId = attemptId;
    this.nextAttempt = null;
    return attemptId;
  }

  finishAttempt(state: AttemptState, terminalCause: TurnTerminalCause): void {
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
  }

  /** The turn ended: drop its queue head, settle its durable row, tell the clients. */
  private finishHead(): void {
    const done = this.host.turnQueue.finishHead();
    if (!done) return;
    this.host.policy.carrier.settle(done);
    this.host.broadcastQueue();
  }

  /**
   * An entry left the queue unsent (cancelled, cleared, dropped): its attempt ends cancelled and
   * its durable row ends with it. Every removal path calls this one function.
   */
  cancelQueuedAttempt(entry: QueueEntry): void {
    this.host.policy.carrier.cancel(entry);
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
    attemptId: string;
    content: string;
    config: ResolvedExecutionConfig;
    forkSourceSessionId: string | undefined;
    resume: boolean;
    input: TurnInput;
    /** The user row this turn appended (history text and time), kept for adoption. */
    userMessage: { text: string; timestamp: Date };
  }): void {
    // Busy is refused once, at sendMessageInternal (runtime.ts), its only caller's caller.
    const host = this.host;
    const runToken = ++this.runToken;

    const forking = !!turn.forkSourceSessionId;
    const executionMode = forking ? 'fork' : turn.resume ? 'resume' : 'fresh';
    console.log(
      `[${host.id}] Spawning ${turn.config.provider} (mode=${executionMode}, provider-session=${host.sessionId.substring(0, 8)}...${turn.forkSourceSessionId ? `, fork-source-session=${turn.forkSourceSessionId.substring(0, 8)}...` : ''}${host.resumedFromConversationId ? `, parent-conversation=${host.resumedFromConversationId.substring(0, 8)}...` : ''})`
    );
    console.log(`[${host.id}] Message: "${turn.content.substring(0, 50)}"`);

    this.beginTurnState(turn.config.provider, Date.now());
    const { attemptId } = turn;
    this.ports.turnAttempts.starting(attemptId);
    this.ports.turnAttempts.activity(
      attemptId,
      {
        source: 'runtime',
        providerEventType: `execution.${executionMode}`,
        providerEventSource: host.resumedFromConversationId
          ? `parent-conversation:${host.resumedFromConversationId}`
          : 'unleashd.runtime',
      },
      host.sessionId
    );

    let handle: ExecutionHandle;
    let execution: Execution;
    try {
      const extras = host.policy.startTurn(turn.input, turn.config);
      // Owner and `running` phase are on disk before the provider exists (turns/executions.ts).
      execution = this.ports.executions.forTurn({
        conversationId: host.id,
        attemptId,
        provider: turn.config.provider,
        userMessage: {
          text: turn.userMessage.text,
          timestamp: turn.userMessage.timestamp.toISOString(),
        },
        startedAt: new Date(this.processStartTime).toISOString(),
        policy: host.policy.adoptionRecord(),
      });
      // One request shape for every harness; the cast covers agent-cli's `never` effort typing
      // on harnesses without effort (docs/turn-lifecycle.md#one-request-shape).
      handle = this.spawnInto(execution, {
        harness: turn.config.provider,
        mode: 'conversation',
        prompt: turn.content,
        cwd: host.workingDirectory,
        model: turn.config.modelId,
        resumeSessionId: turn.resume ? host.sessionId : undefined,
        forkSessionId: forking ? turn.forkSourceSessionId : undefined,
        yolo: true,
        journalDir: execution.dir,
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
      attemptId,
      messageStart: Math.max(0, host.messages.length - 1),
    });
    // Spawn only: an adopted attempt is already running in the journal of the boot that spawned it.
    this.ports.turnAttempts.running(attemptId, host.sessionId);
    this.follow(handle, runToken, execution);
  }

  /**
   * A spawn that throws is never followed, so no drain will ever remove the journal `forTurn` just
   * wrote (core review I1, 2026-10-07). It may still have a child: `discardAt` kills one the journal
   * names before removing it. Guards: conversation-runtime "a spawn that throws …" (both tests).
   */
  private spawnInto(execution: Execution, request: ExecuteCommandRequest): ExecutionHandle {
    try {
      return this.ports.executeTurn(request);
    } catch (error) {
      this.ports.executions.discardAt(execution.dir);
      throw error;
    }
  }

  /**
   * A replacement backend takes over a turn another backend spawned, in the phase its journal
   * holds (execution-state.ts ADOPTIONS decided `effects`). The overlay already holds the turn's
   * user row; the journal replays from byte 0 through the same fold, so this backend ends up
   * where a never-restarted one would be. A `stopping` turn is sealed first, as its live stop
   * sealed it, so nothing it wrote after the stop folds in. Guards: execution-adoption.test.ts
   * (the kill-grace and drain-to-settle crash tests) and execution-crash-checker.test.ts.
   */
  // Pattern: persisted-state-machine (docs/patterns.md#persisted-state-machine)
  adopt(owner: TurnOwner, handle: ExecutionHandle, phase: Phase, effects: readonly Effect[]): void {
    const host = this.host;
    const runToken = ++this.runToken;
    console.log(`[${host.id}] Adopting ${phase.t} ${owner.provider} turn (pid ${handle.pid})`);
    const execution: Execution = { dir: handle.journalDir, phase };
    this.activeAttemptId = owner.attemptId;
    this.ports.turnAttempts.activity(
      owner.attemptId,
      {
        source: 'runtime',
        providerEventType: 'execution.adopted',
        providerEventSource: 'unleashd.runtime',
      },
      host.sessionId
    );
    ADOPTED[phase.t](this, owner, phase as never, () => this.follow(handle, runToken, execution));
    void this.perform(effects, handle, execution);
  }

  /** Clocks from the turn's own start: a live turn's runtime budget is not renewed per backend. */
  adoptRunning(owner: TurnOwner, follow: () => void): void {
    this.beginTurnState(owner.provider, Date.parse(owner.startedAt));
    follow();
  }

  /** A turn the old backend was stopping: sealed again, and a timeout's notice shown again. */
  adoptStopping(owner: TurnOwner, intent: StopIntent, follow: () => void): void {
    this.beginTurnState(owner.provider, Date.parse(owner.startedAt));
    follow();
    this.clearWatchdogs();
    this.sealed = true;
    STOP_SHOWN[intent.t](this, intent as never);
  }

  /** Its outcome is on disk: a clock that ran out during the gap must not seal its replay. */
  adoptEnded(owner: TurnOwner, follow: () => void): void {
    this.beginTurnState(owner.provider, Date.now());
    follow();
  }

  /** Per-turn state, fresh for a spawn or an adoption. */
  private beginTurnState(provider: ResolvedExecutionConfig['provider'], startedAt: number): void {
    const host = this.host;
    // This session is now being handled locally; clear any stale external flags.
    this.ports.clearExternalRunningStatus(host.id, host.sessionId);
    this.ports.clearLocalCompletionSuppression(host.id, host.sessionId);
    this.stderrBuffer = '';
    this.turnMessageStart = host.messages.length;
    this.sawMeaningfulOutput = false;
    this.completedCleanly = false;
    this.sealed = false;
    this.terminalCauseHint = null;
    this.providerFailureMessage = null;
    this.processStartTime = startedAt;
    this.lastAttemptActivityAt = 0;
    this.lastAttemptActivitySource = null;
    this.lastObservedActivity = null;
    this.subAgentFold = subAgentFoldFor(provider);
    this.ports.backgroundWork.turnStarted(host.id);
  }

  /** The one read path: a spawned and an adopted turn are both followed from their journal. */
  private follow(handle: ExecutionHandle, runToken: number, execution: Execution): void {
    const host = this.host;
    host.process = handle;
    this.execution = execution;
    host.isRunning = true;
    host.emit('buddy-turn-started');
    this.startWatchdogs();
    this.broadcastStatus();

    const fold = new EventFold(this, runToken);
    const eventConsumption = fold.consume(handle.events).catch((err: unknown) => {
      if (runToken !== this.runToken) return;
      fold.streamError = err instanceof Error ? err : new Error(String(err));
      console.error(`[${host.id}] Event stream error: ${fold.streamError.message}`);
      this.terminalCauseHint = 'provider_error';
      this.surfaceError(normalizeProviderErrorMessage(fold.streamError.message));
    });

    const turnDrain = handle.completed
      .then(async (completion) => {
        // Child exit is not event-stream EOF: settle only after both join
        // (docs/turn-lifecycle.md#one-terminal-path).
        if (runToken === this.runToken) await eventConsumption;
        // Superseded by a reset: the execution is `abandoned`, and its drain only removes it.
        if (runToken !== this.runToken)
          return this.perform(
            this.ports.executions.step(execution, { t: 'drained', observed: crashed(completion) }),
            handle,
            execution
          );
        await this.drained(completion, fold, handle, execution);
      })
      .catch((err: unknown) => {
        if (runToken !== this.runToken) return;
        return this.completionBroke(err, handle, execution);
      });
    this.activeDrain = turnDrain;
    void turnDrain.finally(() => {
      if (this.activeDrain !== turnDrain) return;
      this.activeDrain = null;
      this.ports.backgroundWork.turnEnded(host.id);
    });
  }

  /**
   * Run a step's effects, in order, after `ExecutionJournals.step` persisted its phase. Each
   * handler is one straight path (EFFECTS); only `settle` is asynchronous.
   */
  perform(
    effects: readonly Effect[],
    handle: ExecutionHandle,
    execution: Execution
  ): Promise<void> {
    return Promise.all(
      effects.map((effect) => EFFECTS[effect.t](this, effect as never, handle, execution))
    ).then(() => undefined);
  }

  /** Effect `signal`: SIGTERM the group now, SIGKILL it after the grace. */
  signal(handle: ExecutionHandle): void {
    handle.stop('SIGTERM');
    escalateKill(handle, TURN_TIMEOUT_KILL_GRACE_MS, () =>
      console.warn(`[${this.host.id}] Process did not exit after SIGTERM, sending SIGKILL`)
    );
  }

  /**
   * Effect `settle`: the attempt record and the turn-end events, then the run's settle, awaited.
   * Only once it landed is the execution `settled` and its journal removed; a crash before that
   * leaves it `ended(outcome)` and the next backend settles that same outcome (2b).
   */
  async settleOutcome(
    outcome: ExecutionOutcome,
    handle: ExecutionHandle,
    execution: Execution
  ): Promise<void> {
    const host = this.host;
    SETTLED[outcome.t](this, outcome as never);
    host.processQueue();
    for (;;) {
      try {
        await host.policy.settle(outcome);
        break;
      } catch (error) {
        // Transient (a busy store): `ended` stays on disk while this backend keeps trying.
        console.error(`[${host.id}] run settle failed; retrying:`, error);
        await new Promise((resolve) => setTimeout(resolve, SETTLE_RETRY_MS).unref());
      }
    }
    await this.perform(this.ports.executions.step(execution, { t: 'landed' }), handle, execution);
  }

  revokeGrant(): void {
    this.host.policy.revoke();
  }

  armDeadline(): void {
    this.host.policy.armDeadline();
  }

  /** The attempt's terminal record and the turn-end event every listener awaits. */
  finishWith(state: AttemptState, cause: TurnTerminalCause, event: string, detail: string): void {
    this.finishAttempt(state, cause);
    this.host.emit(event, detail);
  }

  removeJournal(execution: Execution): void {
    if (this.execution === execution) this.execution = null;
    this.ports.executions.remove(execution.dir);
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
    // The same signal renews a Buddy run's lease: a live bridge means a live holder (lease ≠
    // deadline; see BuddyTurnPolicy.bridgeAlive).
    this.host.policy.bridgeAlive();
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
    const command = missingCommand(message);
    // Fix guard: a provider binary missing from PATH reached the owner as nothing (an empty DM
    // bubble, fresh-install trial 2026-10-05). The journaled wrapper is `/bin/sh`, so agent-cli
    // reports exit 127 as `spawn <cmd> ENOENT` (execute.ts missingBinaryError); it becomes the
    // journaled `spawn_failed` cause, which survives a restart, plus one text naming the provider.
    // Guard: conversation-runtime.test.ts "a missing provider binary".
    this.terminalCauseHint = command ? 'spawn_failed' : cause;
    this.providerFailureMessage = command
      ? `Couldn't start ${this.host.provider}: the \`${command}\` command was not found on this server's PATH. Open Setup to install it, then send your message again.`
      : normalizeProviderErrorMessage(message);
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
    this.subAgentFold.taskStarted(this.subAgentHost, event);
  }

  applyTaskFinished(event: Extract<UnifiedAgentEvent, { type: 'task.finished' }>): void {
    this.ports.backgroundWork.taskFinished(this.host.id, event.taskId);
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
    this.host.appendMessage({
      role: 'system',
      body: { t: 'text', text: message },
      timestamp: new Date(),
    });
  }

  // --- drain -------------------------------------------------------------------------

  /**
   * The process ended and every event folded. Show it (in memory), then step `drained` with what
   * the stream showed: the transition decides the outcome (a stop's intent overrides the stream)
   * and persists `ended(outcome)` BEFORE the settle effect runs.
   */
  private async drained(
    completion: Completion,
    fold: EventFold,
    handle: ExecutionHandle,
    execution: Execution
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
    const observed = this.completedCleanly
      ? this.showCleanEnd(completion, fold)
      : this.showCrash(completion, durationMs);
    await this.perform(
      this.ports.executions.step(execution, { t: 'drained', observed }),
      handle,
      execution
    );
  }

  /** turn.complete (or a timeout) already closed the stream: release ownership. */
  private showCleanEnd(completion: Completion, fold: EventFold): ExecutionOutcome {
    const host = this.host;
    this.detachProcess();
    this.ports.clearExternalRunningStatus(host.id, host.sessionId);
    this.ports.markLocalCompletionSuppression(host.id, host.sessionId);
    this.finishHead();
    const failure =
      this.providerFailureMessage ??
      fold.streamError?.message ??
      fold.completionError ??
      (this.terminalCauseHint === 'out_of_tokens'
        ? 'Provider ran out of tokens'
        : this.terminalCauseHint === 'provider_error'
          ? 'Provider reported an error'
          : null);
    if (failure)
      return {
        t: 'failed',
        cause:
          this.terminalCauseHint === 'out_of_tokens' || this.terminalCauseHint === 'spawn_failed'
            ? this.terminalCauseHint
            : 'provider_error',
        detail: failure,
      };
    // Review is enqueued before listeners or processQueue can start another turn. Not after a
    // stop or timeout (sealed): that outcome is the stop's, never a completion.
    if (completion.reason === 'success' && completion.exitCode === 0 && !this.sealed)
      host.policy.reviewCompleted(host.messages);
    return {
      t: 'complete',
      text: host.messages
        .slice(this.turnMessageStart)
        .filter((message) => message.role === 'assistant')
        .map((message) => bodyText(message.body))
        .join(''),
    };
  }

  /** The process ended without turn.complete: crash, kill, OOM or a silent exit. */
  private showCrash(completion: Completion, durationMs: number): ExecutionOutcome {
    const host = this.host;
    const { exitCode, reason } = completion;
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
    this.finishHead();
    const cause: TurnTerminalCause =
      reason === 'out_of_tokens' || this.terminalCauseHint === 'out_of_tokens'
        ? 'out_of_tokens'
        : this.terminalCauseHint === 'provider_error' || this.terminalCauseHint === 'spawn_failed'
          ? this.terminalCauseHint
          : crashed(completion).cause;
    return { t: 'failed', cause, detail: reason };
  }

  /** The completion promise itself rejected: the turn ended without a known exit. */
  private completionBroke(
    err: unknown,
    handle: ExecutionHandle,
    execution: Execution
  ): Promise<void> {
    const host = this.host;
    this.clearWatchdogs();
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${host.id}] Process completion error: ${message}`);
    this.surfaceError(normalizeProviderErrorMessage(message));
    host.isStreaming = false;
    host.isRunning = false;
    this.detachProcess();
    this.broadcastStatus();
    if (host.turnQueue.length > 0) {
      const removed = host.turnQueue.length;
      for (const entry of host.turnQueue.clearAll()) this.cancelQueuedAttempt(entry);
      console.warn(
        `[${host.id}] Cleared ${removed} pending message(s) due to process error to prevent retry loops.`
      );
      host.broadcastQueue();
    }
    const observed: ExecutionOutcome = { t: 'failed', cause: 'process_exit', detail: message };
    return this.perform(
      this.ports.executions.step(execution, { t: 'drained', observed }),
      handle,
      execution
    );
  }

  // --- stop, reset, timeout ----------------------------------------------------------

  /**
   * An owner Stop. `stopping` is on disk before the grant is revoked and the group signalled, so
   * a backend that dies inside the kill grace leaves a turn the next one signals again and never
   * adopts as live (2a). The drain finishes the turn: settle clears isRunning after exit, so
   * processQueue cannot start while the old process lives (start()'s guard would drop the message).
   */
  stop(): void {
    this.clearWatchdogs();
    const proc = this.host.process;
    const execution = this.execution;
    if (!proc || !execution) return;
    this.sealed = true;
    if (this.activeAttemptId) this.ports.turnAttempts.stopping(this.activeAttemptId);
    void this.perform(
      this.ports.executions.step(execution, { t: 'stop', intent: { t: 'user_stop' } }),
      proc,
      execution
    );
  }

  /** Kill the live process for a fresh context; late events of the old handle are ignored. */
  reset(): void {
    const host = this.host;
    this.clearWatchdogs();
    this.providerUsageDirty = false;
    const proc = host.process;
    const execution = this.execution;
    if (!proc || !execution) return;
    this.finishAttempt('interrupted', 'process_killed');
    this.runToken += 1;
    // `abandoned` first: a crash before it exits must not let the next backend adopt it beside
    // the fresh turn that replaces it (execution-state.ts ADOPTIONS discards it).
    void this.perform(this.ports.executions.step(execution, { t: 'abandon' }), proc, execution);
    this.detachProcess();
    host.isStreaming = false;
    host.isRunning = false;
    this.broadcastStatus();
  }

  /**
   * A watchdog or run deadline expired. The intent is on disk before the signal, with its exact
   * message, so an adopting backend ends the turn the same way (2a). The user-visible turn ends
   * now, as the timeout's own terminal cause (max_runtime_timeout for a deadline, never
   * user_stop); the run settles at the joined drain.
   */
  timeout(kind: TurnTimeoutKind): void {
    const host = this.host;
    const proc = host.process;
    const execution = this.execution;
    if (!proc || !execution || !host.isRunning || this.sealed) return;
    const idle = this.watchdog.idle();
    const intent: StopIntent = {
      t: 'timeout',
      ...describeTurnTimeout(kind, { ...idle, sawMeaningfulOutput: this.sawMeaningfulOutput }),
    };
    const lastActivity = this.lastObservedActivity;
    console.error(
      `[${host.id}] ${intent.message} | timeoutKind=${kind} terminalCause=${intent.terminalCause} sawMeaningfulOutput=${this.sawMeaningfulOutput} elapsed=${idle.elapsedSeconds}s bridgeIdle=${idle.bridgeIdleSeconds}s providerIdle=${idle.providerIdleSeconds}s lastActivitySource=${lastActivity?.source ?? 'none'} lastProviderEvent=${lastActivity?.providerEventType ?? 'none'} stderr=${this.stderrBuffer.length > 0 ? 'yes' : 'no'}`
    );
    void this.perform(
      this.ports.executions.step(execution, { t: 'stop', intent }),
      proc,
      execution
    );
    this.showTimeout(intent);
  }

  /** A timed-out turn's end, shown now (live) or again (adopted while `stopping`). */
  showTimeout(timeout: Extract<StopIntent, { t: 'timeout' }>): void {
    const host = this.host;
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
    // The drain takes the clean path (no duplicate message); sealed drops late answers.
    this.sealed = true;
    this.completedCleanly = true;
  }

  clearWatchdogs(): void {
    this.stopSwarmWatch?.();
    this.stopSwarmWatch = null;
    this.watchdog.clear();
  }

  private startWatchdogs(): void {
    this.watchdog.start(this.processStartTime, this.host.policy.maxRuntimeMs);
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

type Completion = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  sessionId: string;
  reason: CompletionReason;
};

/** A process end read from its completion alone (a crash, or a reset turn's drain). */
function crashed(completion: Completion): Extract<ExecutionOutcome, { t: 'failed' }> {
  const cause = completion.reason === 'killed' ? 'process_killed' : 'process_exit';
  return { t: 'failed', cause, detail: completion.reason };
}

// One straight-line handler per case; the dispatchers above only index these tables.
type EffectHandlers = {
  readonly [E in Effect as E['t']]: (
    runner: TurnRunner,
    effect: E,
    handle: ExecutionHandle,
    execution: Execution
  ) => void | Promise<void>;
};
const EFFECTS: EffectHandlers = {
  revoke_grant: (runner) => runner.revokeGrant(),
  signal: (runner, _, handle) => runner.signal(handle),
  arm_deadline: (runner) => runner.armDeadline(),
  settle: (runner, { outcome }, handle, execution) =>
    runner.settleOutcome(outcome, handle, execution),
  remove: (runner, _, __, execution) => runner.removeJournal(execution),
};

/** How an adopted turn resumes, by the phase on disk (abandoned and settled are discarded). */
const ADOPTED: {
  readonly [P in Phase as P['t']]: (
    runner: TurnRunner,
    owner: TurnOwner,
    phase: P,
    follow: () => void
  ) => void;
} = {
  running: (runner, owner, _, follow) => runner.adoptRunning(owner, follow),
  stopping: (runner, owner, { intent }, follow) => runner.adoptStopping(owner, intent, follow),
  ended: (runner, owner, _, follow) => runner.adoptEnded(owner, follow),
  abandoned: () => {
    throw new Error('an abandoned execution is discarded, never adopted');
  },
  settled: () => {
    throw new Error('a settled execution is discarded, never adopted');
  },
};

/** What an adopted `stopping` turn shows again: a live stop showed nothing until its drain. */
const STOP_SHOWN: {
  readonly [I in StopIntent as I['t']]: (runner: TurnRunner, intent: I) => void;
} = {
  user_stop: () => undefined,
  timeout: (runner, intent) => runner.showTimeout(intent),
};

/** The attempt record and turn-end event of each outcome. */
const SETTLED: {
  readonly [O in ExecutionOutcome as O['t']]: (runner: TurnRunner, outcome: O) => void;
} = {
  complete: (runner, { text }) =>
    runner.finishWith('succeeded', 'provider_complete', 'buddy-turn-complete', text),
  failed: (runner, { cause, detail }) =>
    runner.finishWith('failed', cause, 'buddy-turn-failed', detail),
  cancelled: (runner, { detail }) =>
    runner.finishWith('cancelled', 'user_stop', 'buddy-turn-failed', detail),
};

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

/** SIGKILL the execution's group if it has not ended within the grace. */
function escalateKill(handle: ExecutionHandle, graceMs: number, warn: () => void): void {
  const killTimer = setTimeout(() => {
    warn();
    handle.stop('SIGKILL');
  }, graceMs);
  // The group runs on its own; this timer alone must not hold a backend (or a test) open.
  killTimer.unref();
  const clear = () => clearTimeout(killTimer);
  handle.completed.then(clear, clear);
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
