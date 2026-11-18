import type { ExpeditionQuestion, ExpeditionView as View } from '@unleashd/shared';
import { useAtomValue } from 'jotai';
import { useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  connectionAtom,
  groupsFamily,
  listField,
  loadCompleteOf,
  rowFamily,
} from '../../atoms/conversations';
import { useConversationBodies } from '../../hooks/useConversationBodies';
import { usePolledFetch } from '../../hooks/usePolledFetch';
import { TranscriptGroup } from '../../views/transcript/TranscriptGroup';
import { buddyWrite } from './api';
import { ChannelLoader } from './ChannelLoader';
import { useFollowBottom } from './channel-data';
import { channelsHref } from './channels-view';
import './BuddyDetail.css';
import { ExpeditionDiscussion } from './ExpeditionDiscussion';
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
export function ExpeditionContent({ view }: { view: View }) {
  const ids = useAtomValue(listField('idSet'));
  return (
    <article className="expedition ui-stack">
      {view.steps.length === 0 && <p className="ui-muted">No attempts yet.</p>}
      <ol className="expedition-steps ui-stack">
        {view.steps.map((s) => (
          <li key={`${s.key}:${s.hash}`} className="expedition-step ui-stack">
            <div className="expedition-step-heading ui-row">
              <strong>{s.key}</strong>
              <span className="expedition-status">{s.state}</span>
            </div>
            <span className="ui-muted">
              {s.who} · ${s.cost.toFixed(4)}
            </span>
            {s.why && <p className="expedition-step-reason">{s.why}</p>}
            {s.commit && <code className="expedition-commit">Commit {s.commit}</code>}
            {s.conversationId &&
              (ids.has(s.conversationId) ? (
                // Step turns use chat records. Opening /chat left the workspace and exposed
                // the chat composer. Guard: the step transcript stays in Channels.
                <Link
                  to={channelsHref(view.workspaceId, {
                    kind: 'expedition',
                    id: view.id,
                    conversationId: s.conversationId,
                  })}
                >
                  Open conversation
                </Link>
              ) : (
                <span className="ui-muted">Conversation {s.conversationId}</span>
              ))}
          </li>
        ))}
      </ol>
    </article>
  );
}

const EXPEDITION_TABS = ['Chat', 'Attempts', 'Goal', 'Details'] as const;
type ExpeditionTab = (typeof EXPEDITION_TABS)[number];

type PanelProps = {
  view: View;
  refresh(): Promise<void>;
  frame: 'desktop' | 'mobile';
};

const EXPEDITION_PANELS = {
  Chat: ({ view, refresh, frame }: PanelProps) => (
    <>
      {view.questions.length > 0 && (
        <div className="expedition-questions ui-stack">
          {view.questions.map((q) => (
            <Question key={q.key} id={view.id} question={q} refresh={refresh} />
          ))}
        </div>
      )}
      <ExpeditionDiscussion key={view.id} expedition={view} refresh={refresh} frame={frame} />
    </>
  ),
  Attempts: ({ view }: PanelProps) => <ExpeditionContent view={view} />,
  Goal: ({ view }: PanelProps) => <p className="expedition expedition-goal">{view.goal}</p>,
  Details: ({ view }: PanelProps) => (
    <article className="expedition ui-stack">
      <p className="expedition-budget ui-muted">
        ${view.spend.toFixed(4)} spent · ${view.reserved.toFixed(2)} reserved · $
        {view.budget.usd.toFixed(2)} budget · {view.budget.hours} hours
      </p>
      {view.reason && <p>{view.reason}</p>}
      <p className="ui-muted">Plan versions: {view.versions.map((n) => `v${n}`).join(', ')}</p>
    </article>
  ),
} satisfies Record<ExpeditionTab, (props: PanelProps) => React.ReactNode>;
const EXPEDITION_HEADERS = {
  desktop: {
    pane: 'channel-browser-pane',
    header: 'channel-browser-pane-header',
    heading: 'expedition-header-title',
    backClass: 'expedition-back',
    back: '← Channels',
  },
  mobile: {
    pane: 'mobile-channel',
    header: 'mobile-channel-header',
    heading: 'mobile-channel-header__heading expedition-header-title',
    backClass: 'mobile-channel-header__back',
    back: '‹',
  },
} as const;

