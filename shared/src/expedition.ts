// The expedition page's wire shape (GET /api/buddies/expeditions/:id). One type source: the
// server's projection (server/src/expeditions/view.ts) returns it; the client page reads it.

export type ExpeditionRun =
  | { t: 'running' }
  | { t: 'paused' }
  | { t: 'waiting_owner'; question: string }
  | {
      t: 'finished';
      reason: 'done' | 'attempts_spent' | 'deadline' | 'owner_stop' | 'setup_failed';
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

/** A done check as chartered (design.md R2): a command the host runs, or a judged statement. */
export type ExpeditionDoneCheck =
  | { kind: 'command'; argv: string[]; timeoutSeconds: number }
  | { kind: 'judged'; text: string };

export type ExpeditionDone = { t: 'checks'; checks: ExpeditionDoneCheck[] } | { t: 'owner' };

/** One host validation: the command checks run on a claim's commit or on the branch head. */
export interface ExpeditionValidation {
  id: string;
  /** e.g. `candidate 1a2b3c4d5e of w12` or `the head 1a2b3c4d5e`, with its verdict. */
  label: string;
  verdict: 'running' | 'passed' | 'failed';
  checks: { checkIndex: number; outcome: string }[];
}

export interface ExpeditionView {
  id: string;
  name: string;
  badge: string;
  run: ExpeditionRun;
  goal: string;
  done: ExpeditionDone;
  validations: ExpeditionValidation[];
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
