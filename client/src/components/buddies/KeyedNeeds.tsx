import type { keyed } from '@unleashd/shared';
import { type ReactNode, useState } from 'react';
import { buddyWrite } from './api';
import { useKeyedWrite } from './keyed-api';
import { diffLine } from './keyed-timeline';
import './KeyedExpedition.css';

// What waits on the owner: unanswered asks (text or yes/no) and a rewrite that needs approval.
// Both sit above the Timeline; each write is one `buddyWrite('keyed.*')` and a refusal's reason
// shows beside its buttons.

function Failed({ state }: { state: ReturnType<typeof useKeyedWrite>['state'] }) {
  return state.t === 'failed' ? (
    <span className="expedition-error" role="alert">
      {state.error}
    </span>
  ) : null;
}

const Button = ({
  children,
  tone,
  disabled,
  onClick,
}: {
  children: ReactNode;
  tone?: 'primary';
  disabled: boolean;
  onClick(): void;
}) => (
  <button
    type="button"
    className="expedition-button"
    data-tone={tone}
    disabled={disabled}
    onClick={onClick}
  >
    {children}
  </button>
);

/** What the question's ref holds: the candidate's summary (a line per span, so it wraps inside the
 * card without a pre-formatted block) and where its full answer is. Nothing for an ordinary ask. */
const ABOUT: {
  [K in keyed.AskAbout['t']]: (a: Extract<keyed.AskAbout, { t: K }>) => ReactNode;
} = {
  nothing: () => null,
  candidate: (a) => (
    <>
      {a.summary.split('\n').map((line, i) => (
        <span key={i}>{line}</span>
      ))}
      <span className="ui-muted">Full answer: {a.answerPath}</span>
    </>
  ),
};

/** A text ask takes an answer; a confirm ask takes Yes or No. */
function Ask({ id, ask }: { id: string; ask: keyed.PendingAsk }) {
  const [text, setText] = useState('');
  const write = useKeyedWrite();
  const busy = write.state.t === 'pending';
  const send = (body: { answer: string } | { confirm: boolean }) =>
    write.run(() => buddyWrite('keyed.answer', { id, ref: ask.ref }, body));
  const CONTROL: { [K in keyed.PendingAsk['answer']]: () => ReactNode } = {
    text: () => (
      <>
        <textarea
          className="keyed-expedition-answer"
          aria-label={`Answer: ${ask.question}`}
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Button
          tone="primary"
          disabled={busy || text.trim() === ''}
          onClick={() => send({ answer: text.trim() })}
        >
          Send answer
        </Button>
      </>
    ),
    confirm: () => (
      <>
        <Button tone="primary" disabled={busy} onClick={() => send({ confirm: true })}>
          Yes
        </Button>
        <Button disabled={busy} onClick={() => send({ confirm: false })}>
          No
        </Button>
      </>
    ),
  };
  return (
    <div className="keyed-expedition-need ui-stack">
      <strong>{ask.question}</strong>
      {ABOUT[ask.about.t](ask.about as never)}
      <span className="ui-muted">{ask.key}</span>
      <div className="expedition-manage ui-row">
        {CONTROL[ask.answer]()}
        <Failed state={write.state} />
      </div>
    </div>
  );
}

export function KeyedAsks({ id, asks }: { id: string; asks: readonly keyed.PendingAsk[] }) {
  return asks.length === 0 ? null : (
    <section className="ui-stack" aria-label="Waiting on you">
      {asks.map((ask) => (
        <Ask key={ask.ref} id={id} ask={ask} />
      ))}
    </section>
  );
}

function Approval({
  id,
  approval,
}: {
  id: string;
  approval: Extract<keyed.PendingApproval, { t: 'pending' }>;
}) {
  const write = useKeyedWrite();
  const busy = write.state.t === 'pending';
  const send = (approve: boolean) =>
    write.run(() => buddyWrite('keyed.approval', { id }, { approve }));
  return (
    <section className="keyed-expedition-need ui-stack" aria-label="Plan awaiting approval">
      <strong>The leader wants to change the plan</strong>
      <span>{approval.why}</span>
      <span className="ui-muted">{diffLine(approval.diff)}</span>
      {approval.reasons.length > 0 && (
        <ul className="expedition-notes">
          {approval.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      <div className="expedition-manage ui-row">
        <Button tone="primary" disabled={busy} onClick={() => send(true)}>
          Approve
        </Button>
        <Button disabled={busy} onClick={() => send(false)}>
          Decline
        </Button>
        <Failed state={write.state} />
      </div>
    </section>
  );
}

const APPROVAL: {
  [K in keyed.PendingApproval['t']]: (
    id: string,
    a: Extract<keyed.PendingApproval, { t: K }>
  ) => ReactNode;
} = {
  none: () => null,
  pending: (id, a) => <Approval id={id} approval={a} />,
};
export const KeyedApproval = ({ id, approval }: { id: string; approval: keyed.PendingApproval }) =>
  APPROVAL[approval.t](id, approval as never);
