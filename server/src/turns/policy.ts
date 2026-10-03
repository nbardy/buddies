import type { McpServerSpec } from '@nbardy/agent-cli';
import type {
  BuddyContext,
  ContentPart,
  Message,
  Provider as ProviderName,
  ResolvedExecutionConfig,
} from '@unleashd/shared';
import { parseBuddyWorkerToolResult } from '@unleashd/shared';
import type { BuddyPolicyAdoption } from '../buddies/turn-policy';
import type { ExecutionOutcome } from './execution-state';
import type { TurnInput } from './input';

/**
 * What a conversation's KIND adds to its turns. Chosen ONCE per conversation
 * kind (conversations/runtime.ts `policyFor`): a general chat gets
 * `ChatTurnPolicy`, whose hooks do nothing; Buddy and Builder threads get the
 * policies in buddies/turn-policy.ts (admission, briefing, grants/MCP servers,
 * memory). The turn core calls these hooks and never asks "which kind?".
 */

/** An immutable briefing snapshot a Buddy provider session was built from. */
export interface MemorySnapshot {
  readonly generation: string;
  readonly briefing: string;
}

/**
 * Where an input may go right now: `send` spawns, `enqueue` lines it up behind
 * the queue, `wait` leaves the queue head pending until a run slot frees, and
 * `admitted` spawns holding a run the policy must get back if the spawn never
 * happens (`releaseUnspawned`).
 */
export type TurnGate = 'send' | 'enqueue' | 'wait' | 'admitted';

/**
 * What a spawned turn's policy holds that a replacement backend needs to adopt the turn while it
 * still runs (turns/executions.ts): data only, written to the execution's journal at spawn. Each
 * policy reads back only its own variant; any other is a typed refusal, never a default.
 */
// Pattern: sum-types (docs/patterns.md#sum-types)
export type PolicyAdoption = { t: 'chat' } | BuddyPolicyAdoption;

/** The adopted turn's own review window: its attempt, and where its messages start. */
export interface AdoptedReview {
  attemptId: string;
  messageStart: number;
}

// Pattern: sum-types (docs/patterns.md#sum-types)
export interface TurnPolicy {
  /** False for a transcript no user input may extend (a Buddy automation run). */
  readonly acceptsUserInput: boolean;
  gate(input: TurnInput, fromQueue: boolean): TurnGate;
  releaseUnspawned(): void;
  /** Read the current context for this input; true when the session must be re-briefed. */
  prepare(input: TurnInput): boolean;
  memorySnapshot(): MemorySnapshot | null;
  /** The provider-facing prompt (history keeps `content` clean). */
  providerPrompt(turn: {
    content: string;
    messageCount: number;
    hasStartedSession: boolean;
    refreshBriefing: boolean;
  }): string;
  /** The input was admitted into history as `content`. */
  admitted(input: TurnInput, content: string): void;
  /** Configuration admission: throws when the provider cannot run this kind. */
  preflight(provider: ProviderName): void;
  /** Right before spawn: extra request fields for this turn. */
  startTurn(
    input: TurnInput,
    config: ResolvedExecutionConfig
  ): { mcpServers?: Record<string, McpServerSpec>; extraArgs?: readonly string[] };
  spawned(review: { attemptId: string; messageStart: number }): void;
  /** Right after startTurn, before spawn: this turn's state as data, for adoption. */
  adoptionRecord(): PolicyAdoption;
  /**
   * A replacement backend adopted this turn: restore what the record holds. Its grant, if it may
   * hold one, was restored at boot (execution-state.ts `holdsGrant`), never here.
   */
  adopt(record: PolicyAdoption, review: AdoptedReview): void;
  /** An adopted live turn: expire it at its run's deadline again (effect `arm_deadline`). */
  armDeadline(): void;
  spawnFailed(): void;
  toolResultParts(output: unknown): ContentPart[];
  streamCompleted(): void;
  /** A successful, un-stopped turn drained; `messages` is the whole history. */
  reviewCompleted(messages: readonly Message[]): void;
  /**
   * The turn's settle effect (execution-state.ts): settle the run it executes under with this
   * outcome. Resolves once that landed; only then is the turn's journal removed.
   */
  settle(outcome: ExecutionOutcome): Promise<void>;
  /** Revoke per-turn capabilities (tool grants) now. */
  revoke(): void;
  /** An owner stop. Returns false when the policy handled it without stopping the turn. */
  stop(): boolean;
  /** Stop while waiting for a run slot. Returns true when a waiting turn was dropped. */
  dropWaitingTurn(): boolean;
  waitingForRunSlot(): boolean;
  queueEmptied(): void;
  /**
   * The turn's bridge is alive: called on every event that ticks the watchdog's bridge clock,
   * heartbeats included. A Buddy turn renews its run's lease here (Pattern: lease-heartbeat).
   */
  bridgeAlive(): void;
  sessionReset(): void;
  audienceKey(): string | undefined;
  /**
   * One turn for a run the Buddy runner claimed. `deadline` (ISO) expires it as
   * max_runtime_timeout. Resolves once the turn settled its run; rejects only when it never started.
   */
  runCoordination(
    content: string,
    context: BuddyContext,
    claimToken: string,
    deadline: string
  ): Promise<void>;
  sendAutomation(content: string): void;
  stopAutomation(): void;
}

