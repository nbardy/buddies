import {
  type ExpeditionAttempt,
  type ExpeditionAttemptCost,
  type ExpeditionCharterView,
  type ExpeditionDefault,
  type ExpeditionDraftState,
  type ExpeditionDraftView,
  type ExpeditionQuestion,
  type ExpeditionRetiredView,
  type ExpeditionRetirement,
  type ExpeditionRun,
  type ExpeditionStage,
  type ExpeditionSummary,
  type ExpeditionValidation,
  type ExpeditionView,
  expeditionRunLabel,
} from '@unleashd/shared';

// Pure view helpers for the expedition badge, draft card and modal (no React).

export const expeditionUrl = (id: string) => `/api/buddies/expeditions/${encodeURIComponent(id)}`;
export const expeditionHref = (id: string) => `/expeditions/${encodeURIComponent(id)}`;
/** A draft is read only from the workspace it was drafted in (server expeditions/routes.ts). */
export const draftUrl = (draftId: string, workspaceId: string) =>
  `/api/buddies/expeditions/drafts/${encodeURIComponent(draftId)}?workspaceId=${encodeURIComponent(workspaceId)}`;
/** Crew Buddies: kept off the Buddies roster (atoms/buddy-visibility.ts). */
export const EXPEDITION_CREWS_URL = '/api/buddies/expeditions/crews';

/** What GET /api/buddies/expeditions/:id answered: the live view, or a retired expedition's
 * frozen summary and report (server expeditions/retired.ts). Classified once, here. */
export type ExpeditionRead =
  | { t: 'live'; view: ExpeditionView }
  | { t: 'retired'; view: ExpeditionRetiredView };

export const expeditionRead = (data: ExpeditionView | ExpeditionRetiredView): ExpeditionRead =>
  't' in data ? { t: 'retired', view: data } : { t: 'live', view: data };

/** The summary row a read answers with: the badge's and the modal header's one source. */
export const summaryOf = (read: ExpeditionRead): ExpeditionSummary => {
  switch (read.t) {
    case 'retired':
      return read.view.summary;
    case 'live': {
      const v = read.view;
      return {
        id: v.id,
        name: v.charter.name,
        run: v.run,
        workspaceId: v.workspaceId,
        launchedAt: v.launchedAt,
        counts: v.counts,
        cost: v.cost,
        line: v.line,
        retirement: v.retirement,
      };
    }
  }
};

/**
 * How often an expedition view polls: never once it finished with nothing live (audit
 * 2026-11-01 #8: every open badge and modal kept polling a finished expedition forever), and
 * never once retired (frozen). A finished expedition still refreshes on `buddies_changed` pushes
 * (its key is under /api/buddies); one being retired keeps polling until it is frozen.
 */
export function pollMsOf(
  s: Pick<ExpeditionSummary, 'run' | 'counts' | 'retirement'>,
  liveMs: number
): number {
  switch (s.retirement.t) {
    case 'retired':
      return 0;
    case 'retiring':
      return liveMs;
    case 'active':
      return s.run.t === 'finished' && s.counts.running === 0 ? 0 : liveMs;
  }
}

/** The colour family of a pill, dot or chip (Expedition.css `.expedition-tone-*`). */
export type Tone = 'ok' | 'warn' | 'info' | 'bad' | 'muted';

/** How each run state looks, in one place: pill/chip tone, rail dot, rail row weight (the channel
 * rows' unread vocabulary, ChannelBrowser.css: bold when it needs the owner, dimmed while paused)
 * and whether the owner's attention is asked (Home lists those first). */
export const RUN_LOOK: Record<
  ExpeditionRun['t'],
  {
    tone: Tone;
    dot: 'running' | 'queued' | 'idle';
    emphasis: 'new' | 'read' | undefined;
    needsYou: boolean;
  }
> = {
  running: { tone: 'ok', dot: 'running', emphasis: undefined, needsYou: false },
  waiting_owner: { tone: 'warn', dot: 'queued', emphasis: 'new', needsYou: true },
  paused: { tone: 'muted', dot: 'idle', emphasis: 'read', needsYou: false },
  finished: { tone: 'info', dot: 'idle', emphasis: undefined, needsYou: false },
};

/** The status pill of a summary: a retired expedition reads Retired (muted), one being put away
 * Retiring, else its run state. */
