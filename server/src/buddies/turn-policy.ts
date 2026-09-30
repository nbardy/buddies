import crypto from 'node:crypto';
import { harnessMcpCapability } from '@nbardy/agent-cli';
import type {
  BuddyContext,
  BuddyKind,
  BuddyVisibility,
  ContentPart,
  Message,
  Provider as ProviderName,
  ResolvedExecutionConfig,
} from '@unleashd/shared';
import { parseBuddyBuilderToolResult } from '@unleashd/shared';
import type { ConversationRuntimeView } from '../conversations/runtime';
import type { TurnTerminalCause } from '../observability';
import { noteActivity } from '../observability/event-loop-stall';
import { type SessionRelativePrompt, type TurnInput, sameEitherWay } from '../turns/input';
import {
  type AdoptedReview,
  type CoordinationDrained,
  type MemorySnapshot,
  type PolicyAdoption,
  type TurnEnd,
  type TurnGate,
  type TurnPolicy,
  commonToolResultParts,
} from '../turns/policy';
import { BUDDY_BUILDER_BRIEFING } from './builder';
import type { GrantRecord } from './grants';
import { HARNESS_MEMORY_OFF } from './harness-memory';
import type { BuddyPolicyPort } from './policy-port';
import type { OwnedChatRun } from './runner';

/**
 * The Buddy and Buddy Builder turn policies: what a Buddy thread adds to a turn (run-slot
 * admission, the briefing and memory snapshot, the turn's one MCP server and grant, background
 * runs, memory review). Everything Buddy-specific goes through `BuddyPolicyPort` (policy-port.ts),
 * so this file holds only the turn-shaped part. T11 removed the old package's audience fence,
 * legacy automation and delegation settlement, conversation-link status and turn-origin audit.
 */

export type { MemorySnapshot } from '../turns/policy';

/** What the Buddy policies need from the host server: the Buddy module. */
export interface BuddyTurnPolicyDependencies {
  buddies: BuddyPolicyPort;
}

/** What a Buddy policy may see and do on its conversation. */
export interface BuddyPolicyHost {
  readonly id: string;
  readonly workingDirectory: string;
  readonly view: ConversationRuntimeView;
  visibility(): BuddyVisibility;
  provider(): ProviderName;
  hasProcess(): boolean;
  hasStartedSession(): boolean;
  resetProcess(): void;
  /** A sending queue head that did not start goes back to pending. */
  releaseQueueHead(broadcast: boolean): void;
  /** Drop a pending head whose turn will never start (cancels its attempt). */
  dropPendingHead(): void;
  processQueue(): void;
  maxRuntimeReached(): void;
  refuseAutomationTranscript(message?: string): void;
  send(prompt: SessionRelativePrompt, input: TurnInput): void;
  on(event: string, listener: (...args: string[]) => void): void;
  once(event: string, listener: (...args: string[]) => void): void;
  off(event: string, listener: (...args: string[]) => void): void;
  emit(event: string, ...args: string[]): void;
}

// --- Memory snapshots -----------------------------------------------------

/** Boundary input accepts a numeric generation; the runtime stores only an opaque string. */
export type MemoryGenerationInput = string | number;

/** A briefing with no generation is identified by its own hash. */
export function createMemorySnapshot(
  briefing: string | null | undefined,
  generation?: MemoryGenerationInput | null
): MemorySnapshot | null {
  if (briefing === null || briefing === undefined) return null;
  const given = generation === null || generation === undefined ? '' : String(generation).trim();
  const hashed = () =>
    `briefing-sha256:${crypto.createHash('sha256').update(briefing, 'utf8').digest('hex')}`;
  return Object.freeze({ briefing, generation: given || hashed() });
}

// --- First-turn provider prompts ---------------------------------------------
// History keeps clean user text; only the provider sees the markers.

function buddyBriefedPrompt(context: BuddyContext, memory: MemorySnapshot, content: string) {
  const encodedContext = Buffer.from(JSON.stringify(context), 'utf8').toString('base64url');
  const encodedGeneration = Buffer.from(memory.generation, 'utf8').toString('base64url');
  const briefing = `<!-- unleashd:buddy-memory-generation ${encodedGeneration} -->\n${memory.briefing}`;
  return `<!-- unleashd:buddy-context-v2 ${encodedContext} ${briefing.length} -->\n${briefing}\n<!-- /unleashd:buddy-context-v2 -->\n\n${content}`;
}

