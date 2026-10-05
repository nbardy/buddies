import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ADOPTIONS,
  type AdoptionTable,
  type Effect,
  type Execution,
  type ExecutionEvent,
  type ExecutionOutcome,
  GRANTS,
  type GrantTable,
  type Phase,
  type StopIntent,
  TRANSITIONS,
  type TransitionTable,
  adoption,
  applyStep,
  holdsGrant,
} from '../src/turns/execution-state';

/**
 * Exhaustive small-scope crash checker for one execution's persisted state (execution-state.ts;
 * Pattern: persisted-state-machine). It drives the REAL `applyStep`, `transition`, `adoption`
 * and `holdsGrant` against a model world, the way TurnRunner and boot adoption drive them:
 * - the journal's phase (on disk, survives a crash);
 * - the provider process, which ignores SIGTERM, so only the backend's own SIGKILL escalation
 *   kills it, and that timer dies with the backend (the 2a window);
 * - the run row and the attempt record (durable; the first settle wins, as the lease and the
 *   attempt journal enforce);
 * - the tool grants (in memory, lost at a crash; boot restores `holdsGrant`).
 * Every atomic action is a crash point. For each scenario it enumerates where the process exits
 * on its own, where the live backend dies, and where the recovering backend dies again; a third
 * backend then runs to the end. Expectations come from the scenario (what the owner did and
 * when it reached disk), never from the transition table.
 *
 * Invariants:
 * - 2a: no backend restores a grant for a turn whose stop (or reset) reached disk;
 * - 2b: a run settles with the outcome first decided on disk, never "still running" (which the
 *   lease gate would fail) and never anything else;
 * - exactly one settle: the run and the attempt are settled once, every repeat agrees;
 * - at most one writer: never two live processes holding grants in one conversation;
 * - Stop always kills: a process whose stop reached disk is dead at the end.
 * The mutation check breaks each rule in a copy of the tables and requires a violation.
 * Incidents and decision: agent_notes/2026-10-03_p1-single-execution-state-decision.md.
 */

interface Tables {
  transitions: TransitionTable;
  adoptions: AdoptionTable;
  grants: GrantTable;
}
const REAL: Tables = { transitions: TRANSITIONS, adoptions: ADOPTIONS, grants: GRANTS };

type Expected = 'complete' | 'cancelled' | 'failed:max_runtime_timeout' | 'none';
const keyOf = (outcome: ExecutionOutcome): string =>
  outcome.t === 'failed' ? `failed:${outcome.cause}` : outcome.t;
const EXPECT_STOP: { readonly [I in StopIntent['t']]: Expected } = {
  user_stop: 'cancelled',
  timeout: 'failed:max_runtime_timeout',
};
const USER_STOP: StopIntent = { t: 'user_stop' };
const TIMEOUT: StopIntent = {
  t: 'timeout',
  terminalCause: 'max_runtime_timeout',
  message: 'maximum runtime',
};

interface Turn {
  readonly dir: string;
  readonly conversation: string;
  /** Has a run row: an abandoned (reset) turn's drain is never settled. */
  readonly settles: boolean;
}

/** Durable state: what survives a backend crash. */
interface World {
  phase: Map<string, Phase>;
  alive: Map<string, boolean>;
  /** How a dead process ended: what a replay of its journal shows. */
  ended: Map<string, ExecutionOutcome>;
  /** The outcome the first durable deciding event fixed (a stop, or a natural drain). */
  decided: Map<string, Expected>;
  /** A stop or reset reached disk: the process must die. */
  mustDie: Set<string>;
  runSettles: Map<string, string[]>;
  attemptRecords: Map<string, string[]>;
  violations: string[];
}

class Crash extends Error {}

/** One backend: in-memory state, all lost at a crash. */
class Backend {
  readonly grants = new Set<string>();
  readonly followed = new Map<string, Execution>();
  /** Drained: the runner detached its process, so a later Stop finds nothing (TurnRunner.stop). */
  private readonly detached = new Set<string>();
  private readonly queue: Array<() => void> = [];
  actions = 0;

  constructor(
    private readonly world: World,
    private readonly turns: readonly Turn[],
    private readonly tables: Tables,
    private readonly crashAt: number,
    private readonly exitAt: number
  ) {}

  push(action: () => void): void {
    this.queue.push(action);
  }

  /** Run queued actions; the crash point and the process's own exit are action boundaries. */
  drain(): void {
    while (this.queue.length) {
      if (this.actions === this.exitAt) this.exitNaturally(this.turns[0]);
      if (this.actions === this.crashAt) throw new Crash();
      this.actions += 1;
      this.queue.shift()!();
      this.checkWriters();
    }
  }

