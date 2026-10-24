import type { OompaRuntimeSnapshot, SubAgent } from '@unleashd/shared';
import { labelled } from '../observability/event-loop-stall';
import type { SubAgentHost } from '../turns/subagents';

/**
 * Swarm (oompa) observation, quarantined from the turn core (DESIGN C.5).
 *
 * ONE async poller per working directory, shared by every turn running there.
 * Until 2026-09-25 each running conversation owned a 2 s setInterval that read
 * `runs/` with readdirSync/readFileSync on the event loop (03 §5.2), so N
 * running chats in one repo meant N blocking scans per tick. The poller exists
 * only while some turn watches the folder, and a read never overlaps another.
 * Guard: `turns in one folder share one swarm poller` (swarm-observer.test.ts).
 */

export type SwarmSnapshotReader = (projectRoot: string) => Promise<OompaRuntimeSnapshot>;
type SwarmListener = (snapshot: OompaRuntimeSnapshot) => void;

export interface SwarmObserverTiming {
  /** Background poll while a turn runs (catches launches after the last event). */
  readonly intervalMs: number;
  /** Minimum gap between activity-driven reads. */
  readonly throttleMs: number;
}

// Pattern: wake-on-write (docs/patterns.md#wake-on-write)
export class SwarmObservers {
  private readonly folders = new Map<string, FolderObserver>();

  constructor(
    private readonly read: SwarmSnapshotReader,
    private readonly timing: SwarmObserverTiming
  ) {}

  /** Start delivering snapshots of `folder`; the first one is read right away. Returns the unsubscribe. */
  watch(folder: string, listener: SwarmListener): () => void {
    let observer = this.folders.get(folder);
    if (!observer) {
      observer = new FolderObserver(folder, this.read, this.timing, () => {
        this.folders.delete(folder);
      });
      this.folders.set(folder, observer);
    }
    return observer.add(listener);
  }

  /** Turn activity in `folder`: read again unless one ran within the throttle window. */
  poke(folder: string): void {
    this.folders.get(folder)?.refresh('throttled');
  }
}

class FolderObserver {
  private readonly listeners = new Set<SwarmListener>();
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private rereadAfterFlight = false;
  private lastReadAt = 0;

  constructor(
    private readonly folder: string,
    private readonly read: SwarmSnapshotReader,
    private readonly timing: SwarmObserverTiming,
    private readonly onEmpty: () => void
  ) {}

  add(listener: SwarmListener): () => void {
    this.listeners.add(listener);
    if (!this.timer) {
      this.timer = setInterval(
        labelled('timer swarm-observer', () => this.refresh('now')),
        this.timing.intervalMs
      );
      this.timer.unref?.();
    }
    // A new watcher needs a snapshot taken after it subscribed (its baseline).
    this.refresh('now');
    return () => this.remove(listener);
  }

  refresh(mode: 'now' | 'throttled'): void {
    const now = Date.now();
    if (mode === 'throttled' && now - this.lastReadAt < this.timing.throttleMs) return;
    if (this.inFlight) {
      if (mode === 'now') this.rereadAfterFlight = true;
      return;
    }
    this.lastReadAt = now;
    this.inFlight = true;
    Promise.resolve()
      .then(() => this.read(this.folder))
      .then((snapshot) => {
        for (const listener of [...this.listeners]) listener(snapshot);
      })
      .catch((error: unknown) => {
        console.warn(`[swarm] Could not read runs in ${this.folder}:`, error);
      })
      .finally(() => {
        this.inFlight = false;
        if (!this.rereadAfterFlight || this.listeners.size === 0) return;
        this.rereadAfterFlight = false;
        this.refresh('now');
      });
  }

  private remove(listener: SwarmListener): void {
    this.listeners.delete(listener);
    if (this.listeners.size > 0) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.onEmpty();
  }
}

/**
 * One turn's view of the swarm runs in its folder, shown as sub-agent rows.
 * The first snapshot is the baseline: a run that already existed when the turn
 * started is not this turn's launch. A newer run that is live starts a row; the
 * previous run's row (and the current one, once it stops) completes.
 */
export function watchSwarmRuns(
  observers: SwarmObservers,
  folder: string,
  host: SubAgentHost
): () => void {
  let baseline: { runId: string | null } | null = null;
  return observers.watch(folder, (snapshot) => {
    const run = snapshot.available ? snapshot.run : null;
    if (baseline === null) {
      baseline = { runId: run?.runId ?? null };
      return;
    }
    if (!run) return;
    const previousRunId = baseline.runId;
    if (previousRunId && previousRunId !== run.runId) completeSwarmAgent(host, previousRunId);
    if (run.runId !== previousRunId) {
      baseline.runId = run.runId;
      if (run.isRunning) startSwarmAgent(host, run);
      return;
    }
    if (!run.isRunning) completeSwarmAgent(host, run.runId);
  });
}

function startSwarmAgent(host: SubAgentHost, run: NonNullable<OompaRuntimeSnapshot['run']>): void {
  const agentId = `swarm-${run.runId}`;
  if (host.agents.some((agent) => agent.id === agentId)) return;
  const swarmId = run.swarmId ?? run.runId;
  console.log(`[${host.conversationId}] Detected new running swarm: ${swarmId}`);
  const subAgent: SubAgent = {
    id: agentId,
    description: `Swarm Run: ${swarmId} (${run.totalWorkers} workers)`,
    status: 'running',
    toolUses: 0,
    tokens: 0,
    currentAction: 'Running swarm...',
    startedAt: new Date(),
  };
  host.agents.push(subAgent);
  host.changed(subAgent);
}

function completeSwarmAgent(host: SubAgentHost, runId: string): void {
  const agentId = `swarm-${runId}`;
  const agent = host.agents.find((candidate) => candidate.id === agentId);
  if (!agent || agent.status !== 'running') return;
  const completedAt = new Date();
  agent.status = 'completed';
  agent.currentAction = 'Done';
  agent.completedAt = completedAt;
  host.changed(agent);
}
