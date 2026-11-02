import { randomUUID } from 'node:crypto';
import type { BuddiesCore } from '@unleashd/buddies-core';
import { OWNER } from '../buddies/core';
import type { BuddyEvents } from '../buddies/events';
import type { ExecutionGate } from '../buddies/execution-gate';
import { labelled } from '../observability/event-loop-stall';
import { allAttempts, decide, live, pendingEffects, requestsOf } from './model';
import { type ObservePorts, ended, errorText, observe } from './observe';
import type { EffectRunner } from './run';
import type { ExpeditionStore } from './store';

// Ticks: observe, decide, run the effects, per expedition on its chain, until a round writes
// nothing. Wake-on-write (docs/patterns.md#wake-on-write): the Buddy change bus (debounced) plus
// one slow backstop; no per-expedition timers.

const BACKSTOP_MS = 60_000;
const DEBOUNCE_MS = 1_500;
/** Ticks re-run decide after effects (crew created → first manager); bounded per tick. */
const ROUNDS_PER_TICK = 4;
/** Failed ticks in a row before `tick_failed` and a backoff doubling from BACKOFF_BASE_MS to
 * BACKOFF_MAX_MS (audit 2026-11-01 #1): never a hot loop. An owner's word retries at once. */
const TICK_FAILURE_LIMIT = 3;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;

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
  /** Each expedition's failure streak, and until when ticks wait (host-clock ms). */
  const streaks = new Map<string, { failures: number; until: number }>();
  const nextId = (prefix: string) => `${prefix}${randomUUID().slice(0, 6)}`;
  const clock = () => ({ now: now(), nextId });

  /** One tick; the distinct reasons any observation or effect failed (audit #1: an observe error
   * used to throw before decide, so a stop or the deadline never landed). */
  async function tickOnce(id: string): Promise<string[]> {
    let wrote = false;
    const failures: string[] = [];
    // A retirement filed it away (run.ts file_retired): nothing of it is left to tick.
    for (let round = 0; round < ROUNDS_PER_TICK && store.folds(id); round += 1) {
      const before = store.written(id);
      const observed = await observe(observer, stateOf(id));
      failures.push(...observed.failures);
      await append(id, observed.entries);
      await append(id, decide(store.forDecide(id), clock()));
      for (const effect of pendingEffects(stateOf(id))) {
        // Each effect reads the state its predecessor left and runs on its own. 2026-11-01
        // review: a release whose `cambium list` failed kept the stop's cancel_attempt from running.
        try {
          await append(id, await effects.run(stateOf(id), effect));
        } catch (error) {
          failures.push(`effect ${effect.t}: ${errorText(error)}`);
        }
      }
      // A round that wrote nothing is settled, so the tick neither spins nor wakes itself again.
      if (store.written(id) === before) break;
      wrote = true;
    }
    if (wrote) events.emit({ kind: 'changed' });
    return [...new Set(failures)];
  }

  /** Serialized per expedition. A failing tick extends the streak; a clean one ends it. */
  function tick(id: string): Promise<void> {
    if (Date.parse(now()) < (streaks.get(id)?.until ?? 0)) return Promise.resolve();
    return serialized(id, () => tickOnce(id)).then(
      (reasons) => (reasons.length === 0 ? void streaks.delete(id) : tickFailed(id, reasons)),
      (error: unknown) => tickFailed(id, [errorText(error)])
    );
  }

  async function tickFailed(id: string, reasons: string[]): Promise<void> {
    const failures = (streaks.get(id)?.failures ?? 0) + 1;
    const reason = reasons.join('; ');
    console.warn(`[expeditions] tick ${id} failed (${failures} in a row): ${reason}`);
    const backoff = Math.min(
      BACKOFF_BASE_MS * 2 ** (failures - TICK_FAILURE_LIMIT),
      BACKOFF_MAX_MS
    );
    const limited = failures >= TICK_FAILURE_LIMIT;
    streaks.set(id, { failures, until: limited ? Date.parse(now()) + backoff : 0 });
    if (!limited || !store.folds(id)) return;
    const failed = {
      t: 'tick_failed',
      at: now(),
      failures,
      reason: reason.slice(0, 2000),
    } as const;
    await serialized(id, () => append(id, [failed])).catch((error: unknown) =>
      console.warn(`[expeditions] ${id}: tick_failed not recorded:`, error)
    );
  }

  // A finished expedition stays active while it owes effects or has live attempts: their ends
  // are still observed, and only then are their trees released. Reads the cached states.
  const active = () =>
    store
      .states()
      .filter((s) => s.run.t !== 'finished' || live(s).length > 0 || pendingEffects(s).length > 0)
      .map((s) => s.id);
  const tickAll = () => Promise.all(active().map(tick)).then(() => undefined);

  let debounce: NodeJS.Timeout | null = null;
  const wake = labelled('timer expeditions-wake', () => {
    debounce = null;
    void tickAll();
  });
  /** Wake-on-write and the backstop, started after boot adoption, never at construction: a tick
   * before `interruptBootLive` could observe a crew run the restart is about to cancel. */
  function startTicking(): () => void {
    const unsubscribe = events.on((event) => {
      if (event.kind !== 'changed' && event.kind !== 'posted') return;
      // The owner wrote in an expedition's chat: its next tick ignores the backoff, as a steer
      // does. 2026-11-01 review: "resume" in the chat waited out up to 30 minutes of backoff.
      if (event.kind === 'posted' && event.post.author.kind === 'owner')
        for (const s of store.states())
          if (s.crew.t === 'ready' && s.crew.chatChannelId === event.channel.id)
            streaks.delete(s.id);
      if (debounce || active().length === 0) return;
      debounce = setTimeout(wake, DEBOUNCE_MS);
      debounce.unref();
    });
    const backstop = setInterval(labelled('timer expeditions-backstop', tickAll), BACKSTOP_MS);
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
  let ticking: { t: 'stopped' } | { t: 'started'; stop: () => void } = { t: 'stopped' };

  /** Boot (server.ts): every ready crew's unsettled runs are cancelled and their attempts end
   * `interrupted` (decide replans them). Regression, owner 2026-11-03: a run left `running` ended
   * `lease_expired`, which runs.rs `resume` continued ONCE on the dead backend's session. */
  async function interruptBootLive(): Promise<void> {
    if (gate.t === 'disabled') return;
    for (const s of store.states())
      if (s.crew.t === 'ready')
        await serialized(s.id, () => interruptCrew(s.id)).catch((error: unknown) =>
          console.error(`[expeditions] ${s.id}: the crew's runs could not be interrupted:`, error)
        );
  }

  async function interruptCrew(id: string): Promise<void> {
    // A brief recorded but not posted is posted first (same key: a post a crash left is found),
    // so every live attempt names its request.
    for (const a of allAttempts(stateOf(id)))
      if (a.phase.t === 'posting')
        await append(id, await effects.postAttempt(stateOf(id), a.id, a.phase.body, a.phase.round));
    const s = stateOf(id);
    if (s.crew.t !== 'ready') throw new Error(`expedition ${id} interrupted before its crew`);
    // Before the cancel: an attempt whose request already settled is the observer's, not ours.
    const waiting = [];
    for (const a of allAttempts(s))
      if (a.phase.t === 'posted') {
        const { request } = await core.getPost(OWNER, a.phase.requestId);
        if (request.state === 'awaiting' || request.state === 'none') waiting.push(a);
      }
    const unsettled = await effects.cancelRuns(s.crew.buddyId, () => true);
    for (const a of waiting) {
      const posts = new Set(requestsOf(s, a.id));
      const ours = unsettled.filter((r) => r.input.kind === 'post' && posts.has(r.input.postId));
      const cause = {
        t: 'interrupted',
        cause: 'server_restart',
        runIds: ours.map((r) => r.id),
      } as const;
      await append(id, [await ended(observer, stateOf(id), a, cause)]);
    }
    if (unsettled.length > 0 || waiting.length > 0)
      console.log(
        `[expeditions] ${id}: restart cancelled ${unsettled.length} crew runs, interrupted ${waiting.length} attempts`
      );
  }

  return {
    tick,
    /** The owner's word (a steer, a retire): the next tick ignores a failing streak's backoff. */
    urge(id: string): Promise<void> {
      streaks.delete(id);
      return tick(id);
    },
    start(): void {
      if (ticking.t === 'started') throw new Error('the expedition host is already started');
      ticking = { t: 'started', stop: TICKING[gate.t]() };
    },
    interruptBootLive,
    close(): void {
      if (ticking.t === 'started') ticking.stop();
      ticking = { t: 'stopped' };
      if (debounce) clearTimeout(debounce);
    },
  };
}
