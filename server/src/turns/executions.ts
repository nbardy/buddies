import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { type ExecutionProcess, executionProcess, killExecution } from '@nbardy/agent-cli';
import type { Provider } from '@unleashd/shared';
import {
  type Execution,
  type ExecutionEvent,
  type Phase,
  type ProcessAt,
  applyStep,
} from './execution-state';
import type { PolicyAdoption } from './policy';

/**
 * Every provider execution this server starts is journaled on disk (agent-cli journal.ts:
 * file-backed stdout/stderr, the wrapper's pid and exit status), under one root. The server adds
 * `owner.json`: who the execution belongs to, as data, and `phase.json`: where the execution is
 * (turns/execution-state.ts, written before each step's side effects). A replacement backend scans
 * the root at boot and decides each turn from its phase and process alone: it ADOPTS a turn by
 * following the same journal from byte 0 through the same code path the spawner used. Until 2026-09-30 provider output was piped to the backend, so
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

/** One journal found at boot, classified once (the κ of this boundary). */
export type FoundExecution =
  | {
      t: 'turn';
      dir: string;
      owner: TurnOwner;
      phase: Phase;
      process: Extract<ExecutionProcess, { t: ProcessAt }>;
    }
  /** The owner was written but the provider never spawned. */
  | { t: 'unstarted'; dir: string; owner: TurnOwner; process: ExecutionProcess }
  | { t: 'ephemeral'; dir: string; process: ExecutionProcess }
  | { t: 'unreadable'; dir: string; process: ExecutionProcess; error: string };

const OWNER_FILE = 'owner.json';
const PHASE_FILE = 'phase.json';

// Atomic (tmp + rename): a reader sees the old phase or the new one, never a torn file. Not
// fsynced: the crashes this survives are process deaths, whose writes the kernel already holds.
function writeAtomic(file: string, value: unknown): void {
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

function writePhase(dir: string, phase: Phase): void {
  writeAtomic(path.join(dir, PHASE_FILE), phase);
}

export type ExecutionJournals = ReturnType<typeof createExecutionJournals>;

export function createExecutionJournals(root: string) {
  if (!path.isAbsolute(root)) throw new Error('The executions root must be absolute');

  function create(name: string, owner: ExecutionOwner): string {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const dir = path.join(root, name);
    // Phase and owner exist before the provider does: a journal with a process always has both.
    fs.mkdirSync(dir, { mode: 0o700 });
    writePhase(dir, { t: 'running' });
    writeAtomic(path.join(dir, OWNER_FILE), owner);
    return dir;
  }

  function read(dir: string): FoundExecution {
    // The process is read from agent-cli's journal on every scan, never copied (one view of it).
    const process = executionProcess(dir);
    let owner: ExecutionOwner;
    let phase: Phase;
    try {
      owner = JSON.parse(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8')) as ExecutionOwner;
      phase = JSON.parse(fs.readFileSync(path.join(dir, PHASE_FILE), 'utf8')) as Phase;
    } catch (error) {
      return { t: 'unreadable', dir, process, error: String(error) };
    }
    if (owner.version !== 1)
      return { t: 'unreadable', dir, process, error: `owner version ${String(owner.version)}` };
    switch (owner.kind) {
      case 'turn':
        return process.t === 'unstarted'
          ? { t: 'unstarted', dir, owner, process }
          : { t: 'turn', dir, owner, phase, process };
      case 'ephemeral':
        return { t: 'ephemeral', dir, process };
    }
  }

  return {
    root,

    /** A turn's journal, named by its attempt, `running`; owner and phase are written before spawn. */
    forTurn(owner: Omit<TurnOwner, 'version' | 'kind'>): Execution {
      return {
        dir: create(owner.attemptId, { version: 1, kind: 'turn', ...owner }),
        phase: { t: 'running' },
      };
    },

    /** The one way a phase changes: persisted, then its effects handed back (execution-state.ts). */
    step(execution: Execution, event: ExecutionEvent) {
      return applyStep(execution, event, writePhase);
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
      // SIGKILL after the grace checks the pid is still our wrapper (review of P1, 2026-10-01).
      if (found.process.t === 'live') killExecution(found.process.pid, found.dir);
      fs.rmSync(found.dir, { recursive: true, force: true });
    },

    /** The turn settled: its journal has nothing left to tell anyone. */
    remove(dir: string): void {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