/** The first-turn prefix a general chat carries: the swarm debug header, once. */
export function chatFirstTurnPrompt(input: {
  content: string;
  firstUnstartedTurn: boolean;
  swarmDebugPrefix: string | null;
}): string {
  if (input.swarmDebugPrefix !== null && input.firstUnstartedTurn) {
    return `<!-- unleashd:swarm-prefix -->\n${input.swarmDebugPrefix}\n<!-- /unleashd:swarm-prefix -->\n\n${input.content}`;
  }
  return input.content;
}

/** Successful tool receipts every kind renders into the transcript. */
export function commonToolResultParts(output: unknown): ContentPart[] {
  return parseBuddyWorkerToolResult(output).map((thread) => ({ t: 'buddy_worker_thread', thread }));
}

/** A general chat: no admission, briefing, grants or memory. */
export class ChatTurnPolicy implements TurnPolicy {
  readonly acceptsUserInput = true;

  constructor(private readonly swarmDebugPrefix: () => string | null) {}

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
    return chatFirstTurnPrompt({
      content: turn.content,
      firstUnstartedTurn: turn.messageCount === 0 && !turn.hasStartedSession,
      swarmDebugPrefix: this.swarmDebugPrefix(),
    });
  }
  admitted(): void {}
  preflight(): void {}
  startTurn() {
    return {};
  }
  spawned(): void {}
  adoptionRecord(): PolicyAdoption {
    return { t: 'chat' };
  }
  adopt(record: PolicyAdoption): void {
    if (record.t !== 'chat') throw new Error(`A chat cannot adopt a ${record.t} turn`);
  }
  armDeadline(): void {}
  spawnFailed(): void {}
  toolResultParts(output: unknown): ContentPart[] {
    return commonToolResultParts(output);
  }
  streamCompleted(): void {}
  reviewCompleted(): void {}
  settle(): Promise<void> {
    return Promise.resolve();
  }
  revoke(): void {}
  stop(): boolean {
    return true;
  }
  dropWaitingTurn(): boolean {
    return false;
  }
  waitingForRunSlot(): boolean {
    return false;
  }
  queueEmptied(): void {}
  bridgeAlive(): void {}
  sessionReset(): void {}
  audienceKey(): string | undefined {
    return undefined;
  }
  runCoordination(): Promise<void> {
    return Promise.reject(new Error('Coordination identity or claim is missing'));
  }
  sendAutomation(): void {
    throw new Error('Automation turn requires current server-private execution authority');
  }
  stopAutomation(): void {
    throw new Error('Automation stop requires current server-private execution authority');
  }
}
