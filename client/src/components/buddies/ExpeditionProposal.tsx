import { keyed } from '@unleashd/shared';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { type PolledState, usePolledFetch } from '../../hooks/usePolledFetch';
import { buddyWrite } from './api';
import { Confirm } from './Confirm';
import { channelsHref } from './channels-view';
import { proposalUrl, unavailableText, useKeyedRows, useKeyedWrite } from './keyed-api';
import './Expedition.css';
import './KeyedExpedition.css';

// The chat card of a keyed proposal (server expeditions-v1/tool.ts `propose`): what the Buddy's
// folder would start, as the gates reported it, and the owner's Launch. The post carries the
// preview the Buddy was shown; the card asks the server only for the facts that change (the
// folder's files against the digest, whether it launched, whether the host can launch at all).
// Launch is the owner's click here, never a tool (CONNECT_PLAN §7.2).

/** Where the proposal stands now. κ: the one place the server's facts become a state. */
export type Standing =
  | { readonly t: 'checking' }
  | { readonly t: 'unreadable'; readonly why: string }
  | { readonly t: 'launched'; readonly id: string }
  | { readonly t: 'changed'; readonly why: string }
  | { readonly t: 'read-only'; readonly why: string }
  | { readonly t: 'ready' };

export function standingOf(read: PolledState<keyed.KeyedProposalStatus>): Standing {
  if (read.data === null)
    return read.kind === 'failed'
      ? { t: 'unreadable', why: unavailableText(read.error.message) }
      : { t: 'checking' };
  const s = read.data;
  if (s.launched.t === 'yes') return { t: 'launched', id: s.launched.id };
  if (s.folder.t === 'changed') return { t: 'changed', why: s.folder.why };
  return s.mode.t === 'read-only' ? { t: 'read-only', why: s.mode.why } : { t: 'ready' };
}

const money = (usd: number) => `$${usd.toFixed(2)}`;

/** The grants a harness only advises, called out: the owner must not read "no web" as enforced. */
function Advisory({ access }: { access: readonly keyed.TurnAccess[] }) {
  const lines = access.flatMap((a) => {
    const g = keyed.advisoryGrants(a);
    return g.t === 'unknown'
      ? [`${a.label}: harness unknown (${g.why})`]
      : g.advisory.map((x) => `${a.label} (${g.provider}) ${x}`);
  });
  return lines.length === 0 ? null : (
    <section className="keyed-expedition-need ui-stack" aria-label="Limits not enforced">
      <strong>Only advised, not enforced</strong>
      <ul className="expedition-notes">
        {lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
    </section>
  );
}

type Foot<K extends Standing['t']> = (
  s: Extract<Standing, { t: K }>,
  p: keyed.KeyedProposal,
  launch: ReturnType<typeof useKeyedWrite>,
  listed: ReadonlySet<string>
) => ReactNode;
const FOOT: { readonly [K in Standing['t']]: Foot<K> } = {
  checking: () => <span className="ui-muted">Checking the folder…</span>,
  unreadable: (s) => <span className="ui-muted">{s.why}</span>,
  launched: (s, p, _launch, listed) =>
    listed.has(s.id) ? (
      <Link
        className="expedition-button"
        to={channelsHref(p.workspaceId, { kind: 'keyed', id: s.id })}
      >
        Open the expedition
      </Link>
    ) : (
      <span className="ui-muted">Launched as {s.id}</span>
    ),
  changed: (s) => (
    <span className="ui-muted">Superseded: {s.why}. Ask the Buddy to propose it again.</span>
  ),
  'read-only': (s) => <span className="ui-muted">Cannot launch: {s.why}</span>,
  ready: (_s, p, launch) => (
    <>
      <Confirm
        label="Launch"
        sure={`Confirm launch (up to ${money(p.preview.budget.usd)})`}
        run={() =>
          launch.run(() =>
            buddyWrite(
              'keyed.launch',
              {},
              { workspaceId: p.workspaceId, folder: p.folder, digest: p.digest }
            )
          )
        }
      />
      {launch.state.t === 'failed' && (
        <span className="expedition-error" role="alert">
          {launch.state.error}
        </span>
      )}
    </>
  ),
};

export function ProposalCard({ proposal }: { proposal: keyed.KeyedProposal }) {
  const status = usePolledFetch<keyed.KeyedProposalStatus>(proposalUrl(proposal), 10_000);
  const rows = useKeyedRows(proposal.workspaceId);
  const launch = useKeyedWrite();
  const p = proposal.preview;
  const standing = standingOf(status);
  const listed = new Set(rows.map((r) => r.id));
  return (
    <div className="expedition-card ui-stack" data-standing={standing.t}>
      <strong>⛺ {p.goal.split('\n')[0]}</strong>
      <span className="ui-muted">
        Budget {money(p.budget.usd)} / {p.budget.hours} h · leader {p.leader}
      </span>
      <span>
        First wave: {p.firstWave.length} {p.firstWave.length === 1 ? 'call' : 'calls'}, up to{' '}
        {money(p.costUsd)}
      </span>
      <ul className="expedition-notes" aria-label="First wave">
        {p.firstWave.map((c) => (
          <li key={c.key}>
            {c.key} · {c.who} · {money(c.reservedUsd)}
          </li>
        ))}
      </ul>
      <Advisory access={p.access} />
      <div className="expedition-manage ui-row">
        {(FOOT[standing.t] as Foot<Standing['t']>)(standing, proposal, launch, listed)}
      </div>
    </div>
  );
}