  exitNaturally(turn: Turn): void {
    this.end(turn, { t: 'complete', text: 'done' });
  }

  private kill(turn: Turn): void {
    this.end(turn, { t: 'failed', cause: 'process_killed', detail: 'killed' });
  }

  /** The process ends; its follower sees the end and every byte: the drain. */
  private end(turn: Turn, observed: ExecutionOutcome): void {
    if (!this.world.alive.get(turn.dir)) return;
    this.world.alive.set(turn.dir, false);
    this.world.ended.set(turn.dir, observed);
    const execution = this.followed.get(turn.dir);
    if (execution) this.push(() => this.step(turn, execution, { t: 'drained', observed }));
  }

  spawn(turn: Turn): void {
    this.push(() => {
      this.world.phase.set(turn.dir, { t: 'running' });
      this.world.alive.set(turn.dir, true);
      this.followed.set(turn.dir, { dir: turn.dir, phase: { t: 'running' } });
      this.grants.add(turn.dir);
    });
  }

  input(turn: Turn, event: ExecutionEvent): void {
    this.push(() => {
      const execution = this.followed.get(turn.dir);
      if (execution && !this.detached.has(turn.dir)) this.step(turn, execution, event);
    });
  }

  /** The real interpreter step: the phase is written, then each effect is its own action. */
  private step(turn: Turn, execution: Execution, event: ExecutionEvent): void {
    if (event.t === 'drained') this.detached.add(turn.dir);
    const effects = applyStep(
      execution,
      event,
      (dir, phase) => this.world.phase.set(dir, phase),
      this.tables.transitions
    );
    this.recordDurable(turn, event);
    for (const effect of effects) this.push(() => this.effect(turn, execution, effect));
  }

  private recordDurable(turn: Turn, event: ExecutionEvent): void {
    const { decided, mustDie } = this.world;
    if (event.t === 'stop' || event.t === 'abandon') mustDie.add(turn.dir);
    if (decided.has(turn.dir)) return;
    if (event.t === 'stop') decided.set(turn.dir, EXPECT_STOP[event.intent.t]);
    if (event.t === 'drained' && event.observed.t === 'complete') decided.set(turn.dir, 'complete');
  }

  private effect(turn: Turn, execution: Execution, effect: Effect): void {
    switch (effect.t) {
      case 'revoke_grant':
        this.grants.delete(turn.dir);
        return;
      case 'signal':
        // SIGTERM is ignored; the SIGKILL escalation is a later action of this backend only.
        this.push(() => this.kill(turn));
        return;
      case 'arm_deadline':
        return;
      case 'settle': {
        const key = keyOf(effect.outcome);
        this.push(() => this.record(this.world.attemptRecords, turn, key));
        if (turn.settles) this.push(() => this.record(this.world.runSettles, turn, key));
        this.push(() => this.step(turn, execution, { t: 'landed' }));
        return;
      }
      case 'remove':
        this.world.phase.delete(turn.dir);
        this.followed.delete(turn.dir);
        return;
    }
  }

  private record(store: Map<string, string[]>, turn: Turn, key: string): void {
    store.set(turn.dir, [...(store.get(turn.dir) ?? []), key]);
  }

  /** Boot: restore grants from disk alone, then adopt or discard each journal. */
  boot(): void {
    for (const turn of this.turns) {
      const phase = this.world.phase.get(turn.dir);
      if (!phase) continue;
      const process = this.world.alive.get(turn.dir) ? 'live' : 'ended';
      if (holdsGrant(phase, process, this.tables.grants)) {
        this.grants.add(turn.dir);
        if (this.world.mustDie.has(turn.dir))
          this.violate(`2a: ${turn.dir} got its grant back after its stop reached disk`);
      }
    }
    const adopting = new Set<string>();
    for (const turn of this.turns) {
      const phase = this.world.phase.get(turn.dir);
      if (!phase) continue;
      const process = this.world.alive.get(turn.dir) ? 'live' : 'ended';
      const plan = adoption(phase, process, this.tables.adoptions);
      // The real conversation refuses a second adopted turn ("already running"): discarded.
      if (plan.t === 'discard' || adopting.has(turn.conversation)) {
        this.push(() => {
          this.kill(turn);
          this.world.phase.delete(turn.dir);
          this.grants.delete(turn.dir);
        });
        continue;
      }
      adopting.add(turn.conversation);
      const execution: Execution = { dir: turn.dir, phase };
      this.followed.set(turn.dir, execution);
      for (const effect of plan.effects) this.push(() => this.effect(turn, execution, effect));
      // The replay of a dead process's journal drains at once, showing how it ended.
      const observed = this.world.ended.get(turn.dir);
      if (observed) this.push(() => this.step(turn, execution, { t: 'drained', observed }));
    }
  }

