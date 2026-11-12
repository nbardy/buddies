import type { ExpeditionQuestion, ExpeditionView as View } from '@unleashd/shared';
import { useAtomValue } from 'jotai';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { listField } from '../../atoms/conversations';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { buddyWrite } from './api';
import { channelsHref } from './channels-view';
import './Expedition.css';

function Question({
  id,
  question,
  refresh,
}: {
  id: string;
  question: ExpeditionQuestion;
  refresh(): Promise<void>;
}) {
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (value: string | boolean) => {
    setBusy(true);
    setError('');
    try {
      await buddyWrite('expedition.answer', { id }, { key: question.key, value });
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="expedition-question ui-stack">
      <strong>{question.question}</strong>
      {question.kind === 'manager' ? (
        <p className="ui-muted">Waiting for the manager Buddy.</p>
      ) : question.kind === 'confirm' ? (
        <div className="ui-row">
          <button type="button" disabled={busy} onClick={() => void submit(true)}>
            Yes
          </button>
          <button type="button" disabled={busy} onClick={() => void submit(false)}>
            No
          </button>
        </div>
      ) : (
        <form
          className="ui-stack"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(answer);
          }}
        >
          <textarea
            aria-label="Your answer"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
          />
          <button type="submit" disabled={busy}>
            Send answer
          </button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
export function ExpeditionContent({ view, refresh }: { view: View; refresh(): Promise<void> }) {
  const ids = useAtomValue(listField('idSet'));
  const [title, ...body] = view.goal.split('\n');
  return (
    <article className="expedition ui-stack">
      <header className="ui-stack">
        <span className="ui-muted">Expedition · {view.status}</span>
        <h2>{title}</h2>
        <p className="expedition-budget">
          ${view.spend.toFixed(4)} spent · ${view.reserved.toFixed(2)} reserved · $
          {view.budget.usd.toFixed(2)} budget · {view.budget.hours} hours
        </p>
      </header>
      {body.length > 0 && <p className="expedition-goal">{body.join('\n')}</p>}
      {view.reason && <p>{view.reason}</p>}
      {view.questions.map((q) => (
        <Question key={q.key} id={view.id} question={q} refresh={refresh} />
      ))}
      <ol className="expedition-steps ui-stack">
        {view.steps.map((s) => (
          <li key={`${s.key}:${s.hash}`} className="expedition-step ui-stack">
            <div className="ui-row">
              <strong>{s.key}</strong>
              <span>{s.state}</span>
            </div>
            <span className="ui-muted">
              {s.who} · ${s.cost.toFixed(4)}
            </span>
            {s.why && <p>{s.why}</p>}
            {s.commit && <code className="expedition-commit">Commit {s.commit}</code>}
            {s.conversationId &&
              (ids.has(s.conversationId) ? (
                <Link to={`/chat/${s.conversationId}`}>Open conversation</Link>
              ) : (
                <span className="ui-muted">Conversation {s.conversationId}</span>
              ))}
          </li>
        ))}
      </ol>
      <footer className="ui-muted">
        Plan versions: {view.versions.map((n) => `v${n}`).join(', ')}
      </footer>
    </article>
  );
}
export function ExpeditionView({
  id,
  workspaceId,
  frame: _frame,
}: {
  id: string;
  workspaceId: string;
  frame: 'desktop' | 'mobile';
}) {
  const read = usePolledFetch<View>(`/api/buddies/expeditions/${encodeURIComponent(id)}`, 1000);
  return (
    <div className="expedition-scroll ui-scroll-quiet">
      <Link to={channelsHref(workspaceId, { kind: 'home' })}>← Channels</Link>
      {read.data ? (
        <ExpeditionContent view={read.data} refresh={read.refetch} />
      ) : (
        <p>{read.kind === 'failed' ? read.error.message : 'Loading expedition…'}</p>
      )}
    </div>
  );
}