function builderFirstTurnPrompt(
  content: string,
  firstUnstartedTurn: boolean,
  workingDirectory: string
): string {
  if (!firstUnstartedTurn) return content;
  return `<!-- unleashd:buddy-builder-v1 ${BUDDY_BUILDER_BRIEFING.length} -->\n${BUDDY_BUILDER_BRIEFING}\n<!-- /unleashd:buddy-builder-v1 -->\nWorking directory: ${workingDirectory}\n\n${content}`;
}

// --- Run-slot admission tick -----------------------------------------------

const CHAT_ADMISSION_POLL_MS = 1000;

/**
 * ONE admission tick shared by every Buddy chat waiting for a run slot (until 2026-09-25 each
 * waiting conversation owned its own 1 s interval). It exists only while someone waits. The
 * runner admits a chat when it claims its run, which any write or settle can trigger; the tick
 * reads that synchronous admission for the conversations still waiting.
 */
// Pattern: wake-on-write (docs/patterns.md#wake-on-write)
const admissionWaiters = new Set<() => void>();
let admissionTick: ReturnType<typeof setInterval> | null = null;

/** Retry `admit` on the shared tick until the returned function is called. */
function waitForChatRunSlot(admit: () => void): () => void {
  admissionWaiters.add(admit);
  admissionTick ??= setInterval(() => {
    noteActivity('timer buddy-chat-admission');
    for (const waiter of [...admissionWaiters]) waiter();
  }, CHAT_ADMISSION_POLL_MS);
  return () => {
    admissionWaiters.delete(admit);
    if (admissionWaiters.size > 0 || !admissionTick) return;
    clearInterval(admissionTick);
    admissionTick = null;
  };
}

/**
 * Buddy identity is an authority boundary, so Buddy turns require a harness with an explicit
 * required-MCP contract rather than best-effort injection (invariant I11 in
 * agent_notes/2026-08-24_automation-execution-ownership-design.md).
 */
function assertBuddyProviderSupportsMcp(provider: ProviderName): void {
  if (harnessMcpCapability(provider) === 'required') return;
  throw new Error(
    `Provider "${provider}" cannot start Buddy conversations because its harness cannot guarantee required Buddy state tools.`
  );
}

function rejectAutomation(): never {
  throw new Error('Legacy automation transcripts are read-only; schedules run as Buddy runs now');
}

/**
 * Call `done` once, when the turn drains. A failure while the process still runs waits for the
 * drain and then wins over the completion. Returns a detach for a turn that never started.
 */
function onTurnDrained(
  host: BuddyPolicyHost,
  done: (status: 'complete' | 'failed', detail: string) => void
): () => void {
  let pendingFailure: string | null = null;
  const detach = () => {
    host.off('buddy-turn-complete', complete);
    host.off('buddy-turn-failed', failed);
  };
  const complete = (output: string) => {
    detach();
    if (pendingFailure === null) done('complete', output);
    else done('failed', pendingFailure);
  };
  const failed = (error: string) => {
    if (host.hasProcess()) {
      pendingFailure = error;
      return;
    }
    detach();
    done('failed', error);
  };
  host.once('buddy-turn-complete', complete);
  host.on('buddy-turn-failed', failed);
  return detach;
}

// --- Buddy Builder -------------------------------------------------------------

/** The Buddy Builder thread: team tools on owner input, its own briefing, no Buddy identity. */
export class BuddyBuilderTurnPolicy implements TurnPolicy {
  readonly acceptsUserInput = true;
  // This turn's team-tools grant; null when its input was not the owner's (no tools).
  private grant: GrantRecord | null = null;

  constructor(
    private readonly host: BuddyPolicyHost,
    private readonly dependencies: BuddyTurnPolicyDependencies
  ) {}

