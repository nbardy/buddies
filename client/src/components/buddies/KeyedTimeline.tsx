import type { keyed } from '@unleashd/shared';
import type { CSSProperties, ReactNode } from 'react';
import { buddyWrite } from './api';
import { when } from './ExpeditionPanels';
import { Confirm } from './ExpeditionView';
import { useKeyedWrite } from './keyed-api';
import {
  type Axis,
  type Box,
  type Selection,
  TONE_COLOR,
  TONE_LABEL,
  type Target,
  type Tone,
  axisOf,
  barEndMs,
  boxOf,
  canRetry,
  costText,
  diffLine,
  durationLabel,
  groupLanes,
  isStale,
  markerGlyph,
  markerLabel,
  markerWhy,
  placeMarkers,
  planVersionOf,
  selectBar,
  targetOf,
  ticksOf,
  toneOf,
  whyOf,
} from './keyed-timeline';
import './KeyedExpedition.css';

// The waterfall (docs/expeditions/keyed/v1/DESIGN.md §2): one lane per key, grouped by phase, each
// call a bar on one shared time axis, a marker per plan version, a tick per review. Everything
// positional comes from keyed-timeline.ts; this file only draws it. Selecting a bar or a marker
// fills the panel under the plot (no modal).

const pct = (x: number) => `${x * 100}%`;
/** A bar's inline style: its box on the axis and its colour token (`--tone` is a custom property). */
const barStyle = (box: Box, tone: Tone) =>
  ({ left: pct(box.left), width: pct(box.width), '--tone': TONE_COLOR[tone] }) as CSSProperties;

type Props = {
  view: keyed.KeyedView;
  now: number;
  selection: Selection;
  select(next: Selection): void;
};

export function Timeline({ view, now, selection, select }: Props) {
  const axis = axisOf(view, now);
  const version = planVersionOf(view);
  const target = targetOf(selection, view);
  return (
    <div className="keyed-expedition-timeline ui-stack">
      <div className="keyed-expedition-scroll ui-scroll-quiet">
        <div className="keyed-expedition-plot">
          <AxisRow axis={axis} />
          {/* The markers' own row: their labels sit here, never over a lane's bars. */}
          <div className="keyed-expedition-row" aria-hidden="true">
            <span className="ui-muted">Plan</span>
            <div className="keyed-expedition-track" style={{ background: 'none' }} />
          </div>
          {groupLanes(view.lanes).map((group) => (
            <section key={group.phase} className="keyed-expedition-phase">
              {group.phase !== '' && (
                <h4 className="keyed-expedition-phase-name ui-muted">{group.phase}</h4>
              )}
              {group.lanes.map((lane) => (
                <LaneRow
                  key={lane.key}
                  lane={lane}
                  axis={axis}
                  now={now}
                  version={version}
                  target={target}
                  select={select}
                />
              ))}
            </section>
          ))}
          <Markers axis={axis} markers={view.markers} select={select} />
        </div>
      </div>
      <Detail target={target} version={version} now={now} id={view.id} />
    </div>
  );
}

