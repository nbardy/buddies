import type { ExpeditionProposal } from '@unleashd/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { buddyWrite } from './api';
import { channelsHref } from './channels-view';
import './Expedition.css';

export function ProposalCard({ proposal: p }: { proposal: ExpeditionProposal }) {
  const [id, setId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const launch = async () => {
    setBusy(true);
    setError('');
    try {
      const result = await buddyWrite(
        'expedition.launch',
        {},
        { file: p.file, hash: p.hash, workspaceId: p.workspaceId }
      );
      setId(result.id);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="expedition-proposal ui-stack" aria-label="Proposed expedition">
      <h3>{p.preview.goal.split('\n')[0]}</h3>
      <p>
        Budget ${p.preview.budget.usd} · {p.preview.budget.hours} hours
      </p>
      <p>
        First wave: {p.preview.firstWave.length} steps, up to ${p.preview.costUsd.toFixed(2)}
      </p>
      <details>
        <summary>Plan and resolved limits</summary>
        <p>{p.preview.goal}</p>
        <p>Manager: {p.preview.leader}</p>
        <ul>
          {p.preview.defaults.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p>
          Codex cannot enforce read roots, helper exclusion, shell-off intent or exclusion of global
          instructions. Claude checkout shell reads are advisory. Agents are told these limits.
        </p>
        <code className="expedition-commit">{p.file}</code>
      </details>
      {id ? (
        <Link to={channelsHref(p.workspaceId, { kind: 'expedition', id })}>Open expedition</Link>
      ) : (
        <button type="button" disabled={busy} onClick={() => void launch()}>
          {busy ? 'Checking plan…' : 'Launch expedition'}
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
