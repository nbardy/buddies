import type {
  ExpeditionAttempt,
  ExpeditionAttemptCost,
  ExpeditionDone,
  ExpeditionDoneCheck,
  ExpeditionIntegration,
  ExpeditionQuestion,
  ExpeditionRun,
  ExpeditionValidation,
  ExpeditionWorktree,
} from '@unleashd/shared';

// Pure view helpers for the expedition badge and page (no React).

export const expeditionUrl = (id: string) => `/api/buddies/expeditions/${encodeURIComponent(id)}`;
export const expeditionHref = (id: string) => `/expeditions/${encodeURIComponent(id)}`;

export function runLabel(run: ExpeditionRun): string {
  switch (run.t) {
    case 'running':
      return 'running';
    case 'paused':
      return 'paused';
    case 'waiting_owner':
      return 'needs you';
    case 'finished':
      return `finished (${run.reason.replaceAll('_', ' ')})`;
  }
}

export function attemptState(a: ExpeditionAttempt): string {
  switch (a.phase.t) {
    case 'planned':
      return 'queued';
    case 'admitted':
      return 'starting';
    case 'dropped':
      return `not started: ${a.phase.reason}`;
    case 'posting':
    case 'posted':
      return 'running';
    case 'ended':
      return a.phase.outcome;
  }
}

/** An attempt's measured cost (design.md R6); null before it ended. Never an estimate. */
export function attemptCostLine(cost: ExpeditionAttemptCost): string | null {
  switch (cost.t) {
    case 'none':
      return null;
    case 'settling':
      return 'reading its run’s token usage…';
    case 'measured':
      return cost.label;
    case 'unmeasured':
      return `not measured (${cost.reason})`;
  }
}

/** The header's one integration line: the expedition branch, what it holds, the last refusal. */
export function integrationLine(i: ExpeditionIntegration): string {
  const queued = i.queued > 0 ? ` · ${i.queued} queued` : '';
  const line = `Integration: ${i.branch} @ ${i.head.slice(0, 10)} · ${i.integrated} integrated${queued}`;
  switch (i.lastRefusal.t) {
    case 'none':
      return line;
    case 'refused':
      return `${line} · last refusal: ${i.lastRefusal.label}`;
  }
}

/** The host validations of one attempt's claimed commit, oldest first. */
export const validationsOf = (all: ExpeditionValidation[], attemptId: string) =>
  all.filter((x) => x.subject.t === 'candidate' && x.subject.claimAttemptId === attemptId);

export function worktreeLine(tree: ExpeditionWorktree): string | null {
  switch (tree.t) {
    case 'none':
      return null;
    case 'tree':
      return `branch ${tree.branch}`;
  }
}

/** The Goal pane's "done when" lines: what the host runs, and what a blind panel judges. */
export function doneLines(done: ExpeditionDone): string[] {
  switch (done.t) {
    case 'owner':
      return ['The owner judges completion.'];
    case 'checks':
      return done.checks.map(doneCheckLine);
  }
}

function doneCheckLine(check: ExpeditionDoneCheck): string {
  switch (check.kind) {
    case 'command':
      return `$ ${check.argv.join(' ')} — run by the host, ${check.timeoutSeconds}s limit`;
    case 'judged':
      return `${check.text} — judged by a blind check panel`;
  }
}

export const QUESTION_GLYPH: Record<ExpeditionQuestion['status'], string> = {
  open: '○',
  verified: '✓',
  dead: '✗',
};

/** The panes beside the chat; the narrow layout also has the chat itself as a focus. */
export type Pane = 'workers' | 'tasks' | 'reflections' | 'charter';
export type Focus = Pane | 'chat';
export const FOCI: { focus: Focus; label: string }[] = [
  { focus: 'workers', label: 'Workers' },
  { focus: 'tasks', label: 'Tasks' },
  { focus: 'reflections', label: 'Reflections' },
  { focus: 'charter', label: 'Goal' },
  { focus: 'chat', label: 'Chat' },
];
