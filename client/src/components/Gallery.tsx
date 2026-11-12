import { useAtomValue } from 'jotai';
import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { type ConversationListEntry, connectionAtom, listField } from '../atoms/conversations';
import {
  prefsAtom,
  setShowDoneConversations,
  setShowTempSessions,
  setShowWorkerConversations,
  toggleGalleryCollapsed,
  toggleGalleryExpanded,
} from '../atoms/ui';
import { useFolderFilter } from '../hooks/useFolderFilter';
import { useUrlFolderSelection } from '../hooks/useUrlFolderSelection';
import { ConversationRow } from '../views/conversation-row/ConversationRow';
import { FolderFilter } from './FolderFilter';
import './Gallery.css';
import { isWorktreeDirectory, shortenHomePath } from '../utils/directories';

/**
 * Detect if a working directory is a temporary/ephemeral path.
 * macOS uses /private/var/folders/ for temp directories.
 * These are legitimate sessions but clutter the Gallery.
 */
function isTempDirectory(workingDirectory: string): boolean {
  return (
    workingDirectory.includes('/private/var/folders/') ||
    workingDirectory.includes('/var/folders/') ||
    workingDirectory.includes('/tmp/') ||
    workingDirectory.includes('/temp/')
  );
}

// Project group interface for grouping conversations by working directory.
// Entries carry the list fields; each card subscribes to its own conversation.
interface ProjectGroup {
  directory: string;
  conversations: ConversationListEntry[];
}

// Number of conversations to show per project before "Show more" button
const CONVERSATIONS_PER_PROJECT = 10;
const EMPTY_CONVERSATIONS: ConversationListEntry[] = [];

type ProjectProjection = 'real' | 'temp' | 'worker' | 'done';

function compareConversationsByCreatedAtDesc(
  a: ConversationListEntry,
  b: ConversationListEntry
): number {
  return b.createdAtMs - a.createdAtMs;
}

interface GalleryProps {
  filter?: 'done';
}

