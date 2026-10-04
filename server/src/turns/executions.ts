import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { type ExecutionState, executionState, isOwnWrapper, signalGroup } from '@nbardy/agent-cli';
import type { Provider } from '@unleashd/shared';
import type { PolicyAdoption } from './policy';
import type { TurnTimeout } from './watchdog';

/**
 * Every provider execution this server starts is journaled on disk (agent-cli journal.ts:
 * file-backed stdout/stderr, the wrapper's pid and exit status), under one root. The server adds
 * `owner.json`: who the execution belongs to, as data. A replacement backend scans the root at
 * boot and ADOPTS each running turn: it follows the same journal from byte 0 through the same
 * code path the spawner used. Until 2026-09-30 provider output was piped to the backend, so
 * every backend death killed every turn and orphaned its run (14 and 10 runs that day).
 * Design and history: agent_notes/2026-09-30_execution-adoption-design.md.
 */

/** A conversation turn: everything its conversation needs to take it back. */
export interface TurnOwner {
  readonly version: 1;
  readonly kind: 'turn';
  readonly conversationId: string;
  readonly attemptId: string;
  readonly provider: Provider;
  /** The user row the turn appended, exactly, so the adopted overlay pairs with the native turn. */
  readonly userMessage: { text: string; timestamp: string };
  readonly startedAt: string;
  readonly policy: PolicyAdoption;
}

/** A background CLI run with no conversation (reply gate, memory review, palette): never adopted. */
export interface EphemeralOwner {
  readonly version: 1;
  readonly kind: 'ephemeral';
  readonly label: string;
}

// Pattern: sum-types (docs/patterns.md#sum-types)
export type ExecutionOwner = TurnOwner | EphemeralOwner;

/**
 * Why a running execution is being ended. Written into its journal BEFORE the process is signalled
 * (`markStopping`), so the decision outlives the backend that made it. Until 2026-10-01 Stop and
 * timeouts lived only in memory: a backend SIGKILLed inside the 3 s SIGTERM→SIGKILL grace, while the
 * CLI still ran, left a journal the next backend adopted as a LIVE turn. It re-registered the
 * turn's grant and nothing stopped the turn again (release blocker 2a; guard:
 * adoption-stop.test.ts). `reset` kills a turn for a fresh session: nothing settles it.
 */
// Pattern: detached-execution (docs/patterns.md#detached-execution)
export type StopIntent =
  | { readonly t: 'stop'; readonly cause: 'user_stop' | 'server_restart' }
  | ({ readonly t: 'timeout' } & TurnTimeout)
  | { readonly t: 'reset' };

/** A stop an adopting backend finishes (a reset is discarded instead: nothing settles it). */
export type AdoptedStop = Exclude<StopIntent, { t: 'reset' }>;

/** What the journal says about the execution's future. No intent on disk: it may run on. */
export type ExecutionIntent = { readonly t: 'continue' } | StopIntent;

/** One journal found at boot, classified once (the κ of this boundary). */
export type FoundExecution =
  | { t: 'turn'; dir: string; owner: TurnOwner; state: ExecutionState; intent: ExecutionIntent }
  | { t: 'ephemeral'; dir: string; state: ExecutionState }
  | { t: 'unreadable'; dir: string; state: ExecutionState; error: string };

const OWNER_FILE = 'owner.json';
const INTENT_FILE = 'intent.json';

function writeAtomic(file: string, value: unknown): void {
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

function readIntent(dir: string): ExecutionIntent {
  let text: string;
  try {
    text = fs.readFileSync(path.join(dir, INTENT_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { t: 'continue' };
    throw error;
  }
  return JSON.parse(text) as StopIntent;
}

export type ExecutionJournals = ReturnType<typeof createExecutionJournals>;

export function createExecutionJournals(root: string) {
  if (!path.isAbsolute(root)) throw new Error('The executions root must be absolute');

  function create(name: string, owner: ExecutionOwner): string {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const dir = path.join(root, name);
    // The owner exists before the provider does: a journal with a process always names its owner.
    fs.mkdirSync(dir, { mode: 0o700 });
    writeAtomic(path.join(dir, OWNER_FILE), owner);
    return dir;
  }

  function read(dir: string): FoundExecution {
    const state = executionState(dir);
    let owner: ExecutionOwner;
    let intent: ExecutionIntent;
    try {
      owner = JSON.parse(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8')) as ExecutionOwner;
      intent = readIntent(dir);
    } catch (error) {
      return { t: 'unreadable', dir, state, error: String(error) };
    }
    if (owner.version !== 1)
      return { t: 'unreadable', dir, state, error: `owner version ${String(owner.version)}` };
    switch (owner.kind) {
      case 'turn':
        return { t: 'turn', dir, owner, state, intent };
      case 'ephemeral':
        return { t: 'ephemeral', dir, state };
    }
  }

  return {
    root,

    /** A turn's journal, named by its attempt; the owner is written before spawn. */
    forTurn(owner: Omit<TurnOwner, 'version' | 'kind'>): string {
      return create(owner.attemptId, { version: 1, kind: 'turn', ...owner });
    },

    /**
     * Record why this execution is ending, BEFORE it is signalled: the next backend re-issues the
     * stop instead of adopting a live writer (StopIntent). A failed write is loud and never blocks
     * the stop itself: the process is still signalled, only crash-durability is lost.
     */
    markStopping(dir: string, intent: StopIntent): void {
      try {
        writeAtomic(path.join(dir, INTENT_FILE), intent);
      } catch (error) {
        console.error(`[executions] could not record the ${intent.t} intent in ${dir}:`, error);
      }
    },

    /** A journal the next backend kills rather than adopts. */
    ephemeral(label: string): string {
      return create(`ephemeral-${crypto.randomUUID()}`, { version: 1, kind: 'ephemeral', label });
    },

    /** Every journal under the root, classified. Missing root = none. */
    scan(): FoundExecution[] {
      let names: string[];
      try {
        names = fs.readdirSync(root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
      return names.map((name) => read(path.join(root, name)));
    },

    /** Kill a journal's process group (if it runs) and remove it: nothing untracked survives. */
    discard(found: FoundExecution): void {
      if (found.state.kind === 'running') {
        signalGroup(found.state.pid, 'SIGTERM');
        const pid = found.state.pid;
        const dir = found.dir;
        // 3 s later the pid may be reused (review of P1, 2026-10-01): kill only our wrapper.
        setTimeout(() => {
          if (isOwnWrapper(pid, dir)) signalGroup(pid, 'SIGKILL');
        }, 3000).unref();
      }
      fs.rmSync(found.dir, { recursive: true, force: true });
    },

    /** The turn settled: its journal has nothing left to tell anyone. */
    remove(dir: string): void {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
