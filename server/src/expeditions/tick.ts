import { randomUUID } from 'node:crypto';
import type { BuddiesCore } from '@unleashd/buddies-core';
import { OWNER } from '../buddies/core';
import type { BuddyEvents } from '../buddies/events';
import type { ExecutionGate } from '../buddies/execution-gate';
import { labelled } from '../observability/event-loop-stall';
import { RUN_SCAN_LIMIT, SETTLED } from './meter';
import {
  type Attempt,
  type Clock,
  allAttempts,
  decide,
  live,
  pendingEffects,
  requestsOf,
} from './model';
import { type ObservePorts, ended, observe } from './observe';
import type { EffectRunner } from './run';
import type { ExpeditionStore } from './store';

// Ticks: observe, decide, run the effects, per expedition on its chain, until a round writes
// nothing. Pattern: wake-on-write (docs/patterns.md#wake-on-write) — ticks on the Buddy change
// bus (debounced) plus one slow backstop; no per-expedition timers.

const BACKSTOP_MS = 60_000;
const DEBOUNCE_MS = 1_500;
/** Ticks re-run decide after effects (crew created → first manager); bounded per tick. */
const ROUNDS_PER_TICK = 4;
/**
 * Failed ticks in a row before the host records `tick_failed` and backs off (audit 2026-11-01
 * #1): the backoff doubles from BACKOFF_BASE_MS up to BACKOFF_MAX_MS, so a persistent failure
 * costs a bounded number of attempts and log lines, never a hot loop. An owner steer retries at
 * once.
 */
const TICK_FAILURE_LIMIT = 3;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;

/** One tick's end: settled, or some observation or effect could not be made (typed data, audit
 * #1: an observe error used to throw before decide, so a stop or the deadline never landed). */
type TickResult = { t: 'ok' } | { t: 'part_failed'; reasons: string[] };