  gate(): TurnGate {
    return 'send';
  }
  releaseUnspawned(): void {}
  prepare(): boolean {
    return false;
  }
  memorySnapshot(): MemorySnapshot | null {
    return null;
  }
  providerPrompt(turn: { content: string; messageCount: number; hasStartedSession: boolean }) {
    return builderFirstTurnPrompt(
      turn.content,
      turn.messageCount === 0 && !turn.hasStartedSession,
      this.host.workingDirectory
    );
  }
  admitted(): void {}
  preflight(provider: ProviderName): void {
    assertBuddyProviderSupportsMcp(provider);
  }
  // Owner authority comes from input provenance alone (B1): only an owner input gets the tools.
  startTurn(input: TurnInput, config: ResolvedExecutionConfig) {
    this.grant = null;
    if (input.origin !== 'owner_input') return {};
    assertBuddyProviderSupportsMcp(config.provider);
    const tools = this.dependencies.buddies.builderMcpServers(this.host.id);
    this.grant = tools.grant;
    return { mcpServers: tools.servers };
  }
  spawned(): void {}
  adoptionRecord(): PolicyAdoption {
    return { t: 'builder', grant: this.grant };
  }
  adopt(record: PolicyAdoption): void {
    if (record.t !== 'builder')
      throw new Error(`The Buddy Builder cannot adopt a ${record.t} turn`);
    this.grant = record.grant;
    if (record.grant) this.dependencies.buddies.adoptGrant(record.grant);
  }
  spawnFailed(): void {
    this.revoke();
  }
  toolResultParts(output: unknown): ContentPart[] {
    const common = commonToolResultParts(output);
    if (common.length) return common;
    const event = parseBuddyBuilderToolResult(output);
    return event ? [{ t: 'buddy_builder_result', event }] : [];
  }
  streamCompleted(): void {}
  reviewCompleted(): void {}
  ended(): void {
    this.revoke();
  }
  revoke(): void {
    this.dependencies.buddies.revoke(this.host.id);
  }
  stop(): boolean {
    this.revoke();
    return true;
  }
  dropWaitingTurn(): boolean {
    return false;
  }
  waitingForRunSlot(): boolean {
    return false;
  }
  queueEmptied(): void {}
  attemptFinished(): void {}
  sessionReset(): void {}
  audienceKey(): string | undefined {
    return undefined;
  }
  runCoordination(): Promise<string> {
    return Promise.reject(new Error('Coordination identity or claim is missing'));
  }
  sendAutomation(): void {
    rejectAutomation();
  }
  stopAutomation(): void {
    this.revoke();
  }
}

// Pattern: pure-core (docs/patterns.md#pure-core)
/**
 * The provider-session fence of a Buddy conversation. An owner input or a seat's `buddy_post` is
 * the conversation's own audience; any other turn (worker, message, schedule) is its work's: the
 * task, else the workspace. It no longer addresses memory (one per Buddy), but its strings are the
 * ones sessions were saved under before 2026-09-26, so a deploy resumes every saved session.
 */
export function sessionAudienceKey(
  origin: TurnInput['origin'],
  conversationId: string,
  context: Pick<BuddyContext, 'buddyProjectId' | 'workspaceId'>
): string {
  switch (origin) {
    case 'owner_input':
    case 'buddy_post':
      return JSON.stringify({ kind: 'thread', threadId: conversationId });
    case 'buddy_message':
    case 'schedule':
    case 'unknown':
      return context.buddyProjectId
        ? JSON.stringify({ kind: 'task', taskId: context.buddyProjectId })
        : JSON.stringify({ kind: 'workspace', workspaceId: context.workspaceId });
  }
}

// --- Buddy ---------------------------------------------------------------------

/**
 * The run a Buddy turn executes under, as data: a foreground chat's admitted run or a
 * runner-owned run. Its lease settles it; its deadline expires it as max_runtime_timeout.
 */
export interface RunRecord {
  readonly kind: 'chat' | 'runner';
  readonly runId: string;
  readonly leaseToken: string;
  readonly deadline: string;
  readonly context: BuddyContext;
}

/** What a Buddy or Builder turn holds that an adopting backend restores (turns/policy.ts). */
export type BuddyPolicyAdoption =
  | { t: 'builder'; grant: GrantRecord | null }
  | {
      t: 'buddy';
      grant: GrantRecord;
      run: RunRecord;
      briefedGeneration: string | null;
      audienceKey: string | null;
    };

/**
 * The run in flight, plus who hears its drain: the chat's settle, the runner's awaiting
 * `runCoordination`, or (adopted, when that promise died with the old backend) the runner's
 * `finishAdoptedRun`.
 */
type RunExecution = RunRecord & {
  onAdmitted?: (config: ResolvedExecutionConfig) => void;
  terminalCause?: TurnTerminalCause;
  drained(status: 'complete' | 'failed', detail: string): void;
};

export interface BuddyTurnPolicySeed {
  readonly memorySnapshot: MemorySnapshot | null;
  /** The session audience key the restored provider session was saved under. */
  readonly audienceKey: string | null;
}

