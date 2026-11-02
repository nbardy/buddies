import {
  type ExpeditionAttempt,
  type ExpeditionAttemptCost,
  type ExpeditionCharterView,
  type ExpeditionDefault,
  type ExpeditionDraftState,
  type ExpeditionDraftView,
  type ExpeditionQuestion,
  type ExpeditionRetiredView,
  type ExpeditionRun,
  type ExpeditionStage,
  type ExpeditionSummary,
  type ExpeditionValidation,
  type ExpeditionView,
  expeditionRunLabel,
} from '@unleashd/shared';

// Pure view helpers for the expedition badge, draft card, lists and modal (no React).

export const expeditionUrl = (id: string) => `/api/buddies/expeditions/${encodeURIComponent(id)}`;
export const expeditionHref = (id: string) => `/expeditions/${encodeURIComponent(id)}`;
/** A draft is read only from the workspace it was drafted in (server expeditions/routes.ts). */
export const draftUrl = (draftId: string, workspaceId: string) =>
  `/api/buddies/expeditions/drafts/${encodeURIComponent(draftId)}?workspaceId=${encodeURIComponent(workspaceId)}`;
/** Crew Buddies: kept off the Buddies roster (atoms/buddy-visibility.ts). */
export const EXPEDITION_CREWS_URL = '/api/buddies/expeditions/crews';
/** Every expedition, newest launch first; under `/api/buddies`, so `buddies_changed` refreshes it. */
export const EXPEDITIONS_URL = '/api/buddies/expeditions';
export const EXPEDITIONS_POLL_MS = 10_000;

/** What GET /api/buddies/expeditions/:id answered: the live view or a retired one's frozen view. */
export type ExpeditionRead =
  | { t: 'live'; view: ExpeditionView }
  | { t: 'retired'; view: ExpeditionRetiredView };

export const expeditionRead = (data: ExpeditionView | ExpeditionRetiredView): ExpeditionRead =>
  't' in data ? { t: 'retired', view: data } : { t: 'live', view: data };

export const summaryOf = (read: ExpeditionRead): ExpeditionSummary => {
  switch (read.t) {
    case 'retired':
      return read.view.summary;
    case 'live':
      return liveSummary(read.view);
  }
};

const liveSummary = (v: ExpeditionView): ExpeditionSummary => {
  const { id, run, workspaceId, launchedAt, counts, cost, line, retirement } = v;
  return { id, name: v.charter.name, run, workspaceId, launchedAt, counts, cost, line, retirement };
};

/** Poll interval: 0 once finished with nothing live (audit 2026-11-01 #8: finished expeditions
 * polled forever) or retired; `buddies_changed` pushes still refresh a finished one. */
type PollFacts = Pick<ExpeditionSummary, 'run' | 'counts' | 'retirement'>;
export function pollMsOf(s: PollFacts, liveMs: number): number {
  switch (s.retirement.t) {
    case 'retired':
      return 0;
    case 'retiring':
      return liveMs;
    case 'active':
      return s.run.t === 'finished' && s.counts.running === 0 ? 0 : liveMs;
  }
}

export type Tone = 'ok' | 'warn' | 'info' | 'bad' | 'muted';
type RunLook = { tone: Tone; dot: 'running' | 'queued' | 'idle'; emphasis?: 'new' | 'read' };

/** Run state looks; `emphasis` is the rail's unread vocabulary (ChannelBrowser.css). */
export const RUN_LOOK: Record<ExpeditionRun['t'], RunLook> = {
  running: { tone: 'ok', dot: 'running' },
  waiting_owner: { tone: 'warn', dot: 'queued', emphasis: 'new' },
  paused: { tone: 'muted', dot: 'idle', emphasis: 'read' },
  finished: { tone: 'info', dot: 'idle' },
};
export const needsYou = (e: Pick<ExpeditionSummary, 'run'>) => e.run.t === 'waiting_owner';

export type Pill = { label: string; tone: Tone };
export function expeditionPill(e: Pick<ExpeditionSummary, 'run' | 'retirement'>): Pill {
  switch (e.retirement.t) {
    case 'retired':
      return { label: 'Retired', tone: 'muted' };
    case 'retiring':
      return { label: 'Retiring…', tone: 'muted' };
    case 'active':
      return { label: expeditionRunLabel(e.run), tone: RUN_LOOK[e.run.t].tone };
  }
}

type OwnerAction = { t: 'retire' } | { t: 'stop_and_retire' } | { t: 'none' };
export function ownerActions(e: Pick<ExpeditionSummary, 'run' | 'retirement'>): OwnerAction {
  switch (e.retirement.t) {
    case 'retiring':
    case 'retired':
      return { t: 'none' };
    case 'active':
      return e.run.t === 'finished' ? { t: 'retire' } : { t: 'stop_and_retire' };
  }
}

