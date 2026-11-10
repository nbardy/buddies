import type { keyed } from '@unleashd/shared';

// The keyed expedition view's pure model (KeyedExpeditionView.tsx, KeyedTimeline.tsx): the time
// axis, where each bar and marker lands on it, lanes grouped by phase, the budget split and the
// words. No React. The server already groups bars into lanes (`KeyedView.lanes`), so nothing here
// re-derives a lane: it only places what it is given. Positions are fractions of the axis (0..1),
// so the track can be any width, and a phone scrolls the track inside its own container.
// Pattern: table-driven (docs/patterns.md#table-driven)

type Bar = keyed.Bar;
type Lane = keyed.Lane;
type Marker = keyed.Marker;
type View = keyed.KeyedView;

/** The axis never spans less than this, so a brand-new expedition has a track to draw on. */
export const MIN_SPAN_MS = 60_000;
/** The narrowest a bar is drawn, as a fraction of the axis: a 3-second call on a 2-day axis
 * would otherwise be 0.002% wide and unclickable. */
export const MIN_BAR = 0.008;

const ms = (iso: string) => Date.parse(iso);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

// ---- The axis ----

export type Axis = { startMs: number; endMs: number };

/** Where a bar ends: a settled one at its settle time, a running one at `now`. */
const BAR_END: {
  [K in keyed.BarEnd['t']]: (e: Extract<keyed.BarEnd, { t: K }>, now: number) => number;
} = {
  open: (_, now) => now,
  settled: (e) => ms(e.at),
};
export const barEndMs = (bar: Bar, now: number): number =>
  BAR_END[bar.end.t](bar.end as never, now);

/** A live expedition's axis runs to now; a finished one's stops at its last event. */
const STATUS_TAIL: { [K in keyed.KeyedStatus['t']]: (now: number) => number } = {
  running: (now) => now,
  paused: (now) => now,
  finished: () => 0,
};

/** From launch to the last thing that happened (or now, while it runs). */
export function axisOf(view: View, now: number): Axis {
  const bars = view.lanes.flatMap((lane) => lane.bars);
  const starts = [ms(view.launchedAt), ...bars.map((b) => ms(b.start))];
  const ends = [
    STATUS_TAIL[view.status.t](now),
    ...bars.map((b) => barEndMs(b, now)),
    ...view.markers.map((m) => ms(m.at)),
  ];
  const startMs = Math.min(...starts);
  return { startMs, endMs: Math.max(startMs + MIN_SPAN_MS, ...ends) };
}

const fractionOf = (axis: Axis, t: number) => (t - axis.startMs) / (axis.endMs - axis.startMs);

/** A moment's place on the axis; a moment outside it sits on the nearest edge. */
export const positionOf = (axis: Axis, iso: string): number =>
  clamp(fractionOf(axis, ms(iso)), 0, 1);

