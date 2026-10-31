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

/** Where a question stands, derived from the ledger (design.md R5): its furthest stage.
 * `waiting`: its work is queued until the questions in `after` are verified (held, not failed). */
export type ExpeditionStage =
  | 'planned'
  | 'waiting'
  | 'implementing'
  | 'claimed'
  | 'checked'
  | 'validated'
  | 'integrated'
  | 'dead';

export interface ExpeditionQuestion {
  id: string;
  title: string;
  detail: string;
  scope: 'in' | 'explore' | 'parked';
  status: 'open' | 'verified' | 'dead';
  stage: ExpeditionStage;
  /** File custody: repo-relative prefixes; work on overlapping paths runs one at a time. */
  paths: string[];
  /** Question ids this question's work waits for (each must be closed verified). */
  after: string[];
  attempts: string[];
}

/** A worker attempt's own git worktree (design.md R1); none for a manager or before admission. */
export type ExpeditionWorktree = { t: 'none' } | { t: 'tree'; branch: string; path: string };

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
  worktree: ExpeditionWorktree;
}

/** A done check as chartered (design.md R2): a command the host runs, or a judged statement. */
export type ExpeditionDoneCheck =
  | { kind: 'command'; argv: string[]; timeoutSeconds: number }
  | { kind: 'judged'; text: string };

export type ExpeditionDone = { t: 'checks'; checks: ExpeditionDoneCheck[] } | { t: 'owner' };

/** One host validation: the command checks run on a claim's commit or on the branch head. */
export interface ExpeditionValidation {
  id: string;
  /** What it ran on: a claim's candidate commit (shown with that attempt) or the branch head. */
  subject: { t: 'candidate'; claimAttemptId: string } | { t: 'head' };
  /** e.g. `candidate 1a2b3c4d5e of w12` or `the head 1a2b3c4d5e`, with its verdict. */
  label: string;
  verdict: 'running' | 'passed' | 'failed';
  /** One per recorded command check; `outcome` is `passed` or names the exit code / error. */
  checks: { checkIndex: number; passed: boolean; outcome: string }[];
}

/** The expedition's own branch (design.md R3): what was merged into it, and the last refusal. */
export interface ExpeditionIntegration {
  branch: string;
  head: string;
  integrated: number;
  queued: number;
  lastRefusal: { t: 'none' } | { t: 'refused'; label: string };
}

export interface ExpeditionView {
  id: string;
  name: string;
  badge: string;
  run: ExpeditionRun;
  goal: string;
  done: ExpeditionDone;
  validations: ExpeditionValidation[];
  integration: ExpeditionIntegration;
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
