import os from 'node:os';
import path from 'node:path';
import { APP_DATA_DIR_ENV } from '../app-data';

/**
 * Pattern: fix-guards (docs/patterns.md#fix-guards) — Buddy execution admission, decided once.
 *
 * Incident 2026-09-30 22:09: a throwaway server booted on a `.backup` COPY of the live Buddies DB
 * with codex on PATH. Boot recovery ended 10 'interrupted' runs, queued their failure notices and
 * launched 5 real codex workers. AGENTS.md forbade it; nothing enforced it.
 *
 * "Not the owner's default" means: UNLEASHD_BUDDIES_DB, UNLEASHD_DATA_DIR or BUDDIES_HOME is SET
 * and resolves somewhere other than the home-directory default. It is path-keyed, not
 * "any override", because measured over the five suites that boot server.ts, every one sets
 * HOME to a temp dir: execution-adoption.test.ts then sits on its default data dir (still
 * enabled, no opt-in), while run-lease and ctrl-c-adoption use their own dirs and carry the
 * opt-in. A copy is exactly a store at a non-default path, so this is the property that matters.
 *
 * The opt-in is UNLEASHD_BUDDY_EXECUTION=1. A disabled backend is still a server: it serves the
 * copied data and takes owner commands. Only Buddy execution is inert — the scheduler and its
 * recovery follow-ups, worker spawns, the memory reviewer and adoption of journaled executions
 * (which would attach to the owner's LIVE agent processes recorded in a copied journal).
 * Guard: server/test/copied-store-guard.test.ts.
 */
export const BUDDY_EXECUTION_ENV = 'UNLEASHD_BUDDY_EXECUTION';

export type ExecutionGate =
  | { t: 'enabled' }
  | { t: 'disabled'; reason: string };

const resolved = (value: string | undefined) => (value?.trim() ? path.resolve(value) : null);

export function decideExecutionGate(env: NodeJS.ProcessEnv = process.env): ExecutionGate {
  if (env[BUDDY_EXECUTION_ENV] === '1') return { t: 'enabled' };
  const home = os.homedir();
  const stores: Array<[name: string, value: string | null, fallback: string]> = [
    [
      'UNLEASHD_BUDDIES_DB',
      resolved(env.UNLEASHD_BUDDIES_DB),
      path.join(home, '.buddies', 'buddies-v3.sqlite'),
    ],
    ['BUDDIES_HOME', resolved(env.BUDDIES_HOME), path.join(home, '.buddies')],
    [APP_DATA_DIR_ENV, resolved(env[APP_DATA_DIR_ENV]), path.join(home, '.agent-viewer')],
  ];
  const moved = stores.find(([, value, fallback]) => value !== null && value !== fallback);
  return moved
    ? { t: 'disabled', reason: `${moved[0]}=${moved[1]} is not the owner's default store` }
    : { t: 'enabled' };
}

/** Everything that can start an agent on the Buddies' behalf, behind one value. */
export interface BuddyExecution<Found, Adopted> {
  /** Journals a previous backend left (adopted at boot). */
  scan(): Found[];
  /** Start the scheduler; `adopted` are the runs whose turns this backend adopted. */
  start(adopted: readonly Adopted[]): Promise<void>;
  resume(): void;
  /** The boot log line. */
  readonly started: string;
}

// The thin dispatcher: the gate picks live execution or the inert one, once, at composition.
export function admitExecution<Found, Adopted>(
  gate: ExecutionGate,
  live: BuddyExecution<Found, Adopted>,
  log: Pick<Console, 'warn'> = console
): BuddyExecution<Found, Adopted> {
  switch (gate.t) {
    case 'enabled':
      return live;
    case 'disabled':
      log.warn(
        `[buddies] Execution disabled: ${gate.reason}. Set ${BUDDY_EXECUTION_ENV}=1 to run Buddies here.`
      );
      return {
        scan: () => [],
        start: async () => undefined,
        resume: () => undefined,
        started: 'Buddy runner not started (execution disabled)',
      };
  }
}
