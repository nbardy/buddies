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
import { BUDDY_RUN_LEASE_RENEW_MS } from '../constants/timeouts';
import type { ConversationRuntimeView } from '../conversations/runtime';
import type { ExecutionOutcome } from '../turns/execution-state';
import { type SessionRelativePrompt, type TurnInput, sameEitherWay } from '../turns/input';
import {
  type AdoptedReview,
  type MemorySnapshot,
  type PolicyAdoption,
  type TurnGate,
  type TurnPolicy,
  commonToolResultParts,
} from '../turns/policy';
import { BUDDY_BUILDER_BRIEFING } from './builder';
import type { GrantRecord } from './grants';
import { HARNESS_MEMORY_OFF } from './harness-memory';
import type { BuddyPolicyPort } from './policy-port';
import type { OwnedChatRun } from './runner';
import { type InputCarrier, encodeEntry } from '../turns/intake';

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

export function builderFirstTurnPrompt(
  content: string,
  firstUnstartedTurn: boolean,
  workingDirectory: string
): string {
  if (!firstUnstartedTurn) return content;
  // Fix-guard: everything hidden goes INSIDE the counted body. 3c1d8d6 put the working directory
  // after the closing marker; ingest (markers.rs BUILDER_V1_SUFFIX) then failed to strip it, the
  // user row became a placeholder and the overlay merge doubled the replies (task_01a10d29).
  // Guards: markers.rs builder_envelope_strips_in_every_shape_the_server_has_written,
  // ingest-history.test.ts "a Builder first turn shows once".
  const body = `${BUDDY_BUILDER_BRIEFING}\n\nWorking directory: ${workingDirectory}`;
  return `<!-- unleashd:buddy-builder-v1 ${body.length} -->\n${body}\n<!-- /unleashd:buddy-builder-v1 -->\n\n${content}`;
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

// --- Buddy Builder -------------------------------------------------------------

/** The Buddy Builder thread: team tools on owner input, its own briefing, no Buddy identity. */
export class BuddyBuilderTurnPolicy implements TurnPolicy {
  readonly acceptsUserInput = true;
  // This turn's team-tools grant; null when its input was not the owner's (no tools).
  private grant: GrantRecord | null = null;

  constructor(
    private readonly host: BuddyPolicyHost,
    private readonly dependencies: BuddyTurnPolicyDependencies,
    // The Builder has no Buddy, so no run: its pending messages are records rows like a chat's.
    readonly carrier: InputCarrier
  ) {}

  gate(): TurnGate {
    return 'send';
  }
  admitClaim(): void {
    throw new Error('The Buddy Builder has no chat runs');
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
  }
  armDeadline(): void {}
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
  settle(): Promise<void> {
    return Promise.resolve();
  }
  revoke(): void {
    this.dependencies.buddies.revoke(this.host.id);
  }
  stop(): boolean {
    this.revoke();
    return true;
  }
  ownerStopped(): void {}
  dropWaitingTurn(): boolean {
    return false;
  }
  bridgeAlive(): void {}
  sessionReset(): void {}
  audienceKey(): string | undefined {
    return undefined;
  }
  runCoordination(): Promise<void> {
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

// Pattern: sum-types (docs/patterns.md#sum-types)
/**
 * The origin of a runner-owned turn delivered into an existing conversation (a `deliver` run, or
 * a request resumed where it ran), by placement. It
 * names which provider-session audience the turn resumes (`sessionAudienceKey`) and whether it
 * can hold owner authority (`startTurn`: only `owner_input`).
 *   foreground: `buddy_post`. The owner chat's own session (audience = this thread) resumes, so
 *     the lead keeps its context instead of forking a fresh session (delivery design D9, 1(d)).
 *     A worker's answer must NEVER run with the owner's grant in the owner's chat: `buddy_post`
 *     is the B1 origin, "Buddy-authored text, conversation audience, no owner authority".
 *   background: `buddy_message`, as before: a worker conversation's audience is its work.
 */
const RETURN_ORIGIN: { readonly [V in BuddyVisibility]: TurnInput['origin'] } = {
  foreground: 'buddy_post',
  background: 'buddy_message',
};

/**
 * The run a Buddy turn executes under, as data: a foreground chat's admitted run or a
 * runner-owned run. Its lease token settles it and is renewed on the bridge clock; its deadline
 * (a separate value: 24 h for a chat) expires it as max_runtime_timeout.
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

/** The run in flight; its turn's settle effect settles it, live or adopted alike. */
type RunExecution = RunRecord & {
  readonly deadlineTimer: { current: ReturnType<typeof setTimeout> | undefined };
  /** Told once the settle landed: a live runner-owned turn's `runCoordination` resolves here. */
  readonly landed: () => void;
};

const nothingWaits = () => undefined;

/**
 * Who settles each kind of run, resolving once it landed: a chat run directly, a runner-owned run
 * through the runner's completion step (`finishRun`). One path for a live and an adopted turn:
 * until 2026-10-03 a live runner-owned turn resolved `runCoordination`'s promise and the runner
 * settled it later, out of sight of the turn, so nothing could keep the journal until it landed (2b).
 */
const SETTLE_RUN: {
  readonly [K in RunRecord['kind']]: (
    buddies: BuddyPolicyPort,
    run: RunRecord,
    outcome: ExecutionOutcome
  ) => Promise<void>;
} = {
  chat: (buddies, run, outcome) => buddies.settle(run.runId, run.leaseToken, outcome),
  runner: (buddies, run, outcome) => buddies.finishRun(run.runId, run.leaseToken, outcome),
};

/** This holder's view of its run's lease: renewed at `renewedAt`, a renewal in flight, or gone. */
type LeaseHold = { t: 'held'; renewedAt: number } | { t: 'renewing' } | { t: 'lost' };

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
  // The chat run the runner claimed for a queued message: held here, by that message's id, until
  // the runtime starts it (`gate` hands it on as `admittedChatRun`, `startTurn` takes it).
  private claimed: { entryId: string; run: OwnedChatRun } | null = null;
  private admittedChatRun: OwnedChatRun | null = null;
  private execution: RunExecution | null = null;
  // The execution's lease, as this holder last knew it (see bridgeAlive).
  private lease: LeaseHold | null = null;
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

  // Pattern: durable-intake (docs/patterns.md#durable-intake). Every queued owner message of a
  // Buddy conversation is a crate `chat` run carrying its text, written when it was sent. The
  // TurnQueue entry is its projection: the run is claimed when the Buddy has a slot and the
  // conversation is free (`conversation_busy`, `owner_first`), and the runner hands the claim to
  // `admitClaim`. Nothing waits here on a timer: the claim is the wake. The stamp is the claim:
  // the runner marks the run executing right before it admits, so `stamp` is just "do I hold it".
  readonly carrier: InputCarrier = {
    put: (conversationId, entry) =>
      this.buddies.queueChat(
        this.turnContext(),
        conversationId,
        entry.message.id,
        encodeEntry(entry)
      ),
    promote: (entry) => this.buddies.promoteChat(entry.message.id),
    cancel: (entry) => this.buddies.cancelChat(entry.message.id),
    // The run settles through this policy's `settle`, so the entry's end needs nothing here.
    settle: () => undefined,
    stamp: (entry) => this.claimed?.entryId === entry.message.id,
  };

  admitClaim(entryId: string, run: OwnedChatRun): void {
    this.claimed = { entryId, run };
    this.host.processQueue();
  }

  gate(input: TurnInput, fromQueue: boolean): TurnGate {
    // A run is still armed: either this very turn's own send (a runner-owned run holds its slot
    // already; only chat turns queue for one), or the PREVIOUS turn's run whose settle has not
    // landed yet (turns/runner.ts `settleOutcome` starts the queue head BEFORE the settle).
    // Starting an owner message under that old run left it without a run of its own: no lease,
    // no deadline, and invisible to the claim gate, which then saw the conversation free and
    // claimed a queued RETURN beside it (delivery design D3, owner decision A, 2026-10-06). So an
    // owner message waits for the settle, then gets its own chat run, which `owner_first` sees.
    if (this.execution) {
      if (input.inputId === this.execution.runId) return 'send';
      if (!fromQueue) return 'enqueue';
      this.host.releaseQueueHead(false);
      return 'wait';
    }
    // Chat turns go through the queue, so a message waiting for its run is visible as pending and
    // later sends line up behind it. The queue keeps the input's provenance: a 'buddy_post' seat
    // turn dropped here would come back 'unknown'. The runtime asks `carrier.stamp` first, so a
    // queue head arrives here only once its run is claimed.
    if (!fromQueue) return 'enqueue';
    const held = this.claimed;
    if (!held) return 'wait';
    this.claimed = null;
    this.admittedChatRun = held.run;
    return 'admitted';
  }

  // An admitted turn can return before spawning (preflight refusal, rejected fork). Its run
  // must be settled here, or it holds one of its Buddy's slots until the lease expires.
  releaseUnspawned(): void {
    const owned = this.admittedChatRun;
    if (!owned) return;
    this.admittedChatRun = null;
    this.buddies
      .settle(owned.id, owned.claim_token, { t: 'cancelled', detail: 'Turn did not start' })
      .catch((error) => console.error('[buddies] unspawned run not settled', owned.id, error));
  }

  // Stop while the head waits for its run: the message is dropped, and its run cancelled.
  dropWaitingTurn(): boolean {
    if (this.host.hasProcess() || this.claimed) return false;
    this.host.dropPendingHead();
    return true;
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
    });
    this.grant = tools.grant;
    return { mcpServers: tools.servers, extraArgs: HARNESS_MEMORY_OFF[config.provider] };
  }

  /**
   * The admitted chat run owns this turn until it settles: its deadline (the run's own, never its
   * lease) expires as max_runtime_timeout, never user_stop.
   */
  private ownChatRun(owned: OwnedChatRun): void {
    this.arm({
      kind: 'chat',
      runId: owned.id,
      leaseToken: owned.claim_token,
      deadline: owned.deadline,
      context: { ...this.turnContext(), coordinationRunId: owned.id },
    });
    this.armDeadline();
  }

  /** Hold the run a turn executes under. Its lease was just claimed, or renewed at adoption. */
  private arm(run: RunRecord, landed: () => void = nothingWaits): void {
    this.execution = { ...run, deadlineTimer: { current: undefined }, landed };
    this.lease = { t: 'held', renewedAt: Date.now() };
  }

  private disarm(): RunExecution | null {
    const execution = this.execution;
    if (execution) clearTimeout(execution.deadlineTimer.current);
    this.execution = null;
    this.lease = null;
    return execution;
  }

  /**
   * Expire the run at its deadline. Until 2026-09-30 a runner-owned run's deadline was a timer in
   * server.ts `runTurn`, so it could not survive the backend that armed it. An adopted turn arms it
   * only when it still runs (execution-state.ts ADOPTIONS): re-arming a deadline that passed while
   * no backend watched sealed a finished replay as max_runtime_timeout (review of P1, 2026-10-01;
   * guard: execution-adoption.test.ts "finished during the gap").
   */
  armDeadline(): void {
    const execution = this.execution;
    if (!execution) throw new Error('No run to expire: arm it first');
    const timer = setTimeout(
      () => this.host.maxRuntimeReached(),
      Math.max(0, Date.parse(execution.deadline) - Date.now())
    );
    // A 24 h deadline must not by itself keep a process alive (the runtime tests' turns that
    // never answer left it pending, and the test process never exited).
    timer.unref?.();
    execution.deadlineTimer.current = timer;
  }

  settle(outcome: ExecutionOutcome): Promise<void> {
    const execution = this.disarm();
    if (!execution) return Promise.resolve();
    return SETTLE_RUN[execution.kind](this.buddies, execution, outcome)
      .then(execution.landed)
      .then(() => this.host.processQueue()); // the owner message `gate` held for this settle
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
   * This backend replaced the one that spawned the turn. The run keeps its lease and deadline, and
   * the turn's settle settles it here exactly as it would have live (SETTLE_RUN). The grant is not
   * touched here: boot restored it only if the turn may hold one (execution-state.ts `holdsGrant`).
   */
  adopt(record: PolicyAdoption, review: AdoptedReview): void {
    if (record.t !== 'buddy') throw new Error(`A Buddy thread cannot adopt a ${record.t} turn`);
    this.grant = record.grant;
    this.briefedMemoryGeneration = record.briefedGeneration;
    this.providerAudienceKey = record.audienceKey;
    this.arm(record.run);
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

  revoke(): void {
    this.buddies.revoke(this.host.id);
  }

  // Pattern: lease-heartbeat (docs/patterns.md#lease-heartbeat)
  // THE RENEWAL SITE. TurnRunner calls this on every event that ticks the watchdog's bridge clock.
  // At most once per BUDDY_RUN_LEASE_RENEW_MS it pushes the run's lease BUDDY_RUN_LEASE_MS ahead.
  //
  // Why the bridge clock, not provider progress: a model may think silently for up to the 60-min
  // provider-idle budget. A lease renewed only on progress would have to be an hour long, so a
  // dead holder's run would lie for an hour. agent-cli heartbeats tick the bridge clock every
  // <= 30 s while the wrapper and this backend are alive, so a minutes-long lease survives any
  // silent turn. Stuck providers are still the idle timer's job: heartbeats renew the lease but
  // never count as progress.
  //
  // Why renewal at all, instead of a lease the length of the deadline: until 2026-10-01 the lease
  // WAS the 24 h deadline, and a dead holder's runs stayed `running` until the next boot:
  // - a 9.5 h overnight lie on 2026-09-30→10-01;
  // - 14 and 10 orphaned runs at 12:34Z and 14:09Z on 09-30.
  // The opposite mistake, a short lease used as a chat's deadline, killed healthy owner chats at
  // 600 s on 2026-09-10. Lease and deadline are separate values and must stay separate.
  //
  // An adopted turn (P1) renews here too: its new backend is now the holder.
  // `lost` means the claim gate already ended the run, which takes a renewal gap longer than the
  // whole lease (a multi-minute event-loop stall, or another backend's gate during a restart gap).
  // The turn is not killed: its requester was already told the run failed, a late answer or settle
  // is rejected, and this conversation stays busy in memory, so no second writer starts here.
  // Killing it would report a bookkeeping loss as a timeout or a user stop (the 09-10 misreport).
  // Guards: server/test/run-lease.test.ts "a heartbeating silent turn outlives its lease; a turn
  // with no provider progress still dies of the idle timer" and "a holder that dies while the
  // backend stays up is cleared within the lease time".
  bridgeAlive(): void {
    const { execution, lease } = this;
    if (!execution || lease?.t !== 'held') return;
    if (Date.now() - lease.renewedAt < BUDDY_RUN_LEASE_RENEW_MS) return;
    this.lease = { t: 'renewing' };
    void this.buddies.renewLease(execution.runId, execution.leaseToken).then((renewal) => {
      if (this.execution !== execution) return; // drained meanwhile; the settle owns it now
      switch (renewal.kind) {
        case 'renewed':
          this.lease = { t: 'held', renewedAt: Date.now() };
          return;
        case 'failed':
          // Retry one renewal interval later: the lease still has four intervals to run.
          console.warn(
            `[${this.host.id}] lease renewal failed for ${execution.runId}:`,
            renewal.error
          );
          this.lease = { t: 'held', renewedAt: Date.now() };
          return;
        case 'lost':
          console.error(
            `[${this.host.id}] run ${execution.runId} lost its lease: the claim gate ended it; the turn continues unowned`
          );
          this.lease = { t: 'lost' };
          return;
      }
    });
  }

  stop(): boolean {
    this.revoke();
    return true;
  }

  // Pattern: route-at-send (docs/patterns.md#route-at-send)
  // Decision C (delivery design D1): Stop means "quiet down now". Cancelling only the running turn
  // would let the next queued delivery start a moment later, in the chat the owner just silenced.
  // The posts stay unread, so they come back with the Buddy's next delivery or read. Only the
  // owner's Stop button gets here: `stop()` also runs for an interrupt-and-send, where the queued
  // deliveries must survive.
  ownerStopped(): void {
    this.buddies.cancelQueuedDeliveries(this.host.id).catch((error) => {
      console.error(`[${this.host.id}] could not cancel queued deliveries`, error);
    });
  }

  // --- runner-owned runs --------------------------------------------------------

  /**
   * One background turn for a run the runner claimed (runner.ts `RunnerHost.runTurn`). Resolves
   * when the turn's settle settled the run; rejects only when the turn never started. The send is
   * synchronous up to the spawn, so "no process after send" means it never will start: a
   * preflight refusal or a rejected fork, whose message the runtime emits synchronously.
   */
  runCoordination(
    content: string,
    context: BuddyContext,
    leaseToken: string,
    deadline: string,
    owner: boolean
  ): Promise<void> {
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
    let landed: () => void = nothingWaits;
    const settled = new Promise<void>((resolve) => {
      landed = resolve;
    });
    this.arm({ kind: 'runner', runId, leaseToken, deadline, context }, landed);
    this.armDeadline();
    let refusal = 'The turn did not start';
    const heard = (message: string) => {
      refusal = message;
    };
    this.host.once('buddy-turn-failed', heard);
    try {
      this.host.send(sameEitherWay(content), {
        // D9: owner authority only when every post the turn shows is the owner's (the runner
        // decides, from the posts as stored); anything else gets the placement's Buddy origin.
        // Guard: buddies-v2 "B1: a seat turn holds owner authority only when …".
        origin: owner ? 'owner_input' : RETURN_ORIGIN[this.host.visibility()],
        inputId: runId,
      });
    } catch (error) {
      this.disarm();
      return Promise.reject(error);
    } finally {
      this.host.off('buddy-turn-failed', heard);
    }
    if (!this.host.hasProcess()) {
      this.disarm();
      return Promise.reject(new Error(refusal));
    }
    return settled;
  }

  sendAutomation(): void {
    rejectAutomation();
  }

  stopAutomation(): void {
    this.revoke();
  }
}