export const PHASE_LOOK: Record<ExpeditionAttempt['phase']['t'], { tone: Tone; state: string }> = {
  planned: { tone: 'muted', state: 'queued' },
  admitted: { tone: 'muted', state: 'starting' },
  posting: { tone: 'ok', state: 'running' },
  posted: { tone: 'ok', state: 'running' },
  dropped: { tone: 'bad', state: 'not started' },
  ended: { tone: 'info', state: 'finished' },
};

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

type Limits = ExpeditionCharterView['limits'];
export const budgetLine = (limits: Limits) =>
  `${limits.maxAttempts} attempts · ${limits.maxLive} at once · ${limits.hours} h`;

function durationLabel(fromIso: string, toIso: string): string {
  const minutes = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`;
}

export function expeditionGroups(all: readonly ExpeditionSummary[]) {
  const live = all.filter((e) => e.retirement.t !== 'retired');
  return {
    active: live.filter((e) => e.run.t !== 'finished'),
    finished: live.filter((e) => e.run.t === 'finished'),
    retired: all.filter((e) => e.retirement.t === 'retired'),
  };
}

/** The rail's and Home's list: unfinished, needing the owner first, else newest first. */
export const activeExpeditions = (list: readonly ExpeditionSummary[], workspaceId: string) => {
  const { active } = expeditionGroups(list.filter((e) => e.workspaceId === workspaceId));
  return [...active.filter(needsYou), ...active.filter((e) => !needsYou(e))];
};

/** The header's time: elapsed and left while it runs; how long it took once finished
 * (2026-11-01 review: a finished expedition showed "7h 56m left"). */
export function timeLine(v: ExpeditionView): string {
  switch (v.run.t) {
    case 'running':
    case 'paused':
    case 'waiting_owner':
      return `${durationLabel(v.launchedAt, v.now)} elapsed · ${durationLabel(v.now, v.deadline)} left`;
    case 'finished':
      return `took ${durationLabel(v.launchedAt, v.run.at)}`;
  }
}

export function shortTime(iso: string, nowIso: string): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return at.toDateString() === new Date(nowIso).toDateString()
    ? time
    : `${at.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

export const SCOPE_LABEL: Record<ExpeditionQuestion['scope'], string> = {
  in: 'in scope',
  explore: 'explore',
  parked: 'parked',
};

export const QUESTION_GLYPH: Record<ExpeditionQuestion['status'], string> = {
  open: '○',
  verified: '✓',
  dead: '✗',
};

export const DRAFT_PILL: Record<ExpeditionDraftState['t'], Pill> = {
  open: { label: 'draft', tone: 'info' },
  launched: { label: 'launched', tone: 'ok' },
  superseded: { label: 'replaced', tone: 'muted' },
};

/** Limits in words (2026-11-01 review: the draft listed raw `maxLive: 2` keys). */
export function limitItems(limits: Limits, defaults: ReadonlySet<ExpeditionDefault>) {
  return [
    { text: `${limits.maxAttempts} attempts`, defaulted: false },
    { text: `${limits.maxLive} at once`, defaulted: defaults.has('maxLive') },
    { text: `${limits.hours} h limit`, defaulted: defaults.has('hours') },
    {
      text: `up to ${Math.round(limits.exploreShare * 100)}% of attempts exploring`,
      defaulted: defaults.has('exploreShare'),
    },
  ];
}

/** An attempt's measured cost (design.md R6), never an estimate; null before it ended. */
export function attemptCostLine(
  cost: ExpeditionAttemptCost
): { text: string; title: string } | null {
  switch (cost.t) {
    case 'none':
      return null;
    case 'settling':
      return {
        text: 'reading token usage…',
        title: 'Its run settled; its token usage is read shortly',
      };
    case 'measured':
      return { text: cost.label, title: cost.detail };
    case 'unmeasured':
      return { text: 'not measured', title: cost.reason };
  }
}

export const validationsOf = (all: ExpeditionValidation[], attemptId: string) =>
  all.filter((x) => x.subject.t === 'candidate' && x.subject.claimAttemptId === attemptId);

export type Focus = 'workers' | 'tasks' | 'reflections' | 'charter' | 'chat';
/** `count`: the tab's total (2026-11-01 review: "Workers 0" beside four finished read as broken). */
export const FOCI: { focus: Focus; label: string; count?(v: ExpeditionView): number }[] = [
  { focus: 'workers', label: 'Workers', count: (v) => v.attempts.length },
  { focus: 'tasks', label: 'Tasks', count: (v) => v.questions.length },
  { focus: 'reflections', label: 'Reflections', count: (v) => v.reflections.length },
  { focus: 'charter', label: 'Charter' },
  { focus: 'chat', label: 'Chat' },
];

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
        : { t: 'blocked', reason: `${issueCount(d.issues.length)} to fix first (Info)` };
  }
}

export const issueCount = (n: number) => `${n} ${n === 1 ? 'issue' : 'issues'}`;