export function expeditionPill(e: Pick<ExpeditionSummary, 'run' | 'retirement'>): {
  label: string;
  tone: Tone;
} {
  switch (e.retirement.t) {
    case 'retired':
      return { label: 'Retired', tone: 'muted' };
    case 'retiring':
      return { label: 'Retiring…', tone: 'muted' };
    case 'active':
      return { label: expeditionRunLabel(e.run), tone: RUN_LOOK[e.run.t].tone };
  }
}

/** What the owner can do to an expedition now: put away a finished one, stop and put away an
 * open one, or nothing (it is already being retired, or is). */
export type OwnerAction = { t: 'retire' } | { t: 'stop_and_retire' } | { t: 'none' };

export function ownerActions(e: Pick<ExpeditionSummary, 'run' | 'retirement'>): OwnerAction {
  switch (e.retirement.t) {
    case 'retiring':
    case 'retired':
      return { t: 'none' };
    case 'active':
      return e.run.t === 'finished' ? { t: 'retire' } : { t: 'stop_and_retire' };
  }
}

/** How each attempt phase looks, in one place: the dot's tone and the state word on its card. */
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

/** The card's budget line, e.g. `6 attempts · 3 at once · 12 h`. */
export const budgetLine = (limits: ExpeditionCharterView['limits']) =>
  `${limits.maxAttempts} attempts · ${limits.maxLive} at once · ${limits.hours} h`;

/** `2h 05m` / `14m`: a duration between two instants, for the header. */
export function durationLabel(fromIso: string, toIso: string): string {
  const minutes = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${String(minutes % 60).padStart(2, '0')}m` : `${minutes}m`;
}

/** Every expedition, newest launch first (server expeditions/routes.ts). Under `/api/buddies`, so
 * `buddies_changed` refreshes it like the modal. */
export const EXPEDITIONS_URL = '/api/buddies/expeditions';
/** How often the rail, the index and Home re-read the list (pushes refresh it sooner). */
export const EXPEDITIONS_POLL_MS = 10_000;

/** What the channel rail and Home list: this workspace's unfinished expeditions, the ones waiting
 * on the owner first, each group newest launch first (the list arrives newest first). */
export const activeExpeditions = (
  list: readonly ExpeditionSummary[],
  workspaceId: string
): ExpeditionSummary[] => {
  const mine = list.filter(
    (e) => e.workspaceId === workspaceId && e.run.t !== 'finished' && !isRetired(e.retirement)
  );
  return [
    ...mine.filter((e) => RUN_LOOK[e.run.t].needsYou),
    ...mine.filter((e) => !RUN_LOOK[e.run.t].needsYou),
  ];
};

const isRetired = (r: ExpeditionRetirement) => r.t === 'retired';

/** The index pane's groups: unfinished, finished (retired ones leave it), and retired. */
export function expeditionGroups(all: readonly ExpeditionSummary[]) {
  return {
    active: all.filter((e) => e.run.t !== 'finished' && !isRetired(e.retirement)),
    finished: all.filter((e) => e.run.t === 'finished' && !isRetired(e.retirement)),
    retired: all.filter((e) => isRetired(e.retirement)),
  };
}

/** The pill, badge and list label: one definition with the server's badge (shared). */
export const runLabel = expeditionRunLabel;

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

/** A short time for a caption: `1:42 PM` today, `Nov 1, 1:42 PM` on another day. */
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

/** A draft's pill on the card and in the modal header. */
export const DRAFT_PILL: Record<ExpeditionDraftState['t'], { label: string; tone: Tone }> = {
  open: { label: 'draft', tone: 'info' },
  launched: { label: 'launched', tone: 'ok' },
  superseded: { label: 'replaced', tone: 'muted' },
};

/** One limit as the Charter shows it, marked when the host filled it in. */
export interface LimitItem {
  text: string;
  defaulted: boolean;
}

/** The Charter's limits in words (`2 at once`, `8 h limit`, `up to 20% of attempts exploring`), each marked
 * when defaulted. 2026-11-01 review: the draft listed raw `maxLive: 2` keys as a second list. */
export function limitItems(
  limits: ExpeditionCharterView['limits'],
  defaults: ReadonlySet<ExpeditionDefault>
): LimitItem[] {
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

/** An attempt's measured cost (design.md R6) as one figure and its breakdown (the title); null
 * before it ended. Never an estimate. */
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

/** The host validations of one attempt's claimed commit, oldest first. */
export const validationsOf = (all: ExpeditionValidation[], attemptId: string) =>
  all.filter((x) => x.subject.t === 'candidate' && x.subject.claimAttemptId === attemptId);

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
