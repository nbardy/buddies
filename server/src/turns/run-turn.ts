import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { TurnCapabilities, UnifiedAgentEvent } from '@nbardy/agent-cli';
import { ProviderSchema, type ResolvedExecutionConfig } from '@unleashd/shared';
import type { ConversationRegistry } from '../application/context';
import type { ConversationRecordStore } from '../conversations/config-records';
import type { ConversationConstructor, ConversationRuntime } from '../conversations/runtime';
import type { Tokens } from '../providers/pricing';
import type { ExecutionOutcome } from './execution-state';
import { volatileCarrier } from './intake';
import { ChatTurnPolicy, type PolicyAdoption, type TurnPolicy } from './policy';

type TurnUsage = Extract<UnifiedAgentEvent, { type: 'usage' }>['usage'];
export type RunTurnRequest = {
  key: string;
  provider: string;
  model: string;
  effort: string;
  cwd: string;
  prompt: string;
  capabilities?: TurnCapabilities;
  maxRuntimeMs: number;
  title: string;
};
export type Usage =
  | { t: 'reported'; tokens: Tokens }
  | { t: 'unreported'; why: string; requests: readonly TurnUsage[] };
export type RunTurnOutcome = (
  | { t: 'complete'; text: string }
  | { t: 'failed'; cause: string; detail: string }
  | { t: 'cancelled' }
) & { usage: Usage; conversationId: string };
export type RunTurnAdoption = Pick<RunTurnRequest, 'key' | 'capabilities' | 'maxRuntimeMs'> & {
  t: 'run-turn';
};
type Call = { request: RunTurnRequest; conversationId: string } & (
  | { t: 'started' }
  | { t: 'settled'; outcome: RunTurnOutcome }
);
export class TurnKeyConflictError extends Error {}
// Pattern: parse-dont-validate (docs/patterns.md#parse-dont-validate)
// Aggregate billing replaces request measurements; it must never become the live context size.
// Guard: run-turn usage classes and agent-cli's parser mapping table.
export function turnUsage(requests: readonly TurnUsage[]): Usage {
  const total = [...requests].reverse().find((u) => u.t === 'total');
  const counted = total ? [total] : requests;
  if (!counted.length) return { t: 'unreported', why: 'Harness reported no usage', requests };
  const tokens: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1H: 0 };
  for (const u of counted) {
    if (u.tokens.t === 'unreported') return { ...u.tokens, requests };
    tokens.input += u.tokens.input;
    tokens.output += u.tokens.output;
    tokens.cacheRead += u.tokens.cacheRead;
    tokens.cacheWrite += u.tokens.cacheWrite5m + u.tokens.cacheWrite1h;
    tokens.cacheWrite1H += u.tokens.cacheWrite1h;
  }
  return { t: 'reported', tokens };
}
// Pattern: sum-types (docs/patterns.md#sum-types)
class RunTurnPolicy extends ChatTurnPolicy {
  override readonly acceptsUserInput = false;
  // TurnWatchdog keeps owner.startedAt on adoption; expiry persists max_runtime_timeout.
  override readonly maxRuntimeMs: number;
  constructor(
    private readonly record: RunTurnAdoption,
    private readonly save: (o: ExecutionOutcome) => void
  ) {
    super(volatileCarrier);
    this.maxRuntimeMs = record.maxRuntimeMs;
  }
  // agent-cli encodes this capability set; adoption restores this same record, without respawn.
  override startTurn = () => ({ capabilities: this.record.capabilities });
  override adoptionRecord = (): RunTurnAdoption => this.record;
  override adopt(): void {}
  override settle(outcome: ExecutionOutcome): Promise<void> {
    return Promise.resolve(this.save(outcome));
  }
  override stop = () => false;
}
// Pattern: idempotency-keys (docs/patterns.md#idempotency-keys)
export function createRunTurn(ports: {
  directory: string;
  ready: Promise<void>;
  records: ConversationRecordStore;
  conversations: ConversationRegistry<ConversationRuntime>;
  Conversation: ConversationConstructor;
}) {
  const active = new Map<string, Promise<RunTurnOutcome>>();
  const file = (key: string) =>
    path.join(ports.directory, `${createHash('sha256').update(key).digest('hex')}.json`);
  const read = (key: string): Call | undefined => {
    try {
      return JSON.parse(fs.readFileSync(file(key), 'utf8')) as Call;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
  };
  // Atomic rename precedes spawn/return. Like execution journals, survives process death, not power loss.
  const write = (call: Call): void => {
    fs.mkdirSync(ports.directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${file(call.request.key)}.tmp`, JSON.stringify(call), { mode: 0o600 });
    fs.renameSync(`${file(call.request.key)}.tmp`, file(call.request.key));
  };
  const settle = (key: string, outcome: ExecutionOutcome): RunTurnOutcome => {
    const call = read(key);
    if (!call) throw new Error(`Missing turn key ${key}`);
    if (call.t === 'settled') return call.outcome;
    const result: RunTurnOutcome = {
      ...(outcome.t === 'complete'
        ? { t: outcome.t, text: outcome.final }
        : outcome.t === 'cancelled'
          ? { t: outcome.t }
          : outcome),
      usage: outcome.usage ?? turnUsage([]),
      conversationId: call.conversationId,
    };
    write({ ...call, t: 'settled', outcome: result });
    return result;
  };
  const policy = (record: RunTurnAdoption) =>
    new RunTurnPolicy(record, (outcome) => void settle(record.key, outcome));
  async function start(call: Call, fresh: boolean): Promise<RunTurnOutcome> {
    const r = call.request;
    if (call.t === 'settled') return call.outcome;
    if (fresh) {
      const config: ResolvedExecutionConfig = {
        provider: ProviderSchema.parse(r.provider),
        modelId: r.model,
        reasoningEffort: r.effort,
      };
      const selection = {
        provider: config.provider,
        model: { mode: 'explicit' as const, modelId: r.model },
        reasoning: { mode: 'explicit' as const, effort: r.effort },
      };
      const record = await ports.records.create({
        conversationId: call.conversationId,
        kind: { t: 'chat' },
        config: selection,
        workingDirectory: r.cwd,
        creation: { title: r.title },
        provenance: 'user',
        lastResolvedConfig: config,
      });
      const current = read(r.key);
      if (current?.t === 'settled') return current.outcome; // cancel during record creation
      const conversation = new ports.Conversation({
        id: call.conversationId,
        kind: record.kind,
        done: false,
        title: r.title,
        workingDirectory: r.cwd,
        configState: {
          config: selection,
          revision: record.configRevision,
          resolution: { status: 'resolved', catalogRevision: 'run-turn', value: config },
        },
      });
      ports.conversations.set(conversation);
      conversation.publishRow();
      conversation.startTurn(
        r.prompt,
        policy({
          t: 'run-turn',
          key: r.key,
          capabilities: r.capabilities,
          maxRuntimeMs: r.maxRuntimeMs,
        }),
        config
      );
    }
    await ports.conversations.get(call.conversationId)?.waitForTurnDrain();
    const current = read(r.key);
    if (current?.t === 'settled') return current.outcome;
    return settle(r.key, {
      t: 'failed',
      cause: 'server_restart',
      detail: 'Turn admission interrupted before an adoptable execution existed',
    });
  }
  return {
    async runTurn(request: RunTurnRequest): Promise<RunTurnOutcome> {
      await ports.ready; // adoption finishes before any caller may start or join a turn
      if (
        !request.key ||
        !Number.isSafeInteger(request.maxRuntimeMs) ||
        request.maxRuntimeMs <= 0 ||
        request.maxRuntimeMs > 2_147_483_647
      )
        throw new RangeError('A key and a positive timer-safe maxRuntimeMs are required');
      const r = JSON.parse(JSON.stringify(request)) as RunTurnRequest;
      const stored = read(r.key);
      const call = stored ?? { t: 'started', request: r, conversationId: randomUUID() };
      if (!isDeepStrictEqual(call.request, r))
        throw new TurnKeyConflictError(`Different request for key ${r.key}`);
      const existing = active.get(r.key);
      if (existing) return existing;
      // Before admission: a crash without an adoptable journal fails, never respawns.
      write(call);
      const promise = start(call, !stored)
        .catch((e: unknown) =>
          settle(r.key, { t: 'failed', cause: 'spawn_failed', detail: String(e) })
        )
        .finally(() => active.delete(r.key));
      active.set(r.key, promise);
      return promise;
    },
    async cancelTurn(key: string): Promise<void> {
      await ports.ready;
      const call = read(key);
      if (!call || call.t === 'settled') return;
      if (!ports.conversations.get(call.conversationId)?.process) {
        settle(key, { t: 'cancelled', detail: 'Cancelled before spawn' });
        return;
      }
      ports.conversations.get(call.conversationId)?.stopOwnedTurn();
      await ports.conversations.get(call.conversationId)?.waitForTurnDrain();
    },
    adopt(record: PolicyAdoption, fallback: TurnPolicy): TurnPolicy {
      switch (record.t) {
        case 'chat':
        case 'buddy':
        case 'builder':
          return fallback;
        case 'run-turn':
          return policy(record);
      }
    },
  };
}
