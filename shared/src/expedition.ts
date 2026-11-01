// The expedition modal's wire shapes: a live expedition (GET /api/buddies/expeditions/:id) and a
// draft (GET /api/buddies/expeditions/drafts/:draftId). One type source: the server's projections
// (server/src/expeditions/view.ts) return them; the client modal and cards read them.

export type ExpeditionRun =
  | { t: 'running' }
  | { t: 'paused' }
  | { t: 'waiting_owner'; question: string }
  | {
      t: 'finished';
      reason:
        | 'done'
        | 'attempts_spent'
        | 'decisions_spent'
        | 'deadline'
        | 'owner_stop'
        | 'setup_failed';
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

/** An attempt's measured cost (design.md R6): provider-counted tokens, never an estimate.
 * `none`: it has not ended (or never ran); `settling`: ended, its run's usage not read yet. */
export type ExpeditionAttemptCost =
  | { t: 'none' }
  | { t: 'settling' }
  | { t: 'measured'; label: string }
  | { t: 'unmeasured'; reason: string };

/** Where an attempt is. admitted: its worktree is being made; dropped: it never started (no
 * worktree), with why; ended: its one-line result. */
export type ExpeditionAttemptPhase =
  | { t: 'planned' }
  | { t: 'admitted' }
  | { t: 'dropped'; reason: string }
  | { t: 'posting' }
  | { t: 'posted' }
  | { t: 'ended'; outcome: string };

export interface ExpeditionAttempt {
  id: string;
  kind: 'manager' | 'work' | 'check';
  label: string;
  seat: string;
  questionId: string | null;
  phase: ExpeditionAttemptPhase;
  live: boolean;
  /** The exact instructions the worker received; null until briefed. */
  brief: string | null;
  requestId: string | null;
  worktree: ExpeditionWorktree;
  cost: ExpeditionAttemptCost;
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

/** The owner's charter as shown in the Charter tab: the same for a draft and a live expedition. */
export interface ExpeditionCharterView {
  name: string;
  /** Markdown, as the Buddy wrote it. */
  goal: string;
  done: ExpeditionDone;
  inScope: string[];
  outOfScope: string[];
  /** Seat labels, e.g. `codex/gpt-5/high`. */
  roster: { manager: string; work: string[]; check: string[] };
  limits: { maxAttempts: number; maxLive: number; hours: number; exploreShare: number };
}

export interface ExpeditionView {
  id: string;
  badge: string;
  run: ExpeditionRun;
  charter: ExpeditionCharterView;
  validations: ExpeditionValidation[];
  integration: ExpeditionIntegration;
  /** Measured spend: `short` for the badge, `line` for the header (sums, unmeasured, settling). */
  cost: { short: string; line: string };
  workspaceId: string;
  launchedAt: string;
  deadline: string;
  now: string;
  crew: { t: 'pending' } | { t: 'ready'; buddyId: string; chatChannelId: string };
  counts: {
    /** Work and check attempts: what the owner's budget counts (design.md R9). */
    attempts: number;
    maxAttempts: number;
    /** Manager decisions, bounded apart from the budget. */
    decisions: number;
    maxDecisions: number;
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
  /** Each verified claim and why: a panel's majority, or the host's passed command checks plus
   * its merge into the expedition branch (design.md R9). */
  verifications: (
    | { t: 'panel'; questionId: string; claimAttemptId: string; panelId: string }
    | {
        t: 'host';
        questionId: string;
        claimAttemptId: string;
        validationId: string;
        mergeSha: string;
      }
  )[];
  reflections: { at: string; text: string }[];
  lessons: string[];
}

// ---------- Drafts (design.md R10) ----------

/** Where a draft stands: launchable, launched (once), or replaced by a newer draft of the same
 * name in the same conversation. */
export type ExpeditionDraftState =
  | { t: 'open' }
  | { t: 'launched'; expeditionId: string }
  | { t: 'superseded'; by: string };

export interface ExpeditionDraftView {
  id: string;
  workspaceId: string;
  createdAt: string;
  state: ExpeditionDraftState;
  charter: ExpeditionCharterView;
  /** What refuses its launch, re-checked on every read of an open draft (empty: launchable). */
  issues: string[];
  /** Non-blocking suggestions, the defaults the charter took, and owner model words resolved. */
  advice: string[];
  defaulted: string[];
  resolved: string[];
}

/** Crew Buddies (one per expedition): reached through badges and the modal, never the roster. */
export interface ExpeditionCrews {
  buddyIds: string[];
}
/** One row of the expedition list (GET /api/buddies/expeditions), newest launch first: what the
 * sidebar and the index page show without fetching every full view. */
export type ExpeditionSummary = Pick<
  ExpeditionView,
  'id' | 'run' | 'workspaceId' | 'launchedAt' | 'counts' | 'cost'
> & { name: ExpeditionCharterView['name'] };
