import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { type ExecutionState, executionState, signalGroup } from '@nbardy/agent-cli';
import type { Provider } from '@unleashd/shared';
import type { PolicyAdoption } from './policy';

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

/** One journal found at boot, classified once (the κ of this boundary). */
export type FoundExecution =
  | { t: 'turn'; dir: string; owner: TurnOwner; state: ExecutionState }
  | { t: 'ephemeral'; dir: string; state: ExecutionState }
  | { t: 'unreadable'; dir: string; state: ExecutionState; error: string };

const OWNER_FILE = 'owner.json';

export type ExecutionJournals = ReturnType<typeof createExecutionJournals>;

export function createExecutionJournals(root: string) {
  if (!path.isAbsolute(root)) throw new Error('The executions root must be absolute');

  function create(name: string, owner: ExecutionOwner): string {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const dir = path.join(root, name);
    // The owner exists before the provider does: a journal with a process always names its owner.
    fs.mkdirSync(dir, { mode: 0o700 });
    const file = path.join(dir, OWNER_FILE);
    fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
    return dir;
  }

  function read(dir: string): FoundExecution {
    const state = executionState(dir);
    let owner: ExecutionOwner;
    try {
      owner = JSON.parse(fs.readFileSync(path.join(dir, OWNER_FILE), 'utf8')) as ExecutionOwner;
    } catch (error) {
      return { t: 'unreadable', dir, state, error: String(error) };
    }
    if (owner.version !== 1)
      return { t: 'unreadable', dir, state, error: `owner version ${String(owner.version)}` };
    switch (owner.kind) {
      case 'turn':
        return { t: 'turn', dir, owner, state };
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
        setTimeout(() => signalGroup(pid, 'SIGKILL'), 3000).unref();
      }
      fs.rmSync(found.dir, { recursive: true, force: true });
    },

    /** The turn settled: its journal has nothing left to tell anyone. */
    remove(dir: string): void {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