  /** The owner's inputs, each once the previous one's effects ran, as the runtime does them. */
  live(scenario: Scenario): void {
    this.spawn(scenario.turns[0]);
    this.drain();
    for (const input of scenario.inputs) {
      input(this);
      this.drain();
    }
    this.finish();
  }

  /** A turn that may legitimately still run finishes on its own once nothing else is queued. */
  finish(): void {
    this.drain();
    for (const turn of this.turns) {
      if (this.world.mustDie.has(turn.dir)) continue;
      this.exitNaturally(turn);
      this.drain();
    }
  }

  private checkWriters(): void {
    const writers = new Map<string, number>();
    for (const turn of this.turns)
      if (this.world.alive.get(turn.dir) && this.grants.has(turn.dir))
        writers.set(turn.conversation, (writers.get(turn.conversation) ?? 0) + 1);
    for (const [conversation, count] of writers)
      if (count > 1) this.violate(`one writer: ${count} live grant holders in ${conversation}`);
  }

  violate(message: string): void {
    this.world.violations.push(message);
  }
}

interface Scenario {
  readonly name: string;
  readonly turns: readonly Turn[];
  /** The live backend's inputs after spawning the first turn. */
  readonly inputs: ReadonlyArray<(backend: Backend) => void>;
}

const A: Turn = { dir: 'a', conversation: 'c', settles: true };
const B: Turn = { dir: 'b', conversation: 'c', settles: true };
const ABANDONED: Turn = { dir: 'a', conversation: 'c', settles: false };

const SCENARIOS: readonly Scenario[] = [
  { name: 'finishes', turns: [A], inputs: [] },
  { name: 'owner Stop', turns: [A], inputs: [(b) => b.input(A, { t: 'stop', intent: USER_STOP })] },
  { name: 'timeout', turns: [A], inputs: [(b) => b.input(A, { t: 'stop', intent: TIMEOUT })] },
  {
    name: 'timeout, then Stop',
    turns: [A],
    inputs: [
      (b) => b.input(A, { t: 'stop', intent: TIMEOUT }),
      (b) => b.input(A, { t: 'stop', intent: USER_STOP }),
    ],
  },
  {
    name: 'reset, then the next turn',
    turns: [ABANDONED, B],
    inputs: [(b) => b.input(ABANDONED, { t: 'abandon' }), (b) => b.spawn(B)],
  },
];

function freshWorld(): World {
  return {
    phase: new Map(),
    alive: new Map(),
    ended: new Map(),
    decided: new Map(),
    mustDie: new Set(),
    runSettles: new Map(),
    attemptRecords: new Map(),
    violations: [],
  };
}

/** Run until `crashes` are spent, then one clean backend to the end; return the violations. */
function simulate(
  scenario: Scenario,
  tables: Tables,
  exitAt: number,
  crashes: readonly number[]
): { violations: string[]; actions: number } {
  const world = freshWorld();
  const first = new Backend(world, scenario.turns, tables, crashes[0] ?? -1, exitAt);
  let last = first;
  let crashed = crashedIn(() => first.live(scenario));
  // Each crash spends one recovery; the backend after the last crash runs to the end.
  for (let i = 1; crashed; i += 1) {
    const backend = new Backend(world, scenario.turns, tables, crashes[i] ?? -1, -1);
    last = backend;
    crashed = crashedIn(() => {
      backend.boot();
      backend.finish();
    });
  }
  checkEnd(world, scenario, last);
  return { violations: world.violations, actions: first.actions };
}

/** True when the backend crashed. */
function crashedIn(run: () => void): boolean {
  try {
    run();
    return false;
  } catch (error) {
    if (error instanceof Crash) return true;
    throw error;
  }
}