export class BuddyTurnPolicy implements TurnPolicy {
  private memory: MemorySnapshot | null;
  // The session audience key the current provider session was built under (persisted with it).
  private providerAudienceKey: string | null;
  // Memory generation the current provider session was last briefed with; null means
  // "unknown" (new, reset, restored, or failed spawn) and forces one re-brief.
  private briefedMemoryGeneration: string | null = null;
  // A chat turn waits here for a run slot; the queue head stays pending meanwhile. On
  // admission its run is held in admittedChatRun until startTurn takes it.
  private chatTicket: { turnId: string; stopWaiting: () => void } | null = null;
  private admittedChatRun: OwnedChatRun | null = null;
  private execution: RunExecution | null = null;
  // This turn's grant, held as data so the turn can be adopted.
  private grant: GrantRecord | null = null;
  private reviewTicket: { attemptId: string; messageStart: number; context: BuddyContext } | null =
    null;

  constructor(
    private readonly kind: BuddyKind,
    private readonly host: BuddyPolicyHost,
    private readonly dependencies: BuddyTurnPolicyDependencies,
    seed: BuddyTurnPolicySeed
  ) {
    this.memory = seed.memorySnapshot;
    this.providerAudienceKey = seed.audienceKey;
  }

  private get buddies(): BuddyPolicyPort {
    return this.dependencies.buddies;
  }

  // A pre-T11 automation transcript stays read-only.
  get acceptsUserInput(): boolean {
    return !this.kind.context.automationRunId;
  }

  // --- admission -------------------------------------------------------------

  gate(_input: TurnInput, fromQueue: boolean): TurnGate {
    // A runner-owned run already holds its slot; only chat turns queue for one.
    if (this.execution) return 'send';
    // Chat turns are admitted through the queue, so a turn waiting for a run slot is visible as
    // pending and later sends line up behind it. The queue keeps the input's provenance: a
    // 'buddy_post' seat turn dropped here would come back 'unknown'.
    if (!fromQueue) return 'enqueue';
    const owned = this.admitChatRun();
    if (!owned) return 'wait';
    this.admittedChatRun = owned;
    return 'admitted';
  }

  // Admitted: the owned run. Otherwise the queue head goes back to pending and the shared tick
  // re-runs processQueue. The run's lease is its deadline: the runner leases every claim for
  // TURN_MAX_RUNTIME_MS (runner.ts; 600 s killed live owner chats on 2026-09-10).
  private admitChatRun(): OwnedChatRun | null {
    this.chatTicket ??= {
      turnId: this.buddies.enqueueChat(this.turnContext(), this.host.id),
      stopWaiting: waitForChatRunSlot(() => this.host.processQueue()),
    };
    const admission = this.buddies.admission(this.chatTicket.turnId);
    switch (admission.kind) {
      case 'admitted':
        this.releaseChatTicket(false);
        return admission.run;
      case 'waiting':
        this.host.releaseQueueHead(true);
        return null;
      case 'gone':
        // Lost its place; rejoin at the back of the line on the next poll.
        this.chatTicket.stopWaiting();
        this.chatTicket = null;
        setTimeout(() => this.host.processQueue(), CHAT_ADMISSION_POLL_MS);
        this.host.releaseQueueHead(false);
        return null;
    }
  }

  private releaseChatTicket(abandon: boolean): void {
    const ticket = this.chatTicket;
    if (!ticket) return;
    ticket.stopWaiting();
    this.chatTicket = null;
    if (abandon) this.buddies.abandon(ticket.turnId);
  }

  // An admitted turn can return before spawning (preflight refusal, rejected fork). Its run
  // must be settled here, or it holds one of its Buddy's slots until the lease expires.
  releaseUnspawned(): void {
    const owned = this.admittedChatRun;
    if (!owned) return;
    this.admittedChatRun = null;
    this.buddies.settle(owned.id, owned.claim_token, 'cancelled', 'Turn did not start');
  }

  waitingForRunSlot(): boolean {
    return this.chatTicket !== null && !this.host.hasProcess();
  }

  dropWaitingTurn(): boolean {
    if (!this.chatTicket || this.host.hasProcess()) return false;
    // Stopping a turn that is still waiting for a run slot drops that turn.
    this.host.dropPendingHead();
    this.releaseChatTicket(true);
    return true;
  }

  queueEmptied(): void {
    this.releaseChatTicket(true);
  }

  // --- context and briefing ----------------------------------------------------

  /** The context a turn runs under: a runner-owned run's own, else the conversation's. */
  private turnContext(): BuddyContext {
    return this.execution?.context ?? this.kind.context;
  }

