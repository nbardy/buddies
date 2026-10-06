import { WAKE_MESSAGE } from '@unleashd/shared';
/**
 * client/src/components/buddies/BuddyPage.tsx
 *
 * One Buddy's page at /buddies/:buddyId/:tab — the ONE view both trees mount
 * (desktop BuddiesDashboard, mobile BuddyDetailMobile). The caller picks the
 * `layout` variant and owns navigation (mobile threads its route state into
 * `openConversation`); nothing here asks which device it is on. Tab bodies are
 * BuddyTabContent; the layout variant only changes CSS and the nav's labels.
 */
import { useAtomValue } from 'jotai';
import { useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { archivedBuddyIdsAtom } from '../../atoms/buddy-visibility';
import { useBuddyPage } from '../../hooks/useBuddyData';
import type { UsePolledFetchResult } from '../../hooks/usePolledFetch';
import { BuddyAbout } from './BuddyAboutCard';
import { BuddySectionNav } from './BuddySectionNav';
import { BuddyTabContent } from './BuddyTabContent';
import { buddyWrite, errorText, postToBuddyDm } from './api';
import { buddyTabPath, parseEmployeeTab } from './buddy-tabs';
import { directReportsOf, findBuddy } from './roster';
import type { Buddy, BuddyOverview } from './types';
import { initials } from './ui-contract';

/** `wide`: the desktop page scroller. `narrow`: a column inside the mobile shell. */
export type BuddyPageLayout = 'wide' | 'narrow';

/** Only a read that never loaded replaces the page; a failed refresh is a notice beside it. */
export function RefreshNotice({ read }: { read: UsePolledFetchResult<unknown> }) {
  return read.kind === 'stale' ? (
    <p className="ui-muted">
      <output>Could not refresh: {read.error.message}</output>{' '}
      <button type="button" onClick={read.refetch}>
        Retry
      </button>
    </p>
  ) : null;
}

export function BuddyPage({
  buddyId,
  layout,
  openConversation,
}: {
  buddyId: string;
  layout: BuddyPageLayout;
  openConversation: (conversationId: string) => void;
}) {
  const { tab: tabSegment } = useParams<{ tab: string }>();
  const archived = useAtomValue(archivedBuddyIdsAtom);
  const { detail, overview, workspace, talk } = useBuddyPage(buddyId, openConversation);
  // The tab is the URL, not state (buddy-tabs.ts).
  const tab = parseEmployeeTab(tabSegment);
  const frame = `buddy-page buddy-page--${layout}`;

  if (archived.has(buddyId)) return <Navigate to="/buddies" replace />;
  // Canonicalise `/buddies/:id` (and any junk tab segment) onto a real tab URL;
  // `replace` keeps Back pointing at whatever linked here.
  if (tab === null) return <Navigate to={buddyTabPath(buddyId, 'conversations')} replace />;
  // A failed background refresh is `stale` and keeps the page (notice in the
  // hero). Until 2026-09-25 mobile tested the refresh's error before the data,
  // and one "Failed to fetch" replaced a loaded page with "Could not load buddy".
  const failed =
    detail.kind === 'failed' ? detail.error : overview.kind === 'failed' ? overview.error : null;
  if (failed) return <PageFailed frame={frame} message={failed.message} />;
  if (detail.data === null || overview.data === null)
    return (
      <div className={frame} aria-live="polite" aria-busy="true">
        <p className="buddy-page__status">Loading Buddy…</p>
      </div>
    );
  const { buddy } = detail.data;
  if (workspace === null)
    return (
      <PageFailed
        frame={frame}
        message={`Workspace ${buddy.workspaceId} is not in the Buddy overview.`}
      />
    );

  return (
    <div className={frame}>
      <header className="buddy-page__hero">
        <Link to="/buddies" className="buddy-page__back ui-inline-row" aria-label="Back to Buddies">
          ← Buddies
        </Link>
        <div className="buddy-page__main">
          <div className="buddy-page__identity">
            <span className="buddy-page__avatar" aria-hidden="true">
              {initials(buddy.name)}
            </span>
            <div className="buddy-page__copy">
              <div className="buddy-page__title ui-row">
                <h1>{buddy.name}</h1>
                <span>{buddy.status}</span>
              </div>
              <BuddyAbout
                buddyId={buddy.id}
                name={buddy.name}
                role={buddy.role}
                facts={[buddy.model ?? 'Default model']}
              >
                <BuddyRelations buddy={buddy} overview={overview.data} />
              </BuddyAbout>
              <RefreshNotice read={detail} />
            </div>
          </div>
          <BuddyPageActions buddy={buddy} talk={talk} openConversation={openConversation} />
        </div>
        <BuddySectionNav buddyId={buddy.id} activeTab={tab} layout={layout} />
      </header>
      <div className="buddy-page__content">
        <BuddyTabContent
          tab={tab}
          page={{
            detail: detail.data,
            overview: overview.data,
            workspace,
            talk,
            refresh: detail.refetch,
          }}
        />
      </div>
    </div>
  );
}

function PageFailed({ frame, message }: { frame: string; message: string }) {
  return (
    <div className={frame} role="alert">
      <p className="buddy-page__status">
        <strong>Could not load buddy</strong>
        <span>{message}</span>
        <Link to="/buddies">Back to Buddies</Link>
      </p>
    </div>
  );
}

/** Who the Buddy reports to and who reports to it, as links. */
function BuddyRelations({ buddy, overview }: { buddy: Buddy; overview: BuddyOverview }) {
  const manager = buddy.managerId === undefined ? undefined : findBuddy(overview, buddy.managerId);
  const reports = directReportsOf(overview, buddy.id);
  return (
    <div className="buddy-relations">
      <span>
        Reports to{' '}
        {manager ? (
          <Link to={`/buddies/${encodeURIComponent(manager.id)}`}>{manager.name}</Link>
        ) : (
          <strong>you</strong>
        )}
      </span>
      {reports.length > 0 && (
        <span className="buddy-relations__reports">
          {reports.length === 1 ? '1 report:' : `${reports.length} reports:`}
          {reports.map((report) => (
            <Link key={report.id} to={`/buddies/${encodeURIComponent(report.id)}`}>
              {report.name}
            </Link>
          ))}
        </span>
      )}
    </div>
  );
}

type DirectAction = { kind: 'idle' } | { kind: 'pending' } | { kind: 'done'; message: string };

/**
 * Start a new chat, open the owner's ongoing chat with the Buddy (`/direct`),
 * or wake it (a DM post of WAKE_MESSAGE). Buttons, not links:
 * the click creates or resolves the thread, so there is no id for an href yet.
 */
function BuddyPageActions({
  buddy,
  talk,
  openConversation,
}: {
  buddy: Buddy;
  talk: () => void;
  openConversation: (conversationId: string) => void;
}) {
  const [state, setState] = useState<DirectAction>({ kind: 'idle' });
  const request = (write: () => Promise<string | null>) => {
    setState({ kind: 'pending' });
    write()
      .then((message) => setState(message === null ? { kind: 'idle' } : { kind: 'done', message }))
      .catch((cause) => setState({ kind: 'done', message: errorText(cause) }));
  };
  const pending = state.kind === 'pending';
  return (
    <div className="buddy-page-actions">
      <button type="button" disabled={pending} onClick={talk}>
        Start conversation
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          request(async () => {
            openConversation(
              (await buddyWrite('direct.open', { buddyId: buddy.id })).conversationId
            );
            return null;
          })
        }
      >
        Chat
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          request(async () => {
            await postToBuddyDm(buddy.id, { body: WAKE_MESSAGE });
            return `${buddy.name} is catching up; its summary lands in your DM.`;
          })
        }
      >
        Wake
      </button>
      {state.kind === 'done' && <output>{state.message}</output>}
    </div>
  );
}
