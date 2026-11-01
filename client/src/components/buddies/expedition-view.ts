import type {
  ExpeditionAttempt,
  ExpeditionAttemptCost,
  ExpeditionCharterView,
  ExpeditionDone,
  ExpeditionDoneCheck,
  ExpeditionDraftView,
  ExpeditionQuestion,
  ExpeditionRun,
  ExpeditionStage,
  ExpeditionSummary,
  ExpeditionValidation,
  ExpeditionWorktree,
} from '@unleashd/shared';

// Pure view helpers for the expedition badge, draft card and modal (no React).

export const expeditionUrl = (id: string) => `/api/buddies/expeditions/${encodeURIComponent(id)}`;
export const expeditionHref = (id: string) => `/expeditions/${encodeURIComponent(id)}`;
/** A draft is read only from the workspace it was drafted in (server expeditions/routes.ts). */
export const draftUrl = (draftId: string, workspaceId: string) =>
  `/api/buddies/expeditions/drafts/${encodeURIComponent(draftId)}?workspaceId=${encodeURIComponent(workspaceId)}`;
/** Crew Buddies: kept off the Buddies roster (atoms/buddy-visibility.ts). */
export const EXPEDITION_CREWS_URL = '/api/buddies/expeditions/crews';

/** The colour family of a pill, dot or chip (Expedition.css `.expedition-tone-*`). */
export type Tone = 'ok' | 'warn' | 'info' | 'bad' | 'muted';

export function runTone(run: ExpeditionRun): Tone {
  switch (run.t) {
    case 'running':
      return 'ok';
    case 'waiting_owner':
      return 'warn';
    case 'paused':
      return 'muted';
    case 'finished':
      return 'info';
  }
}

/** A worker's dot: queued, live, never started, or ended. */
export function attemptTone(a: ExpeditionAttempt): Tone {
  switch (a.phase.t) {
    case 'planned':
    case 'admitted':
      return 'muted';
    case 'posting':
    case 'posted':
      return 'ok';
    case 'dropped':
      return 'bad';
    case 'ended':
      return 'info';
  }
}

export const STAGE_TONE: Record<ExpeditionStage, Tone> = {
  planned: 'muted',
  waiting: 'muted',
  implementing: 'info',
  claimed: 'info',
  checked: 'warn',
  validated: 'warn',
  integrated: 'ok',
  dead: 'bad',
};

/** The card's budget line, e.g. `6 attempts · 3 at once · 12 h`. */
export const budgetLine = (limits: ExpeditionCharterView['limits']) =>
  `${limits.maxAttempts} attempts · ${limits.maxLive} at once · ${limits.hours} h`;

/** `2h 05m` / `14m`: a duration between two instants, for the header. */
export function durationLabel(fromIso: string, toIso: string): string {
  const minutes = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`;
}

/** The goal's first prose line as plain text, for the draft card (headings are titles, skipped;
 * the same rule as the server's goalSummary in expeditions/news.ts). */
export const goalLine = (goal: string) =>
  goal
    .split('\n')
    .filter((line) => !/^\s*#{1,6}\s/.test(line))
    .map((line) => line.replace(/^\s*(>\s*|[-*+]\s+|\d+[.)]\s+)/, '').trim())
    .find(Boolean) ?? '';
/** Every expedition, newest launch first (server expeditions/routes.ts). Under `/api/buddies`, so
 * `buddies_changed` refreshes it like the page. */
export const EXPEDITIONS_URL = '/api/buddies/expeditions';
export const EXPEDITIONS_HREF = '/expeditions';
/** How many of the newest expeditions the sidebar lists under its header. */
export const SIDEBAR_RECENT_EXPEDITIONS = 5;

/** The sidebar dot (ConversationRow.css statuses): green while it runs, amber while it waits on
 * the owner, grey once paused or finished. */
export function runDot(run: ExpeditionRun): 'running' | 'queued' | 'idle' {
  switch (run.t) {
    case 'running':
      return 'running';
    case 'waiting_owner':
      return 'queued';
    case 'paused':
    case 'finished':
      return 'idle';
  }
}

/** The list's one progress line (the header's counts, shorter). */
export const summaryLine = (e: ExpeditionSummary) =>
  `${e.counts.live} live · ${e.counts.verified} verified · ${e.counts.attempts}/${e.counts.maxAttempts} attempts · ${e.cost.short}`;

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

/** The modal's tabs. The dialog shows the chat as its own column; the sheet makes it a tab. */
export type Pane = 'workers' | 'tasks' | 'reflections' | 'charter';
export type Focus = Pane | 'chat';
export const FOCI: { focus: Focus; label: string }[] = [
  { focus: 'workers', label: 'Workers' },
  { focus: 'tasks', label: 'Tasks' },
  { focus: 'reflections', label: 'Reflections' },
  { focus: 'charter', label: 'Charter' },
  { focus: 'chat', label: 'Chat' },
];

/** What a draft offers right now: one variant per button the card and modal footer show. */
export type DraftAction =
  | { t: 'launch' }
  | { t: 'blocked'; reason: string }
  | { t: 'launched'; expeditionId: string };

export function draftAction(d: ExpeditionDraftView): DraftAction {
  switch (d.state.t) {
    case 'launched':
      return { t: 'launched', expeditionId: d.state.expeditionId };
    case 'superseded':
      return { t: 'blocked', reason: 'Replaced by a newer draft in this chat' };
    case 'open':
      return d.issues.length === 0
        ? { t: 'launch' }
        : {
            t: 'blocked',
            reason: `${d.issues.length} ${d.issues.length === 1 ? 'issue' : 'issues'} to fix first (Info)`,
          };
  }
}