function checkEnd(world: World, scenario: Scenario, last: Backend): void {
  const fail = (message: string) => world.violations.push(message);
  // A turn never spawned (the backend died first) has nothing to check.
  for (const turn of scenario.turns.filter((t) => world.alive.has(t.dir))) {
    if (world.phase.has(turn.dir))
      fail(`${turn.dir}: journal left as ${world.phase.get(turn.dir)?.t}`);
    if (world.alive.get(turn.dir))
      fail(
        world.mustDie.has(turn.dir)
          ? `Stop always kills: ${turn.dir} outlived its durable stop`
          : `${turn.dir}: process still alive at the end`
      );
    if (last.grants.has(turn.dir)) fail(`${turn.dir}: grant still live at the end`);
    if (!turn.settles) continue;
    const expected = world.decided.get(turn.dir) ?? 'none';
    const settles = world.runSettles.get(turn.dir) ?? [];
    if (settles.length === 0) fail(`2b: ${turn.dir} never settled (the lease gate would fail it)`);
    for (const key of [...settles, ...(world.attemptRecords.get(turn.dir) ?? [])])
      if (key !== expected)
        fail(`exactly one settle: ${turn.dir} settled ${key}, expected ${expected}`);
  }
}

let simulations = 0;

/** Every exit point × every live crash point × every recovery crash point. */
function check(tables: Tables): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const scenario of SCENARIOS) {
    const clean = simulate(scenario, tables, Number.POSITIVE_INFINITY, []);
    const span = clean.actions + 2;
    for (let exitAt = 0; exitAt <= span; exitAt += 1) {
      const run = (crashes: number[]) => {
        simulations += 1;
        for (const violation of simulate(scenario, tables, exitAt, crashes).violations) {
          const key = `${scenario.name}: ${violation}`;
          if (!found.has(key)) found.set(key, [`exit@${exitAt} crashes@${crashes.join(',')}`]);
        }
      };
      run([]);
      for (let first = 0; first <= span; first += 1) {
        run([first]);
        for (let second = 0; second <= span; second += 1) run([first, second]);
      }
    }
  }
  return found;
}

test('every crash point: no restored grant after a stop, one agreeing settle, one writer, Stop kills', () => {
  const violations = check(REAL);
  assert.deepEqual([...violations.entries()], []);
  // A guard on the checker itself: an enumeration that collapsed would pass vacuously.
  assert.ok(simulations > 10_000, `only ${simulations} interleavings were checked`);
});

/** A copy of the real tables with one cell broken. */
function mutant(
  name: string,
  change: (tables: {
    transitions: Record<string, Record<string, unknown>>;
    adoptions: Record<string, Record<string, unknown>>;
    grants: Record<string, Record<string, boolean>>;
  }) => void
): { name: string; tables: Tables } {
  const copy = {
    transitions: Object.fromEntries(
      Object.entries(TRANSITIONS).map(([phase, row]) => [phase, { ...row }])
    ),
    adoptions: Object.fromEntries(
      Object.entries(ADOPTIONS).map(([phase, row]) => [phase, { ...row }])
    ),
    grants: Object.fromEntries(Object.entries(GRANTS).map(([phase, row]) => [phase, { ...row }])),
  };
  change(copy);
  return { name, tables: copy as unknown as Tables };
}

test('mutation check: each broken rule is caught', () => {
  const mutants = [
    // 811f758's 2a: a stop changed nothing on disk before the signal.
    mutant('stop is not persisted', (t) => {
      t.transitions.running.stop = (phase: Phase) => ({
        phase,
        effects: [{ t: 'revoke_grant' }, { t: 'signal' }],
      });
    }),
    // 811f758's 2b: the journal went away before the settle landed.
    mutant('the journal is removed before the settle lands', (t) => {
      t.transitions.running.drained = (_: Phase, event: { observed: ExecutionOutcome }) => ({
        phase: { t: 'settled' },
        effects: [{ t: 'remove' }, { t: 'settle', outcome: event.observed }],
      });
    }),
    mutant('a stopping turn adopted live keeps its grant', (t) => {
      t.grants.stopping = { live: true, ended: false };
    }),
    mutant('an adopted stopping turn is not signalled again', (t) => {
      t.adoptions.stopping = {
        live: () => ({ t: 'follow', effects: [] }),
        ended: () => ({ t: 'follow', effects: [] }),
      };
    }),
    mutant('a reset keeps its grant', (t) => {
      t.transitions.running.abandon = () => ({
        phase: { t: 'abandoned' },
        effects: [{ t: 'signal' }],
      });
    }),
    mutant("an ended turn's adoption re-decides its outcome", (t) => {
      t.transitions.ended.drained = (_: Phase, event: { observed: ExecutionOutcome }) => ({
        phase: { t: 'ended', outcome: event.observed },
        effects: [{ t: 'settle', outcome: event.observed }],
      });
    }),
  ];
  for (const { name, tables } of mutants) {
    const violations = check(tables);
    assert.ok(violations.size > 0, `the checker missed the mutant "${name}"`);
  }
});