function AxisRow({ axis }: { axis: Axis }) {
  return (
    <div className="keyed-expedition-row keyed-expedition-axis" aria-hidden="true">
      <span />
      <div className="keyed-expedition-track">
        {ticksOf(axis).map((tick) => (
          <span
            key={tick.at}
            className="keyed-expedition-tick"
            style={{ left: pct(tick.at), transform: `translateX(-${pct(tick.at)})` }}
          >
            {tick.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function LaneRow({
  lane,
  axis,
  now,
  version,
  target,
  select,
}: {
  lane: keyed.Lane;
  axis: Axis;
  now: number;
  version: number;
  target: Target;
  select(next: Selection): void;
}) {
  return (
    <div className="keyed-expedition-row">
      <span className="keyed-expedition-key ui-truncate" title={`${lane.key} (${lane.kind})`}>
        {lane.key.slice(lane.key.indexOf('/') + 1)}
      </span>
      <div className="keyed-expedition-track">
        {lane.bars.map((bar) => (
          <button
            key={`${bar.hash}-${bar.attempt}`}
            type="button"
            className="keyed-expedition-bar"
            data-tone={toneOf(bar)}
            data-stale={isStale(bar, version) || undefined}
            aria-pressed={target.t === 'bar' && target.bar === bar}
            style={barStyle(boxOf(axis, bar, now), toneOf(bar))}
            title={`${lane.key} · attempt ${bar.attempt} · ${TONE_LABEL[toneOf(bar)]}`}
            aria-label={`${lane.key}, attempt ${bar.attempt}: ${TONE_LABEL[toneOf(bar)]}`}
            onClick={() => select(selectBar(bar))}
          />
        ))}
      </div>
    </div>
  );
}

/** Plan versions, reviews and the finish: lines over every lane's track (the overlay is inset by
 * the label column, so a marker's `left` is a fraction of the same axis the bars use). */
function Markers({
  axis,
  markers,
  select,
}: {
  axis: Axis;
  markers: readonly keyed.Marker[];
  select(next: Selection): void;
}) {
  return (
    <div className="keyed-expedition-markers">
      {placeMarkers(axis, markers).map(({ marker, at }, index) => (
        <button
          key={`${marker.t}-${marker.at}-${index}`}
          type="button"
          className="keyed-expedition-marker"
          data-kind={marker.t}
          style={{ left: pct(at) }}
          title={`${markerLabel(marker)}: ${markerWhy(marker)}`}
          aria-label={markerLabel(marker)}
          onClick={() => select({ t: 'marker', index })}
        >
          {markerGlyph(marker)}
        </button>
      ))}
    </div>
  );
}

// ---- The detail panel ----

function Facts({ rows }: { rows: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="ui-stack">
      {rows.map(([name, value]) => (
        <div key={name} className="expedition-fact">
          <dt className="ui-muted">{name}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

type DetailProps = { version: number; now: number; id: string };
const DETAIL: { [K in Target['t']]: (t: Extract<Target, { t: K }>, p: DetailProps) => ReactNode } =
  {
    none: () => <p className="ui-muted">Select a bar or a marker for its detail.</p>,
    bar: (t, p) => <BarDetail lane={t.lane} bar={t.bar} {...p} />,
    marker: (t) => <MarkerDetail marker={t.marker} />,
  };
const Detail = ({ target, ...p }: DetailProps & { target: Target }) => (
  <section className="ui-stack" aria-label="Detail">
    {DETAIL[target.t](target as never, p)}
  </section>
);

function BarDetail({
  lane,
  bar,
  version,
  now,
  id,
}: DetailProps & { lane: keyed.Lane; bar: keyed.Bar }) {
  const write = useKeyedWrite();
  const tone = toneOf(bar);
  const span = durationLabel(barEndMs(bar, now) - Date.parse(bar.start));
  return (
    <>
      <Facts
        rows={[
          ['Key', <code key="k">{bar.key}</code>],
          ['Attempt', `${bar.attempt} (${lane.kind})`],
          [
            'Outcome',
            <span key="o" className="expedition-attempt-result" data-tone={TONE_CLASS[tone]}>
              {TONE_LABEL[tone]}
            </span>,
          ],
          ['Why', whyOf(bar)],
          [
            'Plan',
            isStale(bar, version)
              ? `v${bar.planVersion}, replaced by v${version} since it started`
              : `v${bar.planVersion}`,
          ],
          ['Ran', `${when(bar.start)} · ${span}`],
          ['Cost', costText(bar.cost)],
        ]}
      />
      {canRetry(lane, bar) && (
        <div className="expedition-controls ui-row">
          {write.state.t === 'failed' && (
            <span className="expedition-error ui-truncate" title={write.state.error}>
              {write.state.error}
            </span>
          )}
          <Confirm
            label="Retry"
            sure="Retry this call"
            run={() =>
              write.run(() => buddyWrite('keyed.act', { id }, { t: 'retry', key: bar.key }))
            }
          />
        </div>
      )}
    </>
  );
}

/** The attempt-result tones of Expedition.css, for the outcome words. */
const TONE_CLASS = {
  passed: 'pass',
  failed: 'fail',
  errored: 'fail',
  cancelled: 'none',
  refused: 'none',
  running: 'live',
  waiting: 'waiting',
} as const;

const MARKER_FACTS: {
  [K in keyed.Marker['t']]: (
    m: Extract<keyed.Marker, { t: K }>
  ) => readonly (readonly [string, ReactNode])[];
} = {
  plan: (m) => [
    ['Plan', `v${m.version} by ${m.by}`],
    ['Why', m.why],
    ['Changes', diffLine(m.diff)],
  ],
  review: (m) => [
    ['Review', `${m.decision} (plan v${m.planVersion})`],
    ['Asked', m.question],
    ['Why', m.why],
  ],
  finished: (m) => [['Finished', markerLabel(m)]],
};
const MarkerDetail = ({ marker }: { marker: keyed.Marker }) => (
  <Facts rows={[...MARKER_FACTS[marker.t](marker as never), ['At', when(marker.at)]]} />
);
