/**
 * client/src/components/buddies/BuddyTabContent.tsx
 *
 * Everything below a Buddy page's hero (BuddyPage.tsx, mounted by both trees).
 * Each tab is one handler here.
 */
import type { ReactElement } from 'react';
import { BuddyBackgroundTasks } from './BuddyBackgroundTasks';
import { BuddyConversationList } from './BuddyConversationList';
import { BuddyMemory, BuddyMemoryDoc } from './BuddyMemory';
import { BuddyMessages } from './BuddyMessages';
import { BuddySchedules } from './BuddySchedules';
import { BuddySettings } from './BuddySettings';
import { BuddyWork } from './BuddyWork';
import './ChannelLanding.css';
import { buddyNamesOf, isActive } from './roster';
import type { BuddyDetail, BuddyOverview, EmployeeTab, Task, WorkspaceRoster } from './types';
import { taskStatusView } from './ui-contract';

/** What every tab reads: the detail bundle, the overview it names people from, and actions. */
export interface BuddyPageModel {
  detail: BuddyDetail;
  overview: BuddyOverview;
  workspace: WorkspaceRoster;
  talk: () => void;
  refresh: () => Promise<void>;
}

const TABS: { [K in EmployeeTab]: (page: BuddyPageModel) => ReactElement } = {
  conversations: (page) => (
    <section className="buddy-panel" aria-label="Conversations">
      <div className="buddy-panel__title ui-row">
        <h2>Conversations</h2>
        <button type="button" onClick={page.talk}>
          Start conversation
        </button>
      </div>
      <BuddyConversationList buddyId={page.detail.buddy.id} />
    </section>
  ),
  work: (page) => (
    <BuddyWork
      buddyId={page.detail.buddy.id}
      tasks={page.detail.tasks}
      names={buddyNamesOf(page.overview)}
      refresh={page.refresh}
    />
  ),
  mailbox: (page) => (
    <BuddyMessages
      buddyId={page.detail.buddy.id}
      workspaceId={page.detail.buddy.workspaceId}
      names={buddyNamesOf(page.overview)}
    />
  ),
  background: (page) => (
    <BuddyBackgroundTasks
      buddyId={page.detail.buddy.id}
      runs={page.detail.runs}
      refresh={page.refresh}
    />
  ),
  memory: (page) => (
    <BuddyMemory buddyId={page.detail.buddy.id} workspaceId={page.detail.buddy.workspaceId} />
  ),
  'working-memory': (page) => <BuddyMemoryDoc buddyId={page.detail.buddy.id} kind="working" />,
  'long-term-memory': (page) => <BuddyMemoryDoc buddyId={page.detail.buddy.id} kind="long_term" />,
  'recent-tasks': (page) => <RecentTasks tasks={page.detail.tasks} />,
  schedules: (page) => (
    <BuddySchedules
      buddyId={page.detail.buddy.id}
      schedules={page.detail.schedules}
      runs={page.detail.runs}
      refresh={page.refresh}
    />
  ),
  settings: (page) => (
    <BuddySettings
      buddy={page.detail.buddy}
      managers={page.workspace.buddies.filter(
        (candidate) => isActive(candidate) && candidate.id !== page.detail.buddy.id
      )}
      refresh={page.refresh}
    />
  ),
};

/** A quick activity read: titles and status only, from the Buddy's existing task read. */
function RecentTasks({ tasks }: { tasks: readonly Task[] }) {
  const recent = [...tasks]
    .filter((task) => task.parentId === undefined && task.status !== 'cancelled')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 20);
  return (
    <section className="buddy-panel" aria-label="Recent tasks">
      <div className="buddy-panel__title ui-row">
        <h2>Recent tasks</h2>
      </div>
      {recent.length === 0 ? (
        <p className="buddy-panel__empty">No tasks yet.</p>
      ) : (
        <ul className="buddy-post-list">
          {recent.map((task) => (
            <li key={task.id} className="buddy-panel__title ui-row">
              <span>{task.title}</span>
              <small className="ui-muted">{taskStatusView(task.status).label}</small>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Thin dispatcher: one handler per tab, exhaustive by the mapped type. */
export function BuddyTabContent({ tab, page }: { tab: EmployeeTab; page: BuddyPageModel }) {
  return TABS[tab](page);
}
