import { Link } from 'react-router-dom';
import type { BuddyPageLayout } from './BuddyPage';
import {
  EMPLOYEE_TABS,
  EMPLOYEE_TAB_LABELS,
  EMPLOYEE_TAB_LABELS_SHORT,
  buddyTabPath,
} from './buddy-tabs';
import type { EmployeeTab } from './types';

const WIDE_PRIMARY: EmployeeTab[] = [
  'conversations',
  'mailbox',
  'recent-tasks',
  'working-memory',
  'long-term-memory',
  'settings',
];
const NARROW_PRIMARY: EmployeeTab[] = ['conversations', 'recent-tasks', 'settings'];
/** The "More" summary names the open secondary tab; a narrow column gets the short name. */
const SUMMARY_LABELS: Record<BuddyPageLayout, Record<EmployeeTab, string>> = {
  wide: EMPLOYEE_TAB_LABELS,
  narrow: EMPLOYEE_TAB_LABELS_SHORT,
};

export function BuddySectionNav({
  buddyId,
  activeTab,
  layout,
}: {
  buddyId: string;
  activeTab: EmployeeTab;
  layout: BuddyPageLayout;
}) {
  const labels = SUMMARY_LABELS[layout];
  const primary = layout === 'wide' ? WIDE_PRIMARY : NARROW_PRIMARY;
  const secondary = EMPLOYEE_TABS.filter((tab) => !primary.includes(tab));
  const link = (tab: EmployeeTab) => (
    <Link
      key={tab}
      to={buddyTabPath(buddyId, tab)}
      aria-current={activeTab === tab ? 'page' : undefined}
    >
      {tab === 'conversations' ? 'Chats' : EMPLOYEE_TAB_LABELS[tab]}
    </Link>
  );
  return (
    <nav className="buddy-detail-nav" aria-label="Buddy sections">
      {primary.map(link)}
      <details key={activeTab} className="buddy-detail-nav__more">
        <summary aria-current={secondary.includes(activeTab) ? 'true' : undefined}>
          {secondary.includes(activeTab) ? labels[activeTab] : 'More'}{' '}
          <span aria-hidden="true">⌄</span>
        </summary>
        <div className="buddy-detail-nav__menu ui-card">{secondary.map(link)}</div>
      </details>
    </nav>
  );
}
