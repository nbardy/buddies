export interface ShutdownPorts {
  activeSchedulerRuns(): number;
  pauseScheduler(): void;
  resumeScheduler(): void;
  stopScheduler(): void;
  flushState(): void | Promise<void>;
  exit(code?: number): void;
}

export interface ShutdownOptions {
  /** SIGINT/SIGTERM: how long in-memory work (mutations, queued sends) may take to drain. */
  forceExitGraceMs: number;
  /** Hard cap on the final state flush. A hung flush must never strand `exiting`. */
  flushGraceMs: number;
}

// No exit path stops a running provider turn: not a source reload, not SIGINT/SIGTERM, not the
// loss of the dev runner. Each turn runs from an on-disk journal and the next backend adopts it
// (turns/executions.ts, agent_notes/2026-09-30_execution-adoption-design.md). Before 2026-09-30
// a reload waited for every turn to finish (it starved for 20+ minutes under steady Buddy work)
// and SIGTERM stopped them all; an abrupt death orphaned every run anyway. Exits now wait only
// for work that lives solely in memory. Only an explicit Stop stops a turn.
const DRAIN_POLL_INTERVAL_MS = 500;

export type ShutdownState = 'starting' | 'idle' | 'reloading' | 'shutting_down' | 'exiting';

export interface ShutdownController {
  readonly state: ShutdownState;
  beginMutation(options?: { allowDuringStartup?: boolean }): (() => void) | null;
  completeStartup(): boolean;
  abortStartup(): void;
  handleReload(): void;
  handleStartupFailure(): void;
  handleSigint(): void;
  handleSigterm(): void;
  dispose(): void;
}