  // A provider session holds what its audience saw. It resumes only under the same audience key;
  // a different or unknown one (a session saved before its key was recorded) starts fresh, while
  // the display history stays. Guard: conversation-runtime.test.ts "session audience key: …".
  private admitAudience(input: TurnInput, context: BuddyContext): void {
    const key = sessionAudienceKey(input.origin, this.host.id, context);
    if (this.providerAudienceKey !== key && this.host.hasStartedSession()) {
      console.log(
        `[${this.host.id}] Buddy context reset: the session audience changed or is unknown`
      );
      this.host.resetProcess();
    }
    this.providerAudienceKey = key;
  }

  prepare(input: TurnInput): boolean {
    const context = this.turnContext();
    this.admitAudience(input, context);
    const current = this.buddies.currentBriefing(context);
    this.memory = createMemorySnapshot(current.briefing, current.memoryGeneration);
    // Re-brief only when this provider session has not yet seen the current memory generation.
    // From 5c0cec4 (2026-09-20) until 2026-09-24 every turn re-sent a ~20k-char briefing (one
    // session carried 44 copies, ~835k chars). Guard: `resumed Buddy turns re-brief only when
    // the memory generation changes`.
    return (this.memory?.generation ?? null) !== this.briefedMemoryGeneration;
  }

  memorySnapshot(): MemorySnapshot | null {
    return this.memory;
  }

  providerPrompt(turn: {
    content: string;
    messageCount: number;
    hasStartedSession: boolean;
    refreshBriefing: boolean;
  }): string {
    const first = turn.messageCount === 0 && !turn.hasStartedSession;
    if ((!first && !turn.refreshBriefing) || !this.memory) return turn.content;
    return buddyBriefedPrompt(this.kind.context, this.memory, turn.content);
  }

  admitted(): void {
    // Every path leaves the provider session holding this generation.
    this.briefedMemoryGeneration = this.memory?.generation ?? null;
  }

  preflight(provider: ProviderName): void {
    assertBuddyProviderSupportsMcp(provider);
  }

  audienceKey(): string | undefined {
    return this.providerAudienceKey ?? undefined;
  }

  sessionReset(): void {
    this.providerAudienceKey = null;
    this.briefedMemoryGeneration = null;
  }

  // --- the turn ----------------------------------------------------------------

  // One MCP server with one fresh grant. `owner` only for an owner-authored input (B1): a seat
  // answering another Buddy's post never holds owner authority.
  startTurn(input: TurnInput, config: ResolvedExecutionConfig) {
    const owned = this.admittedChatRun;
    this.admittedChatRun = null;
    if (owned) this.ownChatRun(owned);
    assertBuddyProviderSupportsMcp(config.provider);
    const context = this.turnContext();
    const tools = this.buddies.mcpServers({
      context,
      conversationId: this.host.id,
      owner: input.origin === 'owner_input',
      visibility: this.host.visibility(),
    });
    this.grant = tools.grant;
    // Capture exactly the resolved request at the provider boundary, after all awaits.
    this.execution?.onAdmitted?.(config);
    return { mcpServers: tools.servers, extraArgs: HARNESS_MEMORY_OFF[config.provider] };
  }

  /**
   * The admitted chat run owns this turn until it drains: its deadline (the run's lease) expires
   * as max_runtime_timeout, never user_stop, and the run settles once on the terminal event.
   */
  private ownChatRun(owned: OwnedChatRun): void {
    this.armExecution({
      kind: 'chat',
      runId: owned.id,
      leaseToken: owned.claim_token,
      deadline: owned.deadline,
      context: { ...this.turnContext(), coordinationRunId: owned.id },
      drained: (status, detail) => this.buddies.settle(owned.id, owned.claim_token, status, detail),
    });
  }

  /**
   * One path for every run a turn executes under: hold it, expire it at its deadline, and hand
   * its drain to whoever settles it. Until 2026-09-30 a runner-owned run's deadline was a timer
   * in server.ts `runTurn`, so it could not survive the backend that armed it.
   */
  private armExecution(execution: RunExecution): () => void {
    this.execution = execution;
    const timer = setTimeout(
      () => this.host.maxRuntimeReached(),
      Math.max(0, Date.parse(execution.deadline) - Date.now())
    );
    // A 24 h deadline must not by itself keep a process alive (the runtime tests' turns that
    // never answer left it pending, and the test process never exited).
    timer.unref?.();
    const detach = onTurnDrained(this.host, (status, detail) => {
      clearTimeout(timer);
      this.execution = null;
      execution.drained(status, detail);
    });
    // For a run that never reached a turn: drop its deadline and drain listeners with it.
    return () => {
      clearTimeout(timer);
      detach();
      this.execution = null;
    };
  }

