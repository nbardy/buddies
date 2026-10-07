import { type ChildProcess, spawn } from 'node:child_process';

// The ONE place that counts running turns and holds the sleep assertion. Never spawn caffeinate
// per turn. Fed by Conversation.publishRun, the single run-state transition point.
//
// Why: macOS sleeps (Maintenance Sleep) for longer than the 5-minute run lease, and on wake the
// claim gate ended live turns whose heartbeat could not renew while the machine was asleep
// (agent_notes/2026-10-07_live-turn-lease-loss.md).
// Keeping the Mac awake while a turn runs makes those sleeps rare; the lease fix is still what
// makes a turn SURVIVE one. Owner decision 2026-10-07 (keep awake only while a turn runs).

/** A held "do not idle-sleep" assertion; release is idempotent. */
export interface SleepAssertion {
  readonly pid: number | null;
  release(): void;
}

/** How a platform holds the assertion: one handler per platform kind. */
export type AssertionPort = (backendPid: number) => SleepAssertion;

/** darwin: `caffeinate -i -w <backend pid>`; `-w` ends it with the backend, so a crash cannot leak. */
export const caffeinateAssertion: AssertionPort = (backendPid) => {
  const child: ChildProcess = spawn('caffeinate', ['-i', '-w', String(backendPid)], {
    stdio: 'ignore',
  });
  // A missing binary is a logged no-op, not a crashed backend.
  child.on('error', (error) => console.warn(`[keep-awake] caffeinate failed: ${error.message}`));
  return { pid: child.pid ?? null, release: () => void child.kill() };
};

/** Every other platform: nothing to hold. */
export const noAssertion: AssertionPort = () => ({ pid: null, release: () => undefined });

export const platformAssertion = (platform: NodeJS.Platform): AssertionPort =>
  platform === 'darwin' ? caffeinateAssertion : noAssertion;

export class KeepAwake {
  private readonly running = new Set<string>();
  private held: SleepAssertion | null = null;

  constructor(
    private readonly port: AssertionPort,
    private readonly backendPid: number = process.pid
  ) {}

  /** The assertion's process id while held (tests, diagnostics). */
  get pid(): number | null {
    return this.held?.pid ?? null;
  }

  /** A conversation's turn is running (true) or not (false); idempotent per id. */
  setRunning(conversationId: string, running: boolean): void {
    if (running) this.running.add(conversationId);
    else this.running.delete(conversationId);
    if (this.running.size > 0 && this.held === null) this.held = this.port(this.backendPid);
    if (this.running.size === 0 && this.held !== null) {
      this.held.release();
      this.held = null;
    }
  }
}

if (process.platform !== 'darwin') {
  console.log(`[keep-awake] not darwin (${process.platform}): sleep assertion disabled`);
}

/** The backend's one keep-awake owner. */
export const keepAwake = new KeepAwake(platformAssertion(process.platform));
