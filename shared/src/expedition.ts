// The expedition page's wire shape (GET /api/buddies/expeditions/:id). One type source: the
// server's projection (server/src/expeditions/view.ts) returns it; the client page reads it.

export type ExpeditionRun =
  | { t: 'running' }
  | { t: 'paused' }
  | { t: 'waiting_owner'; question: string }
  | {
      t: 'finished';
      reason: 'done' | 'attempts_spent' | 'deadline' | 'owner_stop';
      summary: string;
    };

export interface ExpeditionQuestion {
  id: string;
  title: string;
  detail: string;
  scope: 'in' | 'explore' | 'parked';
  status: 'open' | 'verified' | 'dead';
  /** File custody: repo-relative prefixes; work on overlapping paths runs one at a time. */
  paths: string[];
  attempts: string[];
}

export interface ExpeditionAttempt {
  id: string;
  kind: 'manager' | 'work' | 'check';
  label: string;
  seat: string;
  questionId: string | null;
  /** admitted: its worktree is being made; dropped: it never started (no worktree, see outcome). */
  phase: 'planned' | 'admitted' | 'dropped' | 'posting' | 'posted' | 'ended';
  live: boolean;
  /** The exact instructions the worker received; null until briefed. */
  brief: string | null;
  outcome: string | null;
  requestId: string | null;
}

export interface ExpeditionView {
  id: string;
  name: string;
  badge: string;
  run: ExpeditionRun;
  goal: string;
  done: string[];
  inScope: string[];
  outOfScope: string[];
  workspaceId: string;
  launchedAt: string;
  deadline: string;
  now: string;
  crew: { t: 'pending' } | { t: 'ready'; buddyId: string; chatChannelId: string };
  roster: { manager: string; work: string[]; check: string[] };
  counts: {
    attempts: number;
    maxAttempts: number;
    live: number;
    maxLive: number;
    queued: number;
    verified: number;
    exploreCap: number;
  };
  questions: ExpeditionQuestion[];
  attempts: ExpeditionAttempt[];
  panels: {
    id: string;
    questionId: string;
    claimAttemptId: string;
    goal: boolean;
    verdict: 'pending' | 'verified' | 'not_verified';
  }[];
  reflections: { at: string; text: string }[];
  lessons: string[];
}