export function createShutdownController(
  options: ShutdownOptions,
  ports: ShutdownPorts
): ShutdownController {
  let drainInterval: NodeJS.Timeout | null = null;
  let forceExitTimeout: NodeJS.Timeout | null = null;
  let flushWatchdog: NodeJS.Timeout | null = null;
  let state: ShutdownState = 'starting';
  let reloadRequested = false;
  let startupPending = true;
  let activeMutations = 0;
  let schedulerPaused = false;
  let schedulerStopped = false;
  let exitPromise: Promise<void> | null = null;

  // Pattern: durable-intake (docs/patterns.md#durable-intake). A reload no longer waits for empty
  // queues: a queued owner message is a durable row (a Buddy `chat` run, or a records
  // `conversation_input`) and the next backend runs it once; a running turn is adopted. Until step 6
  // (2026-10-07) pending messages lived in memory, so every reload waited for them to drain.
  const activeWorkCount = () =>
    ports.activeSchedulerRuns() + activeMutations + (startupPending ? 1 : 0);
  const clearTimers = () => {
    if (drainInterval) clearInterval(drainInterval);
    if (forceExitTimeout) clearTimeout(forceExitTimeout);
    if (flushWatchdog) clearTimeout(flushWatchdog);
    drainInterval = null;
    forceExitTimeout = null;
    flushWatchdog = null;
  };
  const pauseScheduler = () => {
    if (schedulerPaused || schedulerStopped) return;
    schedulerPaused = true;
    ports.pauseScheduler();
  };
  const resumeScheduler = () => {
    if (!schedulerPaused || schedulerStopped) return;
    schedulerPaused = false;
    ports.resumeScheduler();
  };
  const stopScheduler = () => {
    if (schedulerStopped) return;
    schedulerStopped = true;
    ports.stopScheduler();
  };
  const exitOnce = (code = 0): Promise<void> => {
    if (exitPromise) return exitPromise;
    state = 'exiting';
    reloadRequested = false;
    clearTimers();
    let pendingFlush: void | Promise<void> = undefined;
    try {
      pendingFlush = ports.flushState();
    } catch (error: unknown) {
      console.error('Failed to flush state during shutdown:', error);
    }
    // `exiting` refuses every mutation, and clearTimers() above has just disarmed
    // the drain, so a flush that never settles strands the process forever with no
    // timer left to rescue it: the server stays up answering every request with
    // "Backend reload is draining active turns" (incident 2026-08-20). That is
    // reachable because flushState() awaits turnAttemptJournal.flush(), which
    // queues behind every in-flight journal write. Armed AFTER clearTimers so it
    // cannot be swept away by it, and cleared by dispose().
    flushWatchdog = setTimeout(() => {
      flushWatchdog = null;
      console.error(`State flush did not settle within ${options.flushGraceMs}ms; exiting anyway`);
      ports.exit(code);
    }, options.flushGraceMs);
    exitPromise = Promise.resolve(pendingFlush)
      .catch((error: unknown) => {
        console.error('Failed to flush state during shutdown:', error);
      })
      .then(() => {
        if (flushWatchdog) clearTimeout(flushWatchdog);
        flushWatchdog = null;
        ports.exit(code);
      });
    return exitPromise;
  };
  const forceShutdownDrain = (graceMs: number) => {
    // Running turns are adopted and queued messages are durable rows: nothing is lost here.
    console.warn(
      `Backend exiting after ${graceMs}ms grace (${activeWorkCount()} operation(s) still pending)`
    );
    stopScheduler();
    startupPending = false;
    activeMutations = 0;
    clearTimers();
    void exitOnce();
  };
  const waitForShutdownDrain = (graceMs: number) => {
    if (activeWorkCount() === 0) {
      void exitOnce();
      return;
    }
    drainInterval = setInterval(() => {
      if (activeWorkCount() === 0) void exitOnce();
    }, DRAIN_POLL_INTERVAL_MS);
    forceExitTimeout = setTimeout(() => forceShutdownDrain(graceMs), graceMs);
  };
  const enterReloadingAtIdleBoundary = () => {
    if (!reloadRequested || activeWorkCount() !== 0) return;
    // The scheduler is another producer, so pause it only at the candidate
    // boundary and recheck synchronously before committing to exit. Pausing at
    // reload request time made a reload that waited on a long provider turn also
    // stop unrelated scheduled work. If pausing exposes work, restore the exact
    // prior availability and keep seeking a later boundary.
    //
    // A reload never enters a read-only absorbing state while work is active.
    // This is the deliberately simpler ownership rule chosen in
    // agent_notes/2026-08-24_automation-execution-ownership-design.md: the old
    // server remains the fully usable owner until nothing in memory is pending.
    // Running provider turns do not count: the replacement adopts them.
    pauseScheduler();
    if (activeWorkCount() !== 0) {
      resumeScheduler();
      return;
    }
    reloadRequested = false;
    state = 'reloading';
    clearTimers();
    void exitOnce();
  };
  const completeStartup = () => {
    startupPending = false;
    if (state !== 'starting') return false;
    state = 'idle';
    enterReloadingAtIdleBoundary();
    return state === 'idle';
  };
  const abortStartup = () => {
    startupPending = false;
  };
  const beginMutation = (options?: { allowDuringStartup?: boolean }): (() => void) | null => {
    const startupCreation = state === 'starting' && options?.allowDuringStartup === true;
    if (state !== 'idle' && !startupCreation) return null;
    activeMutations += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeMutations = Math.max(0, activeMutations - 1);
      enterReloadingAtIdleBoundary();
    };
  };
  const handleReload = () => {
    if ((state !== 'starting' && state !== 'idle') || reloadRequested) return;
    reloadRequested = true;
    // Stay fully available while the current backend owns live streams. The
    // watcher already coalesces later source changes and starts one replacement
    // after exit. There is intentionally no reload deadline: a deadline either
    // kills admitted work or creates the permanent read-only wedge this state
    // machine exists to prevent.
    console.warn(
      `Backend reload queued: keeping current backend available for ${activeWorkCount()} active operation(s)`
    );
    drainInterval = setInterval(enterReloadingAtIdleBoundary, DRAIN_POLL_INTERVAL_MS);
    enterReloadingAtIdleBoundary();
  };
  const handleShutdown = (signal: 'SIGINT' | 'SIGTERM') => {
    if (state === 'exiting' || state === 'shutting_down') return;
    reloadRequested = false;
    stopScheduler();
    clearTimers();
    state = 'shutting_down';
    startupPending = false;
    console.log(
      `${signal} — shutting down; running turns continue and the next backend adopts them`
    );
    // waitForShutdownDrain exits immediately when nothing is outstanding, and owns
    // the single force-exit timer. Arming a second one here used to overwrite the
    // handle, leaking a timer that clearTimers()/dispose() could never reach.
    waitForShutdownDrain(options.forceExitGraceMs);
  };
  const handleSigint = () => handleShutdown('SIGINT');
  const handleSigterm = () => handleShutdown('SIGTERM');
  const handleStartupFailure = () => {
    if (state === 'exiting') return;
    reloadRequested = false;
    stopScheduler();
    startupPending = false;
    state = 'shutting_down';
    void exitOnce(1);
  };

  return {
    get state() {
      return state;
    },
    beginMutation,
    completeStartup,
    abortStartup,
    handleReload,
    handleStartupFailure,
    handleSigint,
    handleSigterm,
    dispose: clearTimers,
  };
}

export function registerShutdownHandlers(
  options: ShutdownOptions,
  ports: ShutdownPorts
): ShutdownController {
  const controller = createShutdownController(options, ports);
  process.on('SIGINT', controller.handleSigint);
  process.on('SIGTERM', controller.handleSigterm);
  const handleProcessMessage = (message: unknown) => {
    if (
      message &&
      typeof message === 'object' &&
      'type' in message &&
      message.type === 'unleashd:dev-reload'
    ) {
      controller.handleReload();
    }
  };
  process.on('message', handleProcessMessage);
  // A backend must not outlive the dev runner that spawned it: an orphan keeps
  // the port and serves whatever code it booted with. One started 01:31 on
  // 2026-09-23 outlived a supervisor replacement and served a stale post shape
  // for hours. Without an IPC channel (production) there is no parent to lose.
  process.on('disconnect', controller.handleSigterm);
  const disposeController = controller.dispose;
  return {
    get state() {
      return controller.state;
    },
    beginMutation: controller.beginMutation,
    completeStartup: controller.completeStartup,
    abortStartup: controller.abortStartup,
    handleSigint: controller.handleSigint,
    handleSigterm: controller.handleSigterm,
    handleReload: controller.handleReload,
    handleStartupFailure: controller.handleStartupFailure,
    dispose() {
      process.off('SIGINT', controller.handleSigint);
      process.off('SIGTERM', controller.handleSigterm);
      process.off('message', handleProcessMessage);
      process.off('disconnect', controller.handleSigterm);
      disposeController();
    },
  };
}