export type Box = { left: number; width: number };
/** A bar's box: never narrower than MIN_BAR, never past either edge, never negative. */
export function boxOf(axis: Axis, bar: Bar, now: number): Box {
  const from = fractionOf(axis, ms(bar.start));
  const to = fractionOf(axis, barEndMs(bar, now));
  const width = clamp(to - from, MIN_BAR, 1);
  return { left: clamp(from, 0, 1 - width), width };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** "3 s", "12 m", "2 h 10 m", "2 d 4 h": the span of a run in minutes or in days. */
export function durationLabel(span: number): string {
  if (span < MINUTE) return `${Math.round(span / 1000)} s`;
  if (span < HOUR) return `${Math.round(span / MINUTE)} m`;
  if (span < 2 * DAY) {
    const m = Math.round((span % HOUR) / MINUTE);
    return `${Math.floor(span / HOUR)} h${m > 0 ? ` ${m} m` : ''}`;
  }
  const h = Math.round((span % DAY) / HOUR);
  return `${Math.floor(span / DAY)} d${h > 0 ? ` ${h} h` : ''}`;
}

export type Tick = { at: number; label: string };
/** Elapsed-time labels at the axis's quarters; the first sits right of its tick, the last left. */
export const ticksOf = (axis: Axis): Tick[] =>
  [0, 0.25, 0.5, 0.75, 1].map((at) => ({
    at,
    label: at === 0 ? 'launch' : `+${durationLabel(at * (axis.endMs - axis.startMs))}`,
  }));

// ---- Lanes, grouped by the key's first path segment (the phase) ----

/** `phase/step/id`: the phase is the first segment; a key with no slash is its own phase. */
export const phaseOf = (key: string): string => key.split('/')[0];

export type Phase = { phase: string; lanes: Lane[] };
/** Phases in the order they first appear; lanes keep the server's order inside each. */
export function groupLanes(lanes: readonly Lane[]): Phase[] {
  const phases = new Map<string, Lane[]>();
  for (const lane of lanes) {
    const phase = phaseOf(lane.key);
    phases.set(phase, [...(phases.get(phase) ?? []), lane]);
  }
  return [...phases].map(([phase, group]) => ({ phase, lanes: group }));
}

// ---- Bars: tone, words, staleness ----

export type Tone =
  | 'passed'
  | 'failed'
  | 'errored'
  | 'cancelled'
  | 'refused'
  | 'running'
  | 'waiting';
/** The existing colour token each outcome is drawn in; a bar sets it as `--tone`. */
export const TONE_COLOR: Record<Tone, string> = {
  passed: 'var(--theme-success)',
  failed: 'var(--theme-danger)',
  errored: 'var(--theme-queue)',
  cancelled: 'var(--text-muted)',
  refused: 'var(--text-secondary)',
  running: 'var(--accent)',
  waiting: 'var(--theme-warning)',
};
export const TONE_LABEL: Record<Tone, string> = {
  passed: 'Passed',
  failed: 'Failed',
  errored: 'Errored',
  cancelled: 'Cancelled',
  refused: 'Refused',
  running: 'Running',
  waiting: 'Waiting on you',
};

const OUTCOME_TONE: { [K in keyed.Outcome['t']]: Tone } = {
  passed: 'passed',
  failed: 'failed',
  errored: 'errored',
  cancelled: 'cancelled',
  refused: 'refused',
};
/** An open ask is the owner's to answer; any other open call is running. */
const KIND_OPEN_TONE: Record<keyed.CallKind, Tone> = {
  agent: 'running',
  command: 'running',
  verdict: 'running',
  leader: 'running',
  ask: 'waiting',
};
const END_TONE: { [K in keyed.BarEnd['t']]: (bar: Bar & { end: { t: K } }) => Tone } = {
  open: (bar) => KIND_OPEN_TONE[bar.kind],
  settled: (bar) => OUTCOME_TONE[(bar.end as Extract<keyed.BarEnd, { t: 'settled' }>).outcome.t],
};
export const toneOf = (bar: Bar): Tone => END_TONE[bar.end.t](bar as never);

const OUTCOME_WHY: { [K in keyed.Outcome['t']]: (o: Extract<keyed.Outcome, { t: K }>) => string } =
  {
    passed: () => 'Its judge passed it.',
    failed: (o) => o.why,
    errored: (o) => o.why,
    cancelled: (o) => `Cancelled; partial work kept at ${o.partial}.`,
    refused: (o) => `Refused before it started: ${o.reason}.`,
  };
const END_WHY: { [K in keyed.BarEnd['t']]: (e: Extract<keyed.BarEnd, { t: K }>) => string } = {
  open: () => 'Still running.',
  settled: (e) => OUTCOME_WHY[e.outcome.t](e.outcome as never),
};
/** The one sentence a detail panel says about how a bar ended. */
export const whyOf = (bar: Bar): string => END_WHY[bar.end.t](bar.end as never);

const PLAN_VERSION: {
  [K in keyed.KeyedPlan['t']]: (p: Extract<keyed.KeyedPlan, { t: K }>) => number;
} = {
  unplanned: () => 0,
  planned: (p) => p.version,
};
export const planVersionOf = (view: Pick<View, 'plan'>): number =>
  PLAN_VERSION[view.plan.t](view.plan as never);

/** Started under a plan the leader has since replaced. */
export const isStale = (bar: Bar, currentVersion: number): boolean =>
  bar.planVersion < currentVersion;

/** Retry is by key, so only a lane's newest bar can be retried, and only after it errored or was
 * refused (a failed call's output exists; the leader decides what to do about it). */
export const canRetry = (lane: Lane, bar: Bar): boolean =>
  lane.bars[lane.bars.length - 1] === bar &&
  (toneOf(bar) === 'errored' || toneOf(bar) === 'refused');

// ---- Markers ----

export type Placed = { marker: Marker; at: number };
/** Every marker with its place on the axis, in log order. */
export const placeMarkers = (axis: Axis, markers: readonly Marker[]): Placed[] =>
  markers.map((marker) => ({ marker, at: positionOf(axis, marker.at) }));

const FINISH_LABEL: { [K in keyed.Finish['t']]: string } = {
  met: 'Goal met',
  'not-met': 'Ended, goal not met',
  budget: 'Out of budget',
  deadline: 'Deadline reached',
  stopped: 'Stopped',
};
export const finishLabel = (reason: keyed.Finish): string => FINISH_LABEL[reason.t];

const MARKER_LABEL: { [K in Marker['t']]: (m: Extract<Marker, { t: K }>) => string } = {
  plan: (m) => `Plan v${m.version}`,
  review: (m) => `Review: ${m.decision}`,
  finished: (m) => finishLabel(m.reason),
};
export const markerLabel = (m: Marker): string => MARKER_LABEL[m.t](m as never);

const MARKER_WHY: { [K in Marker['t']]: (m: Extract<Marker, { t: K }>) => string } = {
  plan: (m) => m.why,
  review: (m) => `${m.question} ${m.why}`,
  finished: (m) => finishLabel(m.reason),
};
export const markerWhy = (m: Marker): string => MARKER_WHY[m.t](m as never);

/** "3 started · 2 reused · 1 attached · 1 dropped · +$0.40" */
export const diffLine = (d: keyed.Diff): string =>
  [
    `${d.started.length} started`,
    `${d.reused.length} reused`,
    `${d.attached.length} attached`,
    `${d.dropped.length} dropped`,
    `+${usd(d.newCostUsd)}`,
  ].join(' · ');

// ---- Header ----

export const usd = (x: number): string => `$${x.toFixed(2)}`;
export const goalLine = (goal: string): string => goal.split('\n')[0];

export type Budget = { spent: number; reserved: number; over: boolean };
/** Spent and reserved as fractions of the bar. When both together pass the budget the bar is the
 * larger total and `over` says so, so the fill never leaves its track. */
export function budgetSplit(row: keyed.KeyedRow): Budget {
  const held = row.spentUsd + row.reservedUsd;
  const whole = Math.max(row.budget.usd, held);
  return {
    spent: row.spentUsd / whole,
    reserved: row.reservedUsd / whole,
    over: held > row.budget.usd,
  };
}

/** The budget bar's fill: spent, then reserved, then the empty rest. */
export const budgetGradient = (b: Budget): string => {
  const spent = `${(b.spent * 100).toFixed(2)}%`;
  const held = `${((b.spent + b.reserved) * 100).toFixed(2)}%`;
  return `linear-gradient(to right, var(--accent) ${spent}, var(--theme-warning) ${spent} ${held}, var(--bg-raised-3) ${held})`;
};

const APPROVAL_PENDING: { [K in keyed.PendingApproval['t']]: boolean } = {
  none: false,
  pending: true,
};
/** The owner is wanted: an ask is unanswered or a rewrite waits for approval. */
export const needsYou = (view: Pick<View, 'asks' | 'approval'>): boolean =>
  view.asks.length > 0 || APPROVAL_PENDING[view.approval.t];

export type PillTone = keyed.KeyedStatus['t'] | 'needs-you';
export const pillToneOf = (view: Pick<View, 'asks' | 'approval' | 'status'>): PillTone =>
  needsYou(view) ? 'needs-you' : view.status.t;
export const PILL_LABEL: { [K in PillTone]: (v: Pick<View, 'status'>) => string } = {
  running: () => 'Running',
  paused: () => 'Paused',
  'needs-you': () => 'Needs you',
  finished: (v) => finishLabel((v.status as Extract<keyed.KeyedStatus, { t: 'finished' }>).reason),
};
/** A row in a list says its state without the asks (a row has none): the status alone. */
export const statusLabel = (status: keyed.KeyedStatus): string => PILL_LABEL[status.t]({ status });

export type OwnerAct = 'pause' | 'resume' | 'extend' | 'stop';
/** What the owner may do in each status: a finished expedition takes no act. */
export const ACTS: { [K in keyed.KeyedStatus['t']]: readonly OwnerAct[] } = {
  running: ['pause', 'extend', 'stop'],
  paused: ['resume', 'extend', 'stop'],
  finished: [],
};

/** Rows that need a closer look first: the ones still going, then the ones that ended. */
export const rankRows = (rows: readonly keyed.KeyedRow[]): keyed.KeyedRow[] =>
  [...rows].sort((a, b) => Number(a.status.t === 'finished') - Number(b.status.t === 'finished'));

export const PLAN_LABEL: {
  [K in keyed.KeyedPlan['t']]: (p: Extract<keyed.KeyedPlan, { t: K }>) => string;
} = {
  unplanned: () => 'No plan yet',
  planned: (p) => `Plan v${p.version}`,
};
export const planLabel = (plan: keyed.KeyedPlan): string => PLAN_LABEL[plan.t](plan as never);

export const budgetText = (row: keyed.KeyedRow): string =>
  `${usd(row.spentUsd)} spent · ${usd(row.reservedUsd)} reserved of ${usd(row.budget.usd)}${budgetSplit(row).over ? ' (over)' : ''}`;

const MARKER_GLYPH: { [K in Marker['t']]: (m: Extract<Marker, { t: K }>) => string } = {
  plan: (m) => `v${m.version}`,
  review: () => '▾',
  finished: () => '⚑',
};
/** What a marker shows on the axis: its plan version, a review tick, the finish flag. */
export const markerGlyph = (m: Marker): string => MARKER_GLYPH[m.t](m as never);

/** The newest ten, newest first. */
export const recentFaults = (faults: readonly keyed.Fault[]): keyed.Fault[] =>
  faults.slice(-10).reverse();

// ---- What the owner has selected ----

export type Selection =
  | { t: 'none' }
  | { t: 'bar'; key: string; hash: string; attempt: number }
  | { t: 'marker'; index: number };
export const selectBar = (bar: Bar): Selection => ({
  t: 'bar',
  key: bar.key,
  hash: bar.hash,
  attempt: bar.attempt,
});

export type Target =
  | { t: 'none' }
  | { t: 'bar'; lane: Lane; bar: Bar }
  | { t: 'marker'; marker: Marker };

const TARGET: { [K in Selection['t']]: (s: Extract<Selection, { t: K }>, view: View) => Target } = {
  none: () => ({ t: 'none' }),
  // A re-plan can drop the selected bar's lane; the panel then goes back to its hint.
  bar: (s, view) => {
    const lane = view.lanes.find((l) => l.key === s.key);
    const bar = lane?.bars.find((b) => b.hash === s.hash && b.attempt === s.attempt);
    return lane && bar ? { t: 'bar', lane, bar } : { t: 'none' };
  },
  marker: (s, view) => {
    const marker = view.markers[s.index];
    return marker ? { t: 'marker', marker } : { t: 'none' };
  },
};
export const targetOf = (selection: Selection, view: View): Target =>
  TARGET[selection.t](selection as never, view);