  spawned(review: { attemptId: string; messageStart: number }): void {
    this.reviewTicket = { ...review, context: this.turnContext() };
  }

  adoptionRecord(): PolicyAdoption {
    const { execution, grant } = this;
    if (!execution || !grant)
      throw new Error('A Buddy turn without its run and grant cannot be adopted');
    const { kind, runId, leaseToken, deadline, context } = execution;
    return {
      t: 'buddy',
      grant,
      run: { kind, runId, leaseToken, deadline, context },
      briefedGeneration: this.briefedMemoryGeneration,
      audienceKey: this.providerAudienceKey,
    };
  }

  /**
   * This backend replaced the one that spawned the turn. The same grant works again, the run keeps
   * its lease and deadline, and its drain settles it here: a chat run through the port as before,
   * a runner-owned run through the runner (its awaiting promise died with the old backend).
   */
  adopt(record: PolicyAdoption, review: AdoptedReview): void {
    if (record.t !== 'buddy') throw new Error(`A Buddy thread cannot adopt a ${record.t} turn`);
    const { run } = record;
    this.buddies.adoptGrant(record.grant);
    this.grant = record.grant;
    this.briefedMemoryGeneration = record.briefedGeneration;
    this.providerAudienceKey = record.audienceKey;
    this.armExecution({
      ...run,
      drained: (status, detail) =>
        run.kind === 'chat'
          ? this.buddies.settle(run.runId, run.leaseToken, status, detail)
          : this.buddies.finishAdoptedRun(run.runId, run.leaseToken, status, detail),
    });
    this.spawned(review);
  }

  spawnFailed(): void {
    this.revoke();
    // The briefing in this prompt never reached the provider transcript.
    this.briefedMemoryGeneration = null;
  }

  toolResultParts(output: unknown): ContentPart[] {
    return commonToolResultParts(output);
  }

  streamCompleted(): void {}

  // Called before completion listeners or processQueue can start another turn.
  reviewCompleted(messages: readonly Message[]): void {
    const ticket = this.reviewTicket;
    if (!ticket) return;
    try {
      this.buddies.afterTurn({
        attemptId: ticket.attemptId,
        conversationId: this.host.id,
        context: { ...ticket.context },
        completedAt: new Date().toISOString(),
        messages: messages.slice(ticket.messageStart),
      });
    } catch (error) {
      console.error('[buddies] Could not enqueue memory review', this.host.id, error);
    }
  }

  ended(_end: TurnEnd): void {
    this.revoke();
  }

  revoke(): void {
    this.buddies.revoke(this.host.id);
  }

  attemptFinished(cause: TurnTerminalCause): void {
    if (this.execution && !this.execution.terminalCause) this.execution.terminalCause = cause;
  }

  stop(): boolean {
    this.revoke();
    return true;
  }

  // --- runner-owned runs --------------------------------------------------------

  /** One background turn for a run the runner claimed (runner.ts `RunnerHost.runTurn`). */
  runCoordination(
    content: string,
    context: BuddyContext,
    leaseToken: string,
    deadline: string,
    onDrained?: CoordinationDrained,
    onAdmitted?: (config: ResolvedExecutionConfig) => void
  ): Promise<string> {
    if (this.execution) return Promise.reject(new Error('Conversation is busy'));
    if (
      !context.coordinationRunId ||
      !leaseToken ||
      context.buddyId !== this.kind.context.buddyId ||
      context.workspaceId !== this.kind.context.workspaceId
    ) {
      return Promise.reject(new Error('Run identity or lease is missing'));
    }
    const runId = context.coordinationRunId;
    return new Promise<string>((resolve, reject) => {
      const execution: RunExecution = {
        kind: 'runner',
        runId,
        leaseToken,
        deadline,
        context,
        onAdmitted,
        drained: (status, detail) => {
          try {
            onDrained?.(status, detail, execution.terminalCause);
          } catch (error) {
            return reject(error);
          }
          if (status === 'complete') resolve(detail);
          else reject(new Error(detail));
        },
      };
      const release = this.armExecution(execution);
      try {
        this.host.send(sameEitherWay(content), { origin: 'buddy_message', inputId: runId });
      } catch (error) {
        release();
        reject(error);
      }
    });
  }

  sendAutomation(): void {
    rejectAutomation();
  }

  stopAutomation(): void {
    this.revoke();
  }
}