function StepTranscript({
  conversationId,
  frame,
}: {
  conversationId: string;
  frame: 'desktop' | 'mobile';
}) {
  const row = useAtomValue(rowFamily(conversationId));
  const groups = useAtomValue(groupsFamily(conversationId));
  const listLoaded = loadCompleteOf(useAtomValue(connectionAtom).server);
  const { loaded, error } = useConversationBodies(conversationId);
  const lastMessageRef = useRef<HTMLDivElement>(null);
  const follow = useFollowBottom(groups.length, groups, null);
  return (
    <div
      className="expedition-scroll ui-scroll-quiet"
      ref={follow.scrollRef}
      onScroll={follow.onScroll}
    >
      {!row && listLoaded ? (
        <p>Conversation unavailable.</p>
      ) : error ? (
        <p role="alert">{error}</p>
      ) : !row || !loaded ? (
        <ChannelLoader label="Loading conversation…" />
      ) : !groups.length ? (
        <p>No messages yet.</p>
      ) : (
        <section
          className="expedition ui-stack"
          aria-label="Step transcript"
          ref={follow.contentRef}
        >
          {groups.map((group, index) => (
            <TranscriptGroup
              key={group.firstMessageIndex}
              group={group}
              isLastGroup={index === groups.length - 1}
              isLiveTurn={row.run !== 'idle'}
              lastMessageRef={lastMessageRef}
              presentation={frame === 'mobile' ? 'footer' : 'hover'}
              workingDirectory={row.cwd}
            />
          ))}
        </section>
      )}
    </div>
  );
}

export function ExpeditionView({
  id,
  conversationId,
  workspaceId,
  frame,
}: {
  id: string;
  conversationId?: string;
  workspaceId: string;
  frame: 'desktop' | 'mobile';
}) {
  const read = usePolledFetch<View>(`/api/buddies/expeditions/${encodeURIComponent(id)}`, 1000);
  const params = new URLSearchParams(useLocation().search);
  const tab = EXPEDITION_TABS.find((t) => t.toLowerCase() === params.get('tab')) ?? 'Chat';
  const Panel = EXPEDITION_PANELS[tab];
  const header = EXPEDITION_HEADERS[frame];
  const needsOwner = read.data?.questions.some((q) => q.kind !== 'manager') ?? false;
  const step = conversationId
    ? read.data?.steps.find((s) => s.conversationId === conversationId)
    : undefined;
  const title = step?.key || read.data?.goal.split('\n')[0] || 'Expedition';
  const backLabel = conversationId ? 'Back to expedition' : 'Back to Channels';
  const runHref = channelsHref(workspaceId, { kind: 'expedition', id });
  const back = conversationId
    ? `${runHref}&tab=attempts`
    : channelsHref(workspaceId, { kind: 'home' });
  return (
    <section className={`${header.pane} ui-stack`}>
      <header className={`${header.header} expedition-header ui-row`}>
        <Link className={header.backClass} to={back} aria-label={backLabel}>
          {conversationId && frame === 'desktop' ? '← Expedition' : header.back}
        </Link>
        <div className={header.heading}>
          <h1 className="ui-truncate" title={title}>
            {title}
          </h1>
        </div>
        {read.data &&
          !conversationId &&
          (needsOwner ? (
            <Link className="expedition-status" data-alert to={runHref}>
              Needs you
            </Link>
          ) : (
            <span className="expedition-status">{read.data.status}</span>
          ))}
      </header>
      {!conversationId && (
        <nav className="buddy-detail-nav expedition-tabs" aria-label="Expedition views">
          {EXPEDITION_TABS.map((item) => (
            <Link
              key={item}
              to={item === 'Chat' ? runHref : `${runHref}&tab=${item.toLowerCase()}`}
              aria-current={item === tab ? 'page' : undefined}
            >
              {item}
            </Link>
          ))}
        </nav>
      )}
      {conversationId && step ? (
        <StepTranscript key={conversationId} conversationId={conversationId} frame={frame} />
      ) : (
        <div
          className={
            !conversationId && tab === 'Chat' && read.data
              ? 'expedition-chat ui-stack'
              : 'expedition-scroll ui-scroll-quiet'
          }
        >
          {read.data && conversationId ? (
            <p>Conversation unavailable.</p>
          ) : read.data ? (
            <Panel view={read.data} refresh={read.refetch} frame={frame} />
          ) : read.kind === 'failed' ? (
            <p role="alert">{read.error.message}</p>
          ) : (
            <ChannelLoader label="Loading expedition…" />
          )}
        </div>
      )}
    </section>
  );
}
