import type { keyed } from '@unleashd/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { buddyWrite } from './api';
import { ChannelLoader } from './ChannelLoader';
import { channelsHref } from './channels-view';
import { Scroll, when } from './ExpeditionPanels';
import { Confirm, type Frame, Gone, timeLeft, useNow } from './ExpeditionView';
import { KeyedApproval, KeyedAsks } from './KeyedNeeds';
import { Timeline } from './KeyedTimeline';
import { unavailableText, useKeyedView, useKeyedWrite } from './keyed-api';
import {
  ACTS,
  type OwnerAct,
  PILL_LABEL,
  type PillTone,
  type Selection,
  budgetGradient,
  budgetSplit,
  budgetText,
  goalLine,
  pillToneOf,
  planLabel,
  recentFaults,
} from './keyed-timeline';
import './Expedition.css';
import './KeyedExpedition.css';

// One keyed expedition in the Channels main pane (`?keyed=<id>`, ChannelsView kind `keyed`): a
// header like the other expedition view's, the owner's asks and approval above the Timeline, and
// the faults folded below (docs/expeditions/keyed/v1/CONNECT_PLAN.md §4). The server projects the
// view; nothing is derived here beyond placing bars (keyed-timeline.ts).

type Props = { id: string; workspaceId: string; frame: Frame };

export function KeyedExpeditionView({ id, workspaceId, frame }: Props) {
  const read = useKeyedView(id, 5_000);
  const now = useNow();
  if (read.data === null)
    return read.kind === 'failed' ? (
      <Gone frame={frame} workspaceId={workspaceId} text={unavailableText(read.error.message)} />
    ) : (
      <ChannelLoader label="Loading expedition…" />
    );
  return <Loaded view={read.data} workspaceId={workspaceId} frame={frame} now={now} />;
}

function Loaded({
  view,
  workspaceId,
  frame,
  now,
}: {
  view: keyed.KeyedView;
  workspaceId: string;
  frame: Frame;
  now: number;
}) {
  const [selection, select] = useState<Selection>({ t: 'none' });
  const tone = pillToneOf(view);
  const split = budgetSplit(view);
  const controls = <Controls view={view} />;
  return (
    <section
      className="channel-browser-pane expedition keyed-expedition ui-stack"
      data-frame={frame}
      aria-label={goalLine(view.goal)}
    >
      {HEADER[frame]({ view, tone, controls, workspaceId, meta: metaOf(view, now) })}
      <Scroll>
        <div className="expedition-manage ui-row">
          <strong>{planLabel(view.plan)}</strong>
          <div
            className="keyed-expedition-budget"
            style={{ background: budgetGradient(split) }}
            role="img"
            aria-label={budgetText(view)}
          />
          <span className="ui-muted">{budgetText(view)}</span>
        </div>
        <KeyedAsks id={view.id} asks={view.asks} />
        <KeyedApproval id={view.id} approval={view.approval} />
        <Timeline view={view} now={now} selection={selection} select={select} />
        <Faults faults={view.faults} />
      </Scroll>
    </section>
  );
}

const metaOf = (view: keyed.KeyedView, now: number): string =>
  `${planLabel(view.plan)} · ${view.status.t === 'finished' ? `deadline was ${when(view.deadline)}` : timeLeft(view.deadline, now)}`;

type HeaderParts = {
  view: keyed.KeyedView;
  tone: PillTone;
  controls: React.ReactNode;
  workspaceId: string;
  meta: string;
};
const Pill = ({ view, tone }: { view: keyed.KeyedView; tone: PillTone }) => (
  <span className="expedition-pill" data-state={tone}>
    {PILL_LABEL[tone](view)}
  </span>
);
const HEADER: Record<Frame, (p: HeaderParts) => React.ReactNode> = {
  desktop: (p) => (
    <header className="channel-browser-pane-header expedition-head ui-row">
      <h2 className="ui-truncate">⛺ {goalLine(p.view.goal)}</h2>
      <Pill view={p.view} tone={p.tone} />
      <span className="expedition-head-meta ui-truncate ui-muted">{p.meta}</span>
      {p.controls}
    </header>
  ),
  mobile: (p) => (
    <header className="mobile-channel-header expedition-head ui-row">
      <Link
        className="mobile-channel-header__back"
        to={channelsHref(p.workspaceId, { kind: 'home' })}
        aria-label="Back"
      >
        ‹
      </Link>
      <div className="mobile-channel-header__heading expedition-phone-title">
        <h1>⛺ {goalLine(p.view.goal)}</h1>
      </div>
      <Pill view={p.view} tone={p.tone} />
      <div className="expedition-phone-line ui-row">
        <span className="ui-muted ui-truncate">{p.meta}</span>
        {p.controls}
      </div>
    </header>
  ),
};

// ---- Acts: which ones the status allows is the ACTS table ----

const EXTEND_HOURS = [1, 2, 4, 8, 24] as const;

function Controls({ view }: { view: keyed.KeyedView }) {
  const write = useKeyedWrite();
  const busy = write.state.t === 'pending';
  const send = (body: Parameters<typeof buddyWrite<'keyed.act'>>[2]) =>
    write.run(() => buddyWrite('keyed.act', { id: view.id }, body));
  const ACT: Record<OwnerAct, () => React.ReactNode> = {
    pause: () => (
      <button
        type="button"
        className="expedition-button"
        disabled={busy}
        onClick={() => send({ t: 'pause' })}
      >
        Pause
      </button>
    ),
    resume: () => (
      <button
        type="button"
        className="expedition-button"
        data-tone="primary"
        disabled={busy}
        onClick={() => send({ t: 'resume' })}
      >
        Resume
      </button>
    ),
    extend: () => (
      <select
        className="expedition-button"
        aria-label="Extend the deadline"
        value=""
        disabled={busy}
        onChange={(e) => send({ t: 'extend', hours: Number(e.target.value) })}
      >
        <option value="" disabled>
          Extend deadline
        </option>
        {EXTEND_HOURS.map((h) => (
          <option key={h} value={h}>
            +{h} h
          </option>
        ))}
      </select>
    ),
    stop: () => <Confirm label="Stop" sure="Stop for good" run={() => send({ t: 'stop' })} />,
  };
  return (
    <div className="expedition-controls ui-row">
      {write.state.t === 'failed' && (
        <span className="expedition-error ui-truncate" title={write.state.error}>
          {write.state.error}
        </span>
      )}
      {ACTS[view.status.t].map((act) => (
        <span key={act} className="ui-row">
          {ACT[act]()}
        </span>
      ))}
    </div>
  );
}

function Faults({ faults }: { faults: readonly keyed.Fault[] }) {
  return (
    <details>
      <summary className="ui-muted">Faults ({faults.length})</summary>
      <ul className="expedition-checks">
        {recentFaults(faults).map((f) => (
          <li key={`${f.at}-${f.what}`}>
            <span className="ui-muted">{when(f.at)}</span> {f.what}
          </li>
        ))}
      </ul>
    </details>
  );
}
