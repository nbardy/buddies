/**
 * What a RUNNING turn's process is doing: a sub-state of the persisted `running` phase
 * (execution-state.ts), never a phase of its own.
 *
 * task_01a11aa8 (owner, 2026-10-08): Game Designer's model ended its turn at 07:09:56 after
 * launching a background Workflow. `claude -p` then stayed alive 29.5 min with no tool call at
 * all, waiting on that Workflow, while the channel said "replying…" and queued the owner's 07:14
 * and 07:20 posts behind it. Tool-boundary steering cannot reach a model that makes no tool calls.
 * Evidence: agent_notes/2026-10-08_game-designer-art-lead-trace-findings.md.
 *
 * - `working`: the model is generating or a tool is running. Owner posts steer it at tool
 *   boundaries (buddies/mcp.ts `steerNativeTool`).
 * - `background`: the model's turn ended, and the harness process is alive only for background
 *   jobs it launched. Owner posts go into that live process at once (buddies/mcp.ts
 *   `holdStoppedTurn`), and the jobs keep running. The status line says so, never "replying".
 *
 * Why in memory and not on disk: the state lives exactly as long as one held Stop-hook request
 * (buddies/harness-steering.ts). A backend exit drops that request, the harness's hook fails
 * open, and claude waits on its jobs as before, so there is nothing for a new backend to adopt.
 * The provider-progress watchdog (watchdog.ts, fee9b12) is unchanged here: a silent background
 * turn still ends with `provider_idle_timeout`.
 */
export type TurnActivity =
  | { readonly t: 'working' }
  | {
      readonly t: 'background';
      readonly since: string;
      /** The harness's in-flight background task ids, as its Stop hook reported them. */
      readonly tasks: readonly string[];
    };

/** The thread a background turn is answering, for the status line. */
export interface BackgroundThread {
  readonly buddyId: string;
  readonly rootId: string;
}

interface Hold {
  readonly thread: BackgroundThread;
  readonly activity: Extract<TurnActivity, { t: 'background' }>;
  readonly settle: (drained: boolean) => void;
}

// Pattern: wake-on-write (docs/patterns.md#wake-on-write)
/**
 * One per backend: the turn folds (TurnRunner) write which background tasks finished, and the
 * Buddy hook route holds a stopped turn until its jobs finish. A task id is the harness's own,
 * the same in its stream (`task.finished`) and in its Stop hook input (probed on claude 2.1.294).
 */
export class BackgroundWork {
  // Per live turn: every task the stream has reported finished.
  private readonly finished = new Map<string, Set<string>>();
  private readonly holds = new Map<string, Hold>();

  /** A spawned or adopted turn begins: its task ids start fresh. */
  turnStarted(conversationId: string): void {
    this.finished.set(conversationId, new Set());
  }

  taskFinished(conversationId: string, taskId: string): void {
    const finished = this.finished.get(conversationId) ?? new Set<string>();
    finished.add(taskId);
    this.finished.set(conversationId, finished);
    const hold = this.holds.get(conversationId);
    if (hold?.activity.tasks.every((id) => finished.has(id))) hold.settle(true);
  }

  /** The turn's process ended and its stream drained. */
  turnEnded(conversationId: string): void {
    this.finished.delete(conversationId);
    this.holds.get(conversationId)?.settle(true);
  }

  /** What the seat answering `thread` is doing, for the status line. */
  activityOf(thread: BackgroundThread): TurnActivity {
    for (const hold of this.holds.values())
      if (hold.thread.buddyId === thread.buddyId && hold.thread.rootId === thread.rootId)
        return hold.activity;
    return { t: 'working' };
  }

  /**
   * The model ended its turn while `tasks` run. Resolves `true` once all of them have finished
   * or the turn ended, `false` if `released` aborts first (an owner post, or the hook request
   * closed). The caller owns what happens next; this owns only the state and its lifetime.
   */
  hold(
    conversationId: string,
    thread: BackgroundThread,
    tasks: readonly string[],
    released: AbortSignal
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const settle = (drained: boolean) => {
        if (this.holds.get(conversationId) !== hold) return;
        this.holds.delete(conversationId);
        released.removeEventListener('abort', onRelease);
        resolve(drained);
      };
      const onRelease = () => settle(false);
      const hold: Hold = {
        thread,
        activity: { t: 'background', since: new Date().toISOString(), tasks },
        settle,
      };
      this.holds.get(conversationId)?.settle(false);
      this.holds.set(conversationId, hold);
      released.addEventListener('abort', onRelease);
      const finished = this.finished.get(conversationId) ?? new Set<string>();
      if (released.aborted) settle(false);
      else if (tasks.every((id) => finished.has(id))) settle(true);
    });
  }
}