export function Gallery({ filter }: GalleryProps = {}) {
  // Top-level conversations, newest-created first (atoms/conversations.ts).
  const sortedConversations = useAtomValue(listField('gallery'));
  const hasConversations = useAtomValue(listField('order')).length > 0;
  const navigate = useNavigate();

  // Persisted Gallery UI state via atoms/ui
  const {
    galleryExpandedProjects,
    galleryCollapsedProjects,
    showTempSessions,
    showDoneConversations,
    showWorkerConversations,
  } = useAtomValue(prefsAtom);
  const connected = useAtomValue(connectionAtom).socket.tag === 'open';
  const [showDoneBySection, setShowDoneBySection] = useState<Record<string, boolean>>({});

  // Derived Sets for O(1) lookup
  const expandedProjects = useMemo(
    () => new Set(galleryExpandedProjects),
    [galleryExpandedProjects]
  );
  const collapsedProjects = useMemo(
    () => new Set(galleryCollapsedProjects),
    [galleryCollapsedProjects]
  );

  // Get folder from conversation
  const getFolder = useCallback((conv: ConversationListEntry) => conv.workingDirectory, []);

  // Format folder for display (shorten home directory)
  const formatFolder = useCallback((folder: string) => {
    return shortenHomePath(folder);
  }, []);

  // Folder selection state lives in URL query params (?folders=...)
  const [selectedFolders, setSelectedFolders] = useUrlFolderSelection();

  // Folder filter hook — pure computation, caller owns state
  const {
    folders: allFolders,
    selected,
    toggle,
    clear,
    filtered,
  } = useFolderFilter({
    items: sortedConversations,
    getFolder,
    selected: selectedFolders,
    setSelected: setSelectedFolders,
  });

  // Filter temp directories and sort folders by most recent conversation (not alphabetical)
  const folders = useMemo(() => {
    const nonTemp = allFolders.filter(
      (folder) => !isTempDirectory(folder) && !isWorktreeDirectory(folder)
    );

    // Build a map of folder -> most recent conversation date
    const folderRecency = new Map<string, number>();
    for (const conv of sortedConversations) {
      const dir = conv.workingDirectory;
      if (!folderRecency.has(dir)) {
        // First encounter is the newest since sortedConversations is newest-first
        folderRecency.set(dir, conv.createdAtMs);
      }
    }

    // Sort by most recent conversation descending
    return nonTemp.sort((a, b) => {
      const aTime = folderRecency.get(a) ?? 0;
      const bTime = folderRecency.get(b) ?? 0;
      return bTime - aTime;
    });
  }, [allFolders, sortedConversations]);

  // Group filtered conversations by working directory, separating done → worker → temp → real
  const {
    projectGroups,
    tempGroups,
    tempSessionCount,
    doneGroups,
    doneSessionCount,
    workerGroups,
    workerSessionCount,
    doneRealGroups,
    doneTempGroups,
    doneWorkerGroups,
  } = useMemo(() => {
    const realGroups = new Map<string, ConversationListEntry[]>();
    const tempGroupsMap = new Map<string, ConversationListEntry[]>();
    const doneGroupsMap = new Map<string, ConversationListEntry[]>();
    const workerGroupsMap = new Map<string, ConversationListEntry[]>();
    const doneRealGroupsMap = new Map<string, ConversationListEntry[]>();
    const doneTempGroupsMap = new Map<string, ConversationListEntry[]>();
    const doneWorkerGroupsMap = new Map<string, ConversationListEntry[]>();

    // Group by working directory, separating done → worker → temp → real
    for (const conv of filtered) {
      const dir = conv.workingDirectory;
      if (conv.done) {
        if (!doneGroupsMap.has(dir)) doneGroupsMap.set(dir, []);
        doneGroupsMap.get(dir)!.push(conv);
        if (conv.isWorker) {
          if (!doneWorkerGroupsMap.has(dir)) doneWorkerGroupsMap.set(dir, []);
          doneWorkerGroupsMap.get(dir)!.push(conv);
        } else if (isTempDirectory(dir)) {
          if (!doneTempGroupsMap.has(dir)) doneTempGroupsMap.set(dir, []);
          doneTempGroupsMap.get(dir)!.push(conv);
        } else {
          if (!doneRealGroupsMap.has(dir)) doneRealGroupsMap.set(dir, []);
          doneRealGroupsMap.get(dir)!.push(conv);
        }
      } else if (conv.isWorker) {
        // An old oompa transcript: collected under its own collapsed section
        if (!workerGroupsMap.has(dir)) workerGroupsMap.set(dir, []);
        workerGroupsMap.get(dir)!.push(conv);
      } else if (isTempDirectory(dir)) {
        if (!tempGroupsMap.has(dir)) tempGroupsMap.set(dir, []);
        tempGroupsMap.get(dir)!.push(conv);
      } else {
        if (!realGroups.has(dir)) realGroups.set(dir, []);
        realGroups.get(dir)!.push(conv);
      }
    }

    // Convert to array of ProjectGroup objects
    const toGroupArray = (groups: Map<string, ConversationListEntry[]>): ProjectGroup[] => {
      const groupArray: ProjectGroup[] = Array.from(groups.entries()).map(([directory, convs]) => ({
        directory,
        conversations: convs,
      }));

      // Sort groups by most recent conversation in each group (newest first)
      groupArray.sort((a, b) => {
        return compareConversationsByCreatedAtDesc(a.conversations[0], b.conversations[0]);
      });

      return groupArray;
    };

    // Count total temp sessions
    let tempCount = 0;
    for (const convs of tempGroupsMap.values()) {
      tempCount += convs.length;
    }

    // Count total done sessions
    let doneCount = 0;
    for (const convs of doneGroupsMap.values()) {
      doneCount += convs.length;
    }

    // Count total worker sessions
    let workerCount = 0;
    for (const convs of workerGroupsMap.values()) {
      workerCount += convs.length;
    }

    return {
      projectGroups: toGroupArray(realGroups),
      tempGroups: toGroupArray(tempGroupsMap),
      tempSessionCount: tempCount,
      doneGroups: toGroupArray(doneGroupsMap),
      doneSessionCount: doneCount,
      workerGroups: toGroupArray(workerGroupsMap),
      workerSessionCount: workerCount,
      doneRealGroups: doneRealGroupsMap,
      doneTempGroups: doneTempGroupsMap,
      doneWorkerGroups: doneWorkerGroupsMap,
    };
  }, [filtered]);

  const isDoneView = filter === 'done';
  const sortedConversationIds = useMemo(
    () => sortedConversations.map((conv) => conv.id),
    [sortedConversations]
  );

  const getSectionKey = useCallback(
    (projection: Exclude<ProjectProjection, 'done'>, directory: string) =>
      `${projection}:${directory}`,
    []
  );

  const toggleSectionDoneVisibility = useCallback(
    (projection: Exclude<ProjectProjection, 'done'>, directory: string) => {
      const sectionKey = getSectionKey(projection, directory);
      setShowDoneBySection((current) => ({
        ...current,
        [sectionKey]: !current[sectionKey],
      }));
    },
    [getSectionKey]
  );

  const getDoneConversationsForSection = useCallback(
    (projection: Exclude<ProjectProjection, 'done'>, directory: string) => {
      switch (projection) {
        case 'real':
          return doneRealGroups.get(directory) ?? EMPTY_CONVERSATIONS;
        case 'temp':
          return doneTempGroups.get(directory) ?? EMPTY_CONVERSATIONS;
        case 'worker':
          return doneWorkerGroups.get(directory) ?? EMPTY_CONVERSATIONS;
      }
    },
    [doneRealGroups, doneTempGroups, doneWorkerGroups]
  );

  const openConversation = useCallback((id: string) => navigate(`/chat/${id}`), [navigate]);

  const renderProjectSection = useCallback(
    ({
      group,
      projection,
      sectionClassName,
      pathLabel = formatFolder(group.directory),
      countLabel = 'conversation',
      showWorkerBadge = false,
    }: {
      group: ProjectGroup;
      projection: ProjectProjection;
      sectionClassName?: string;
      pathLabel?: string;
      countLabel?: string;
      showWorkerBadge?: boolean;
    }) => {
      const isCollapsed = collapsedProjects.has(group.directory);
      const isExpanded = expandedProjects.has(group.directory);
      const doneConversationsForSection =
        projection === 'done'
          ? EMPTY_CONVERSATIONS
          : getDoneConversationsForSection(projection, group.directory);
      const sectionKey = projection === 'done' ? null : getSectionKey(projection, group.directory);
      const showDoneInSection = sectionKey ? Boolean(showDoneBySection[sectionKey]) : false;
      const sectionConversations = showDoneInSection
        ? [...group.conversations, ...doneConversationsForSection].sort(
            compareConversationsByCreatedAtDesc
          )
        : group.conversations;
      const totalCount = sectionConversations.length;
      const hiddenCount = totalCount - CONVERSATIONS_PER_PROJECT;
      const showMoreButton = totalCount > CONVERSATIONS_PER_PROJECT && !isExpanded;
      const visibleConversations = isExpanded
        ? sectionConversations
        : sectionConversations.slice(0, CONVERSATIONS_PER_PROJECT);

      return (
        <div
          key={`${projection}:${group.directory}`}
          className={[
            'project-section ui-stack',
            sectionClassName,
            projection !== 'done' && doneConversationsForSection.length > 0
              ? 'has-done-toggle'
              : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <div className="project-header-row">
            <button
              type="button"
              className="project-header ui-row"
              onClick={() => toggleGalleryCollapsed(group.directory)}
            >
              <div className="project-header-left ui-row">
                <span className={`project-chevron ${isCollapsed ? 'collapsed' : ''}`}>&#9660;</span>
                <span className="project-path ui-truncate">{pathLabel}</span>
              </div>
              <span className="project-count ui-card ui-muted">
                {totalCount} {countLabel}
                {totalCount !== 1 ? 's' : ''}
              </span>
            </button>

            {projection !== 'done' && doneConversationsForSection.length > 0 && (
              <button
                type="button"
                className={`project-done-toggle ${showDoneInSection ? 'active' : ''}`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleSectionDoneVisibility(projection, group.directory);
                }}
              >
                {showDoneInSection
                  ? 'Hide done'
                  : `Show ${doneConversationsForSection.length} done`}
              </button>
            )}
          </div>

          {!isCollapsed && (
            <>
              <div className="project-grid">
                {visibleConversations.map((conv) => (
                  <ConversationRow
                    variant="card"
                    key={conv.id}
                    id={conv.id}
                    worker={showWorkerBadge}
                    doneView={isDoneView}
                    connected={connected}
                  />
                ))}
              </div>

              {showMoreButton && (
                <button
                  type="button"
                  className="gallery-show-more-btn ui-control"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleGalleryExpanded(group.directory);
                  }}
                >
                  Show more... ({hiddenCount} hidden)
                </button>
              )}

              {isExpanded && totalCount > CONVERSATIONS_PER_PROJECT && (
                <button
                  type="button"
                  className="gallery-show-more-btn ui-control"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleGalleryExpanded(group.directory);
                  }}
                >
                  Show less
                </button>
              )}
            </>
          )}
        </div>
      );
    },
    [
      collapsedProjects,
      expandedProjects,
      formatFolder,
      getDoneConversationsForSection,
      getSectionKey,
      showDoneBySection,
      toggleSectionDoneVisibility,
      isDoneView,
      connected,
    ]
  );

  if (!hasConversations) {
    return (
      <div className="gallery-view ui-stack">
        <div className="empty-state ui-muted">
          No conversations yet. Click "+ New Conversation" to start.
        </div>
      </div>
    );
  }

  if (isDoneView && doneSessionCount === 0) {
    return (
      <div className="gallery-view ui-stack">
        <div className="gallery-done-header ui-row">
          <button
            type="button"
            className="back-to-gallery-btn ui-control"
            onClick={() => navigate('/chats')}
          >
            &#8592; Gallery
          </button>
          <h2>Done Conversations</h2>
        </div>
        <div className="empty-state ui-muted">
          No done conversations. Mark conversations as done from the sidebar.
        </div>
      </div>
    );
  }

  return (
    <div className="gallery-view ui-stack">
      {isDoneView ? (
        <div className="gallery-done-header ui-row">
          <button
            type="button"
            className="back-to-gallery-btn ui-control"
            onClick={() => navigate('/chats')}
          >
            &#8592; Gallery
          </button>
          <h2>Done Conversations ({doneSessionCount})</h2>
        </div>
      ) : (
        <FolderFilter
          folders={folders}
          selected={selected}
          onToggle={toggle}
          onClear={clear}
          formatFolder={formatFolder}
          conversationIds={sortedConversationIds}
          onSelectConversation={openConversation}
        />
      )}
      <div className="gallery-content ui-stack">
        {/* Regular project groups — hidden in done view */}
        {!isDoneView &&
          projectGroups.map((group) =>
            renderProjectSection({
              group,
              projection: 'real',
            })
          )}

        {/* Temp sessions toggle and groups — hidden in done view */}
        {!isDoneView && tempSessionCount > 0 && (
          <div className="temp-sessions-section">
            <button
              type="button"
              className="temp-sessions-toggle ui-control ui-row"
              onClick={() => setShowTempSessions(!showTempSessions)}
            >
              <span className={`project-chevron ${!showTempSessions ? 'collapsed' : ''}`}>
                &#9660;
              </span>
              {showTempSessions ? 'Hide' : 'Show'} {tempSessionCount} temporary session
              {tempSessionCount !== 1 ? 's' : ''}
              <span className="temp-sessions-hint ui-muted">
                (sessions from /tmp, /var/folders, etc.)
              </span>
            </button>

            {showTempSessions &&
              tempGroups.map((group) =>
                renderProjectSection({
                  group,
                  projection: 'temp',
                  sectionClassName: 'temp-project',
                  pathLabel: group.directory.includes('/T/tmp')
                    ? `[Temp] ${group.directory.match(/tmp[A-Za-z0-9_-]*/)?.[0] || 'session'}`
                    : formatFolder(group.directory),
                })
              )}
          </div>
        )}

        {/* Old oompa transcripts (kind worker): a collapsed section of the main view */}
        {workerSessionCount > 0 && !isDoneView && (
          <div className="worker-sessions-section">
            <button
                type="button"
                className="worker-sessions-toggle ui-control ui-row"
                onClick={() => setShowWorkerConversations(!showWorkerConversations)}
              >
                <span className={`project-chevron ${!showWorkerConversations ? 'collapsed' : ''}`}>
                  &#9660;
                </span>
                {showWorkerConversations ? 'Hide' : 'Show'} {workerSessionCount} worker session
                {workerSessionCount !== 1 ? 's' : ''}
                <span className="worker-sessions-hint ui-muted">(old oompa runs)</span>
            </button>

            {showWorkerConversations &&
              workerGroups.map((group) =>
                renderProjectSection({
                  group,
                  projection: 'worker',
                  sectionClassName: 'worker-project',
                  countLabel: 'worker',
                  showWorkerBadge: true,
                })
              )}
          </div>
        )}

        {/* Done conversations toggle and groups — always expanded in done view */}
        {doneSessionCount > 0 && (
          <div className="done-sessions-section">
            {!isDoneView && (
              <button
                type="button"
                className="done-sessions-toggle ui-control ui-row"
                onClick={() => setShowDoneConversations(!showDoneConversations)}
              >
                <span className={`project-chevron ${!showDoneConversations ? 'collapsed' : ''}`}>
                  &#9660;
                </span>
                {showDoneConversations ? 'Hide' : 'Show'} {doneSessionCount} done conversation
                {doneSessionCount !== 1 ? 's' : ''}
              </button>
            )}

            {(isDoneView || showDoneConversations) &&
              doneGroups.map((group) =>
                renderProjectSection({
                  group,
                  projection: 'done',
                  sectionClassName: 'done-project',
                })
              )}
          </div>
        )}
      </div>
    </div>
  );
}
