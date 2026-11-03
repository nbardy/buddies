import {
  ALLOWED,
  type Act,
  type Done,
  type Expedition,
  attemptResult,
  stateLabel,
} from '@unleashd/shared';
import { useMemo, useState } from 'react';
import { ChannelMarkdown } from './ChannelMarkdown';
import { ActButton as Button } from './ExpeditionCard';
import { ModalDialog } from './ModalDialog';
import { useWorkspaceDirectory } from './channel-data';
import { useAct, useExpedition } from './expedition-api';
import './Expedition.css';

/** The expedition modal: charter, attempts and the owner's controls, rendered from ALLOWED. */
export function ExpeditionModal({ id, onClose }: { id: string; onClose(): void }) {
  const read = useExpedition(id, 5_000);
  return (
    <ModalDialog
      className="channel-task-overlay ui-card ui-stack expedition-modal"
      label="Expedition"
      onClose={onClose}
    >
      <header className="channel-task-overlay-header ui-row expedition-modal-header">
        <h2 className="ui-truncate">⛺ {read.data?.charter.name ?? id}</h2>
        <button type="button" onClick={onClose} aria-label="Close expedition" title="Close (Esc)">
          ✕
        </button>
      </header>
      {read.data === null ? (
        <p className="ui-muted">{read.kind === 'failed' ? read.error.message : 'Loading…'}</p>
      ) : (
        <Body x={read.data} />
      )}
    </ModalDialog>
  );
}

const DONE: { [K in Done['t']]: (d: Extract<Done, { t: K }>) => string } = {
  checks: (d) => `${d.checks.map((argv) => `\`${argv.join(' ')}\``).join(', ')} pass`,
  owner: () => 'you judge',
};

function Body({ x }: { x: Expedition }) {
  const directory = useWorkspaceDirectory(x.workspaceId);
  const goal = useMemo(() => ({ t: 'text' as const, text: x.charter.goal }), [x.charter.goal]);
  const done = x.charter.done;
  const deadline = 'launch' in x.state ? new Date(x.state.launch.deadline).toLocaleString() : '';
  return (
    <div className="expedition-modal-body ui-stack">
      <p className="ui-row">
        <span className="expedition-pill" data-state={x.state.t}>
          {stateLabel(x)}
        </span>
        {deadline && <span className="ui-muted">deadline {deadline}</span>}
      </p>
      <div className="file-preview-markdown expedition-markdown">
        <ChannelMarkdown body={goal} buddyNames={directory.buddyNames} tasks={directory.taskById} />
      </div>
      <p>
        <strong>Done when: </strong>
        {DONE[done.t](done as never)}
      </p>
      {x.state.t === 'draft' && <p className="expedition-issues">{x.state.issues.join(' · ')}</p>}
      <Attempts x={x} />
      <Controls x={x} />
    </div>
  );
}

function Attempts({ x }: { x: Expedition }) {
  const act = useAct(x.id);
  if (x.attempts.length === 0) return null;
  return (
    <table className="expedition-attempts">
      <tbody>
        {x.attempts.map((a) => {
          const p = a.phase;
          const lesson = 'end' in p && p.end.lesson.t === 'lesson' ? p.end.lesson.text : '';
          return (
            <tr key={a.n}>
              <td>a{a.n}</td>
              <td>{attemptResult(a, x.charter.done)}</td>
              <td>{lesson}</td>
              <td className="ui-muted">{a.branch}</td>
              <td>
                {x.charter.done.t === 'owner' && p.t === 'judging' && (
                  <span className="ui-row">
                    <Button label="Pass" act={act} send={{ do: 'verdict', n: a.n, pass: true }} />
                    <Button label="Fail" act={act} send={{ do: 'verdict', n: a.n, pass: false }} />
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const SIMPLE = ['launch', 'pause', 'resume', 'stop'] as const;

function Controls({ x }: { x: Expedition }) {
  const act = useAct(x.id);
  const [hours, setHours] = useState(2);
  const [confirm, setConfirm] = useState(false);
  const allowed = (d: Act['do']) => ALLOWED[d].includes(x.state.t);
  return (
    <footer className="expedition-controls ui-row">
      {SIMPLE.filter(allowed).map((d) => (
        <Button key={d} label={d[0].toUpperCase() + d.slice(1)} act={act} send={{ do: d }} />
      ))}
      {allowed('extend') && (
        <span className="ui-row">
          <input
            type="number"
            min={1}
            max={72}
            value={hours}
            aria-label="Hours to extend"
            onChange={(e) => setHours(Number(e.target.value))}
          />
          <Button label="Extend" act={act} send={{ do: 'extend', hours }} />
        </span>
      )}
      {allowed('retire') &&
        (confirm ? (
          <Button label="Confirm retire" act={act} send={{ do: 'retire' }} />
        ) : (
          <button type="button" className="expedition-button" onClick={() => setConfirm(true)}>
            Retire
          </button>
        ))}
      {act.state.t === 'failed' && <span className="expedition-error">{act.state.error}</span>}
    </footer>
  );
}