/** A tick's failure streak, and until when ticks wait (`until`, host-clock ms). */
interface Streak {
  failures: number;
  until: number;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface TickPorts {
  core: BuddiesCore;
  events: BuddyEvents;
  gate: ExecutionGate;
  now: () => string;
  store: ExpeditionStore;
  effects: EffectRunner;
}

export type Ticker = ReturnType<typeof createTicker>;

export function createTicker(ports: TickPorts) {
  const { core, events, gate, now, store, effects } = ports;
  const { append, stateOf, serialized } = store;
  const observer: ObservePorts = { core, now };
  const streaks = new Map<string, Streak>();
  const clock = (): Clock => ({
    now: now(),
    nextId: (prefix) => `${prefix}${randomUUID().slice(0, 6)}`,
  });

  async function tickOnce(id: string): Promise<TickResult> {
    let wrote = false;
    const failures: string[] = [];
    for (let round = 0; round < ROUNDS_PER_TICK; round += 1) {
      // A retirement filed it away (run.ts fileAway): nothing of it is left to tick.
      if (!store.folds(id)) break;
      const before = store.written(id);
      const observed = await observe(observer, stateOf(id));
      failures.push(...observed.failures);
      await append(id, observed.entries);
      await append(id, decide(store.forDecide(id), clock()));
      for (const effect of pendingEffects(stateOf(id))) {
        // Each effect reads the state its predecessor left (a brief sees earlier postings), and
        // runs on its own: one that throws is a typed failure of this tick, never a stop for the
        // effects after it. 2026-11-01 review: a release whose `cambium list` failed kept every
        // later effect, the stop's cancel_attempt included, from running.
        try {
          await append(id, await effects.run(stateOf(id), effect));
        } catch (error) {
          failures.push(`effect ${effect.t}: ${errorText(error)}`);
        }
      }
      // A round that wrote nothing is settled (a running check job's effect writes nothing), so
      // the tick neither spins nor emits a change that would wake itself again.
      if (store.written(id) === before) break;
      wrote = true;
    }
    if (wrote) events.emit({ kind: 'changed' });
    // One reason per distinct failure: each round re-observes, and would repeat it.
    const reasons = [...new Set(failures)];
    return reasons.length === 0 ? { t: 'ok' } : { t: 'part_failed', reasons };
  }

  /**
   * Serialized per expedition. A tick that throws, or whose observation failed, extends the
   * expedition's failure streak; after TICK_FAILURE_LIMIT in a row the host records `tick_failed`
   * and waits a doubling backoff before the next tick (audit #1). A clean tick ends the streak.
   */
  function tick(id: string): Promise<void> {
    const streak = streaks.get(id);
    if (streak && Date.parse(now()) < streak.until) return Promise.resolve();
    return serialized(id, () => tickOnce(id)).then(
      (result) => tickSettled(id, result),
      (error: unknown) => tickFailed(id, [errorText(error)])
    );
  }

  function tickSettled(id: string, result: TickResult): Promise<void> {
    switch (result.t) {
      case 'ok':
        streaks.delete(id);
        return Promise.resolve();
      case 'part_failed':
        return tickFailed(id, result.reasons);
    }
  }

  async function tickFailed(id: string, reasons: string[]): Promise<void> {
    const failures = (streaks.get(id)?.failures ?? 0) + 1;
    const reason = reasons.join('; ');
    console.warn(`[expeditions] tick ${id} failed (${failures} in a row): ${reason}`);
    if (failures < TICK_FAILURE_LIMIT) {
      streaks.set(id, { failures, until: 0 });
      return;
    }
    const backoff = Math.min(
      BACKOFF_BASE_MS * 2 ** (failures - TICK_FAILURE_LIMIT),
      BACKOFF_MAX_MS
    );
    streaks.set(id, { failures, until: Date.parse(now()) + backoff });
    if (!store.folds(id)) return;
    await serialized(id, () =>
      append(id, [{ t: 'tick_failed', at: now(), failures, reason: reason.slice(0, 2000) }])
    ).catch((error: unknown) =>
      console.warn(`[expeditions] ${id}: tick_failed not recorded:`, error)
    );
  }

  // A finished expedition stays active while it owes effects (its last status, worktree removal,
  // a bounded metering read) or has live attempts: their ends are still observed, and only then
  // are their trees released. Reads the cached states: no fold per event.
  const active = () =>
    store
      .states()
      .flatMap((s) =>
        s.run.t !== 'finished' || live(s).length > 0 || pendingEffects(s).length > 0 ? [s.id] : []
      );
  const tickAll = () => Promise.all(active().map(tick)).then(() => undefined);

  /** The owner wrote in an expedition's chat: its next tick runs whatever a failing streak's
   * backoff says, as a steer does. 2026-11-01 review: "resume" in the chat (the L3 recovery path)
   * waited out up to 30 minutes of backoff, because only the steer tool cleared the streak. */
  function ownerPosted(channelId: string): void {
    for (const s of store.states())
      if (s.crew.t === 'ready' && s.crew.chatChannelId === channelId) streaks.delete(s.id);
  }

  let debounce: NodeJS.Timeout | null = null;
  const wake = labelled('timer expeditions-wake', () => {
    debounce = null;
    void tickAll();
  });
  /** Wake-on-write and the backstop, started by `start` (after boot adoption), never at
   * construction: a tick before `interruptBootLive` could observe a crew run the restart is
   * about to cancel. Returns how to stop them. */
  function startTicking(): () => void {
    const unsubscribe = events.on((event) => {
      if (event.kind !== 'changed' && event.kind !== 'posted') return;
      if (event.kind === 'posted' && event.post.author.kind === 'owner')
        ownerPosted(event.channel.id);
      if (debounce || active().length === 0) return;
      debounce = setTimeout(wake, DEBOUNCE_MS);
      debounce.unref();
    });
    const backstop = setInterval(
      labelled('timer expeditions-backstop', () => void tickAll()),
      BACKSTOP_MS
    );
    backstop.unref();
    void tickAll();
    return () => {
      unsubscribe();
      clearInterval(backstop);
    };
  }
  // A disabled gate (a copied store, execution-gate.ts) never ticks; launch and steer refuse.
  const TICKING: Record<ExecutionGate['t'], () => () => void> = {
    enabled: startTicking,
    disabled: () => () => undefined,
  };
  type Ticking = { t: 'stopped' } | { t: 'started'; stop: () => void };
  let ticking: Ticking = { t: 'stopped' };
  function start(): void {
    if (ticking.t === 'started') throw new Error('the expedition host is already started');
    ticking = { t: 'started', stop: TICKING[gate.t]() };
  }

  // ---------- Restart: no crew turn outlives the backend that started it ----------

  /**
   * Boot, before execution adoption and before the runner starts (server.ts). Every unsettled
   * run of every ready crew is cancelled, and every attempt still waiting on one ends
   * `interrupted` (decide replans it on a new session). Regression: owner 2026-11-03: crews
   * restart on new sessions. Cancelling is what keeps a crew's run from resuming: adoption
   * refuses the crew's turn (adopt-executions.ts restartOf), and a run left `running` would end
   * `lease_expired`, which decision G (runs.rs `resume`) continues ONCE in the SAME
   * conversation, on the dead backend's session. A cancelled run ends `cancelled`, never resumed.
   * A copied store (gate disabled) runs nothing, so it cancels and writes nothing.
   */
  async function interruptBootLive(): Promise<void> {
    if (gate.t === 'disabled') return;
    for (const s of store.states())
      if (s.crew.t === 'ready')
        await serialized(s.id, () => interruptCrew(s.id)).catch((error: unknown) =>
          console.error(`[expeditions] ${s.id}: the crew's runs could not be interrupted:`, error)
        );
  }

  async function interruptCrew(id: string): Promise<void> {
    // An attempt whose brief is recorded but not its post is posted first (same key: a post a
    // crash left is found, not made twice), so every live attempt names its request.
    for (const a of allAttempts(stateOf(id)))
      if (a.phase.t === 'posting')
        await append(id, await effects.postAttempt(stateOf(id), a.id, a.phase.body, a.phase.round));
    const s = stateOf(id);
    if (s.crew.t !== 'ready') throw new Error(`expedition ${id} interrupted before its crew`);
    // Before the cancel: an attempt whose request already settled is the observer's, not ours.
    const waiting: Attempt[] = [];
    for (const a of allAttempts(s)) {
      if (a.phase.t !== 'posted') continue;
      const request = await core.getPost(OWNER, a.phase.requestId);
      if (request.request.state === 'awaiting' || request.request.state === 'none') waiting.push(a);
    }
    const unsettled = (
      await core.listRuns({ kind: 'buddy', buddyId: s.crew.buddyId }, RUN_SCAN_LIMIT)
    ).filter((r) => !SETTLED.has(r.status));
    for (const r of unsettled) {
      const run = await core.cancelRun(OWNER, r.id);
      events.emit({ kind: 'cancelled', run });
    }
    for (const a of waiting) {
      const posts = new Set(requestsOf(s, a.id));
      const runIds = unsettled
        .filter((r) => r.input.kind === 'post' && posts.has(r.input.postId))
        .map((r) => r.id);
      await append(id, [
        await ended(observer, stateOf(id), a, {
          t: 'interrupted',
          cause: 'server_restart',
          runIds,
        }),
      ]);
    }
    if (unsettled.length > 0 || waiting.length > 0)
      console.log(
        `[expeditions] ${id}: restart cancelled ${unsettled.length} crew runs, interrupted ${waiting.length} attempts`
      );
  }

  return {
    tick,
    /** The owner's word (a steer, a retire): the next tick runs whatever a failing streak's
     * backoff says. */
    urge(id: string): Promise<void> {
      streaks.delete(id);
      return tick(id);
    },
    start,
    interruptBootLive,
    close(): void {
      if (ticking.t === 'started') ticking.stop();
      ticking = { t: 'stopped' };
      if (debounce) clearTimeout(debounce);
    },
  };
}
