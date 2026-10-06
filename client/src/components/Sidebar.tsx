import type { ConversationConfig } from '@unleashd/shared';
import { createDefaultConversationConfig } from '@unleashd/shared';
import { useAtom, useAtomValue } from 'jotai';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useMatch, useNavigate } from 'react-router-dom';
import { readConversation, readConversationDetail, setConversationDone } from '../atoms/actions';
import {
  type BuddySidebarItemData,
  buddySidebarAtom,
  buddySidebarOverviewAtom,
} from '../atoms/buddy-sidebar';
import { createConversation } from '../atoms/commands';
import { commandsAtom, connectionAtom, listField, pendingCreatesOf } from '../atoms/conversations';
import { openSetupAt, prefsAtom, toggleGalleryCollapsed } from '../atoms/ui';
import { useBuddyOverview } from '../hooks/useBuddyData';
import { useProviderCatalog } from '../hooks/useProviderCatalog';
import { useScrollActivity } from '../hooks/useScrollActivity';
import { shortenHomePath } from '../utils/directories';
import { getProjectColor } from '../utils/projectColors';
import { ConversationRow } from '../views/conversation-row/ConversationRow';
import {
  type DirectoryStart,
  NewConversationForm,
} from '../views/new-conversation/NewConversationForm';
import { DmIcon, WakeIcon, WakeIndicator } from './buddies/WakeIndicator';
import { useBuddyDirectActions } from './buddies/buddy-direct-actions';
import { buddyTabPath } from './buddies/buddy-tabs';
import { anyUnread, ownerUnreadTotal, useOwnerInboxes } from './buddies/channel-data';
import { createBuddyViaBuilder } from './buddies/create-buddy-builder';
import './Sidebar.css';
import { SearchView } from '../views/search/SearchView';

function SidebarFolderIcon() {
  return (
    <svg
      className="sidebar-folder-icon"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7V5h6l2 2h10v12H3Z" />
    </svg>
  );
}

function SidebarBuddyIcon() {
  return (
    <svg
      className="sidebar-buddy-icon"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-2a8 8 0 0 1 16 0v2" />
    </svg>
  );
}

const DEFAULT_START: DirectoryStart = { t: 'default' };

export function Sidebar() {
  const { recent: recentGroups, olderIds } = useAtomValue(listField('folders'));
  const pendingCreations = pendingCreatesOf(useAtomValue(commandsAtom));
  // The route owns the active id (06-target-client §1.4).
  const activeConversationId = useMatch('/chat/:id')?.params.id ?? null;
  const wsStatus = useAtomValue(connectionAtom).socket.tag;

  const { galleryCollapsedProjects } = useAtomValue(prefsAtom);

  const builderConversations = useAtomValue(listField('builders'));
  const collapsedSet = useMemo(() => new Set(galleryCollapsedProjects), [galleryCollapsedProjects]);

  const [showSearch, setShowSearch] = useState(false);
  const [searchFilterDir, setSearchFilterDir] = useState<string | undefined>(undefined);
  // Null = closed; otherwise where the form's directory field starts.
  const [picker, setPicker] = useState<DirectoryStart | null>(null);
  const [creatingSwarm, setCreatingSwarm] = useState(false);
  const { catalog } = useProviderCatalog();
  const [isOpeningBuddyBuilder, setIsOpeningBuddyBuilder] = useState(false);
  const [buddyBuilderError, setBuddyBuilderError] = useState<string | null>(null);
  const { data: buddyOverview } = useBuddyOverview(30_000);
  const [, setBuddyOverview] = useAtom(buddySidebarOverviewAtom);
  useEffect(() => {
    if (buddyOverview) setBuddyOverview(buddyOverview);
  }, [buddyOverview, setBuddyOverview]);
  const {
    groups: buddySidebarGroups,
    buddyCount,
    channels: channelsWorkspaces,
  } = useAtomValue(buddySidebarAtom);
  const ownerUnread = useOwnerInboxes().data;
  const runningCountByFolder = useAtomValue(listField('runningByFolder'));
  const [expandedBuddies, setExpandedBuddies] = useState<Set<string>>(() => new Set());
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(() => new Set());
  const listScroll = useScrollActivity();
  const navigate = useNavigate();
  const location = useLocation();

  const handleNewConversation = useCallback(() => setPicker(DEFAULT_START), []);

  const handleNewBuddyBuilder = useCallback(async () => {
    setIsOpeningBuddyBuilder(true);
    setBuddyBuilderError(null);
    try {
      const conversationId = await createBuddyViaBuilder();
      navigate(`/chat/${conversationId}?helper=buddies`);
    } catch (cause) {
      setBuddyBuilderError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsOpeningBuddyBuilder(false);
    }
  }, [navigate]);

  const handleNewBuddyConversation = useCallback(
    (item: BuddySidebarItemData) => {
      // Reuse existing new-conversation flow but seed buddyContext so the
      // new thread is owned by that buddy — mirrors BuddiesDashboard talk().
      const latestConversation = item.latestConversation
        ? readConversation(item.latestConversation.id)
        : null;
      const workingDirectory =
        latestConversation?.cwd ??
        item.pendingCreation?.args.workingDirectory ??
        item.workingDirectory;
      // Seed the harness from this buddy's latest thread so a provider/model
      // picked there sticks for the next thread; the catalog default otherwise.
      // (The dashboard talk() path seeds from the saved Execution profile.)
      const seedConfig =
        (latestConversation && readConversationDetail(latestConversation.id)?.config.config) ??
        createDefaultConversationConfig(
          (catalog?.providers[0]?.id ?? 'claude') as ConversationConfig['provider']
        );
      // Direct create — reuses pending-creations createConversation + buddyContext shape
      const id = createConversation({
        workingDirectory,
        config: seedConfig,
        kind: {
          t: 'buddy',
          context: { buddyId: item.buddyId, workspaceId: item.workspaceId, buddyProjectId: null },
        },
      });
      navigate(`/chat/${id}`);
    },
    [catalog, navigate]
  );

  // Shift+Space global shortcut to open "New Conversation" dialog.
  // Skipped when focus is in an input/textarea so it doesn't hijack typing.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.shiftKey || e.code !== 'Space') return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      handleNewConversation();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleNewConversation]);

  // Cmd/Ctrl+P (and the legacy Cmd/Ctrl+K alias) opens the global search palette.
  // Skipped when focus is in an input/textarea so it doesn't hijack typing.
  useEffect(() => {
    const handleSearchShortcut = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !['k', 'p'].includes(e.key.toLowerCase())) return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      setSearchFilterDir(undefined);
      setShowSearch(true);
    };
    window.addEventListener('keydown', handleSearchShortcut);
    return () => window.removeEventListener('keydown', handleSearchShortcut);
  }, []);

  const handleCancel = () => {
    if (!creatingSwarm) setPicker(null);
  };

  // Stable callback: rows are memoized per id, so a new function identity
  // here would re-render every row on every Sidebar render.
  const pathname = location.pathname;
  const handleDone = useCallback(
    (id: string) => {
      setConversationDone(id, true);
      if (pathname.includes(id)) {
        navigate('/chats');
      }
    },
    [navigate, pathname]
  );
  const onDone = wsStatus === 'open' ? handleDone : null;

  return (
    <div className="sidebar">
      <div className="sidebar-header ui-stack">
        <div className="sidebar-actions" aria-label="Quick actions">
          <button
            type="button"
            className="sidebar-search-field ui-row ui-card"
            aria-label="Search Buddies and conversations"
            onClick={() => {
              setSearchFilterDir(undefined);
              setShowSearch(true);
            }}
            title="Search Buddies and conversations (Cmd/Ctrl+P)"
          >
            <svg
              role="img"
              aria-hidden="true"
              className="sidebar-search-field-icon"
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
            >
              <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="2" />
              <line
                x1="11"
                y1="11"
                x2="14.5"
                y2="14.5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
            <span className="sidebar-search-field-label ui-truncate">search</span>
            <span className="sidebar-search-field-shortcut ui-card ui-muted">⌘P</span>
          </button>
          <button
            type="button"
            className="sidebar-new-btn ui-inline-row ui-card"
            onClick={handleNewConversation}
            aria-label="New conversation"
            title="New conversation (Shift+Space)"
          >
            <span>new</span>
            <span className="sidebar-new-btn-plus">+</span>
          </button>
        </div>

        {picker && (
          <div className="new-conv-overlay ui-row" onClick={handleCancel}>
            <div className="new-conv-modal ui-stack" onClick={(e) => e.stopPropagation()}>
              <h3 className="new-conv-title">New Conversation</h3>
              <NewConversationForm
                layout="modal"
                start={picker}
                primary="chat"
                onBusyChange={setCreatingSwarm}
                onCreated={(conversationId) => {
                  setPicker(null);
                  setCreatingSwarm(false);
                  navigate(`/chat/${conversationId}`);
                }}
              />
            </div>
          </div>
        )}

        {showSearch && (
          <SearchView
            presentation="palette"
            folder={searchFilterDir ?? ''}
            onClose={() => setShowSearch(false)}
          />
        )}
      </div>

      <div className="conversations-list ui-scroll-quiet" {...listScroll}>
        {pendingCreations
          .filter((creation) => creation.args.kind.t !== 'buddy')
          .map((creation) => (
            <button
              type="button"
              key={creation.conversationId}
              className={`conversation-row conversation-row--sidebar ui-row pending-creation${
                creation.conversationId === activeConversationId ? ' conversation-row--active' : ''
              }`}
              onClick={() => navigate(`/chat/${creation.conversationId}`)}
            >
              <div className="conversation-row__line ui-row">
                <span className="conversation-row__folder ui-truncate">
                  {creation.args.workingDirectory.split('/').filter(Boolean).pop() ?? '/'}
                </span>
                <span className="conversation-row__title">
                  {creation.state.tag === 'rejected'
                    ? `Failed: ${creation.state.message}`
                    : `Starting ${creation.args.config.provider}…`}
                </span>
                <span className="conversation-row__dot" data-status="queued" />
              </div>
            </button>
          ))}
        <div className="sidebar-section">
          <div className="folder-group folder-group--buddies">
            <div
              className="folder-group-header ui-control ui-row"
              style={{ borderLeftColor: 'var(--ai)' }}
              onClick={() => toggleGalleryCollapsed('__buddies__')}
            >
              <button
                type="button"
                className="folder-group-name ui-truncate folder-group-name-button"
                onClick={(event) => {
                  event.stopPropagation();
                  navigate('/buddies');
                }}
              >
                Buddies
              </button>
              <button
                type="button"
                className="folder-group-add-btn ui-control ui-row folder-group-add-btn--section"
                aria-label="Create a new Buddy"
                title="Create a new Buddy"
                disabled={isOpeningBuddyBuilder}
                onClick={(event) => {
                  event.stopPropagation();
                  void handleNewBuddyBuilder();
                }}
              >
                +
              </button>
              <span className="folder-group-count ui-muted">{buddyCount || ''}</span>
            </div>
            {buddyBuilderError && (
              <div className="sidebar-buddy-error" role="alert">
                {buddyBuilderError}
              </div>
            )}
            {!collapsedSet.has('__buddies__') && buddyCount === 0 && (
              <div className="folder-group-all-done ui-muted">No Buddies yet</div>
            )}
            {!collapsedSet.has('__buddies__') &&
              buddySidebarGroups.map((group) => {
                if (group.kind === 'builder')
                  return (
                    <div key={group.key} className="folder-group folder-group--builder">
                      <div
                        className="folder-group-header ui-control ui-row"
                        style={{ borderLeftColor: 'var(--ai)' }}
                        onClick={() => toggleGalleryCollapsed('__builder__')}
                      >
                        <span
                          className="folder-group-name ui-truncate"
                          title="Buddy Builder conversations"
                        >
                          Buddy Builder
                        </span>
                        <button
                          type="button"
                          className="folder-group-add-btn ui-control ui-row folder-group-add-btn--section"
                          aria-label="Start a new Buddy Builder conversation"
                          title="Start a new Buddy Builder conversation"
                          disabled={isOpeningBuddyBuilder}
                          onClick={(event) => {
                            event.stopPropagation();
                            void handleNewBuddyBuilder();
                          }}
                        >
                          +
                        </button>
                        <span className="folder-group-count ui-muted">
                          {builderConversations.filter((entry) => !entry.done).length || ''}
                        </span>
                      </div>
                      {!collapsedSet.has('__builder__') &&
                        (() => {
                          const builderActive = builderConversations.filter((entry) => !entry.done);
                          if (builderActive.length === 0) return null;
                          const isBuilderExpanded = expandedDirectories.has('__builder__');
                          const visibleBuilder = isBuilderExpanded
                            ? builderActive
                            : builderActive.slice(0, 3);
                          const remainingBuilder = builderActive.length - visibleBuilder.length;
                          return (
                            <>
                              {visibleBuilder.map((entry) => (
                                <ConversationRow
                                  variant="sidebar"
                                  key={entry.id}
                                  id={entry.id}
                                  active={entry.id === activeConversationId}
                                  folder="hidden"
                                  onDone={onDone}
                                />
                              ))}
                              {builderActive.length > 3 && (
                                <button
                                  type="button"
                                  className="show-more-btn ui-muted"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setExpandedDirectories((prev) => {
                                      const next = new Set(prev);
                                      if (next.has('__builder__')) next.delete('__builder__');
                                      else next.add('__builder__');
                                      return next;
                                    });
                                  }}
                                >
                                  {isBuilderExpanded
                                    ? 'show less'
                                    : `show ${remainingBuilder} more`}
                                </button>
                              )}
                            </>
                          );
                        })()}
                    </div>
                  );
                const project = group.project;
                const projectKey = `buddy-project:${project.workspaceId}`;
                const isProjectCollapsed = collapsedSet.has(projectKey);
                return (
                  <div key={project.workspaceId} className="sidebar-buddy-project">
                    <div className="folder-group-header ui-control ui-row sidebar-buddy-project-header sidebar-project-divider">
                      <Link
                        className="sidebar-project-link"
                        to={`/buddies/workspaces/${encodeURIComponent(project.workspaceId)}`}
                        title={`Open ${project.name} workspace activity`}
                      >
                        <SidebarFolderIcon />
                        <span className="folder-group-name ui-truncate">{project.name}</span>
                      </Link>
                      <button
                        type="button"
                        className="sidebar-project-toggle"
                        aria-label={`${isProjectCollapsed ? 'Expand' : 'Collapse'} ${project.name}`}
                        aria-expanded={!isProjectCollapsed}
                        onClick={() => toggleGalleryCollapsed(projectKey)}
                      >
                        <span className="sidebar-project-rule" aria-hidden="true" />
                        <FolderRunningStatus count={project.runningCount} />
                        <span className="folder-group-count ui-muted">{project.items.length}</span>
                        <span className="sidebar-project-chevron ui-muted" aria-hidden="true">
                          {isProjectCollapsed ? '›' : '⌄'}
                        </span>
                      </button>
                    </div>
                    {!isProjectCollapsed &&
                      project.items.map((item) => {
                        const buddyKey = `buddy:${project.workspaceId}:${item.buddyId}`;
                        const isExpanded = expandedBuddies.has(buddyKey);
                        const convs = item.conversations;
                        const visibleConvs = isExpanded ? convs : convs.slice(0, 3);
                        const remaining = convs.length - visibleConvs.length;
                        const buddyPath = `/buddies/${encodeURIComponent(item.buddyId)}`;
                        const isBuddyActive =
                          location.pathname === buddyPath ||
                          location.pathname.startsWith(`${buddyPath}/`);
                        return (
                          <div key={item.buddyId} className="buddy-subgroup">
                            <div
                              className={`folder-group-header ui-control ui-row folder-group-header--buddy ${isBuddyActive ? 'active' : ''}`}
                            >
                              <Link
                                className="sidebar-buddy-row-link"
                                to={buddyPath}
                                aria-label={`Open ${item.buddyName}`}
                                aria-current={isBuddyActive ? 'page' : undefined}
                              />
                              <button
                                type="button"
                                className="folder-group-add-btn ui-control ui-row"
                                aria-label={`New conversation with ${item.buddyName}`}
                                title={`New conversation with ${item.buddyName}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleNewBuddyConversation(item);
                                }}
                              >
                                +
                              </button>
                              <SidebarBuddyIcon />
                              <span
                                className="folder-group-name ui-truncate sidebar-buddy-link"
                                title={item.buddyName}
                              >
                                {item.buddyName}
                              </span>
                              <BuddyRunningStatus item={item} />
                              <SidebarBuddyActions item={item} />
                            </div>
                            <>
                              {visibleConvs.length > 0 ? (
                                visibleConvs.map((entry) => (
                                  <ConversationRow
                                    variant="sidebar"
                                    key={entry.id}
                                    id={entry.id}
                                    active={entry.id === activeConversationId}
                                    folder="hidden"
                                    onDone={onDone}
                                  />
                                ))
                              ) : item.pendingCreation ? (
                                <div className="conversation-row conversation-row--sidebar ui-row pending-creation">
                                  <div className="conversation-row__line ui-row">
                                    <span className="conversation-row__title">
                                      {item.pendingCreation.state.tag === 'rejected'
                                        ? `Failed: ${item.pendingCreation.state.message}`
                                        : `Starting ${item.pendingCreation.args.config.provider}…`}
                                    </span>
                                    <span className="conversation-row__dot" data-status="queued" />
                                  </div>
                                </div>
                              ) : item.backgroundConversationCount === 0 ? (
                                <div className="folder-group-all-done ui-muted">
                                  No conversations yet
                                </div>
                              ) : null}
                              {convs.length > 3 && (
                                <button
                                  type="button"
                                  className="show-more-btn ui-muted"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setExpandedBuddies((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(buddyKey)) next.delete(buddyKey);
                                      else next.add(buddyKey);
                                      return next;
                                    });
                                  }}
                                >
                                  {isExpanded ? 'show less' : `show ${remaining} more`}
                                </button>
                              )}
                            </>
                          </div>
                        );
                      })}
                  </div>
                );
              })}
          </div>
        </div>
        {channelsWorkspaces.length > 0 && (
          <div className="sidebar-section">
            <div className="folder-group">
              <div
                className="folder-group-header ui-control ui-row"
                onClick={() => toggleGalleryCollapsed('__channels__')}
              >
                <button
                  type="button"
                  className="folder-group-name ui-truncate folder-group-name-button"
                  onClick={(event) => {
                    event.stopPropagation();
                    navigate(
                      `/buddies/workspaces/${encodeURIComponent(channelsWorkspaces[0].workspaceId)}/channels`
                    );
                  }}
                >
                  Channels
                </button>
                <span className="folder-group-count ui-muted">
                  {channelsWorkspaces.length || ''}
                </span>
              </div>
              {!collapsedSet.has('__channels__') &&
                channelsWorkspaces.map((project) => {
                  const path = `/buddies/workspaces/${encodeURIComponent(project.workspaceId)}/channels`;
                  const isActive = location.pathname === path;
                  const unread = ownerUnreadTotal(ownerUnread, project.workspaceId);
                  return (
                    <div
                      key={project.workspaceId}
                      className={`folder-group-header ui-control ui-row sidebar-channels-row ${isActive ? 'active' : ''}`}
                    >
                      <Link
                        className="folder-group-name ui-truncate sidebar-project-link"
                        to={path}
                        aria-current={isActive ? 'page' : undefined}
                        data-unread={anyUnread(unread) || undefined}
                        title={`${project.name} channels`}
                      >
                        <span className="folder-group-name ui-truncate"># {project.name}</span>
                      </Link>
                      {unread.requests > 0 && (
                        <span
                          className="sidebar-channels-badge"
                          aria-label={`${unread.requests} requests waiting on you`}
                        >
                          {unread.requests}
                        </span>
                      )}
                    </div>
                  );
                })}
            </div>
          </div>
        )}
        {
          <>
            {recentGroups.length > 0 && (
              <div className="sidebar-section">
                {recentGroups.map((group) => {
                  const isCollapsed = collapsedSet.has(group.directory);
                  const dirDisplay = shortenHomePath(group.directory);
                  const projectColor = getProjectColor(group.directory);
                  const runningCount = runningCountByFolder.get(group.directory) ?? 0;
                  // Done rows are already out; the group keeps its position.
                  const activeConvs = group.activeIds;

                  return (
                    <div key={group.directory} className="folder-group">
                      <div
                        className="folder-group-header ui-control ui-row sidebar-project-divider"
                        onClick={() => toggleGalleryCollapsed(group.directory)}
                        style={{ borderLeftColor: projectColor }}
                      >
                        <SidebarFolderIcon />
                        <span className="folder-group-name ui-truncate" title={group.directory}>
                          {dirDisplay}
                        </span>
                        <span className="sidebar-project-rule" aria-hidden="true" />
                        <button
                          type="button"
                          className="folder-group-add-btn ui-control ui-row"
                          aria-label={`Search in ${dirDisplay}`}
                          title={`Search in ${dirDisplay}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSearchFilterDir(group.directory);
                            setShowSearch(true);
                          }}
                        >
                          <svg
                            role="img"
                            aria-hidden="true"
                            width="10"
                            height="10"
                            viewBox="0 0 16 16"
                            fill="none"
                          >
                            <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="2" />
                            <line
                              x1="11"
                              y1="11"
                              x2="14.5"
                              y2="14.5"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                            />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="folder-group-add-btn ui-control ui-row"
                          title={`New conversation in ${dirDisplay}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setPicker({ t: 'chosen', path: group.directory });
                          }}
                        >
                          +
                        </button>
                        <FolderRunningStatus count={runningCount} />
                        <span className="folder-group-count ui-muted">
                          {activeConvs.length || ''}
                        </span>
                      </div>
                      {!isCollapsed &&
                        (() => {
                          const isExpanded = expandedDirectories.has(group.directory);
                          const visibleConvs = isExpanded ? activeConvs : activeConvs.slice(0, 3);
                          const remaining = activeConvs.length - visibleConvs.length;
                          return activeConvs.length > 0 ? (
                            <>
                              {visibleConvs.map((id) => (
                                <ConversationRow
                                  variant="sidebar"
                                  key={id}
                                  id={id}
                                  active={id === activeConversationId}
                                  folder="hidden"
                                  onDone={onDone}
                                />
                              ))}
                              {activeConvs.length > 3 && (
                                <button
                                  type="button"
                                  className="show-more-btn ui-muted"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setExpandedDirectories((prev) => {
                                      const next = new Set(prev);
                                      if (next.has(group.directory)) next.delete(group.directory);
                                      else next.add(group.directory);
                                      return next;
                                    });
                                  }}
                                >
                                  {isExpanded ? 'show less' : `show ${remaining} more`}
                                </button>
                              )}
                            </>
                          ) : (
                            <div className="folder-group-all-done ui-muted">
                              All conversations marked done
                            </div>
                          );
                        })()}
                    </div>
                  );
                })}
              </div>
            )}

            {(() => {
              const olderActive = olderIds;
              if (olderActive.length === 0) return null;
              const isOlderExpanded = expandedDirectories.has('__older__');
              const visibleOlder = isOlderExpanded ? olderActive : olderActive.slice(0, 3);
              const remainingOlder = olderActive.length - visibleOlder.length;
              return (
                <div className="sidebar-section">
                  <div className="sidebar-section-header ui-muted">Older</div>
                  {visibleOlder.map((id) => (
                    <ConversationRow
                      variant="sidebar"
                      key={id}
                      id={id}
                      active={id === activeConversationId}
                      folder="badge"
                      onDone={onDone}
                    />
                  ))}
                  {olderActive.length > 3 && (
                    <button
                      type="button"
                      className="show-more-btn ui-muted"
                      onClick={() => {
                        setExpandedDirectories((prev) => {
                          const next = new Set(prev);
                          if (next.has('__older__')) next.delete('__older__');
                          else next.add('__older__');
                          return next;
                        });
                      }}
                    >
                      {isOlderExpanded ? 'show less' : `show ${remainingOlder} more`}
                    </button>
                  )}
                </div>
              );
            })()}
          </>
        }
      </div>
      <button
        type="button"
        className="sidebar-connect-mobile ui-row ui-muted"
        onClick={() => openSetupAt('connect-mobile')}
        title="Open Buddies on your phone"
      >
        <span aria-hidden="true">▯</span>
        Connect mobile
      </button>
    </div>
  );
}

// DM + Wake on hover, after the running counts so those links stay clickable.
// DM opens the ongoing owner chat with this Buddy (history kept); Wake has it
// catch up on the workspace channels inside that chat (buddy-direct-actions.ts).
function SidebarBuddyActions({ item }: { item: BuddySidebarItemData }) {
  const navigate = useNavigate();
  const direct = useBuddyDirectActions(item.buddyId);
  const { action } = direct;
  return (
    <>
      {direct.woken && (
        <WakeIndicator
          key={direct.woken.attempt}
          name={item.buddyName}
          className="sidebar-buddy-wake ui-inline-row ui-muted"
        />
      )}
      <span
        className="sidebar-buddy-actions"
        data-failed={action.kind === 'failed' || undefined}
        title={action.kind === 'failed' ? action.message : undefined}
      >
        <button
          type="button"
          aria-label={`Message ${item.buddyName}`}
          title={`Message ${item.buddyName}`}
          disabled={action.kind === 'pending'}
          onClick={(event) => {
            event.stopPropagation();
            direct.openDm((conversationId) =>
              navigate(`/chat/${encodeURIComponent(conversationId)}`)
            );
          }}
        >
          <DmIcon />
        </button>
        <button
          type="button"
          aria-label={`Wake ${item.buddyName}`}
          title={`Wake ${item.buddyName}: catch up on the channels and act`}
          disabled={action.kind === 'pending'}
          onClick={(event) => {
            event.stopPropagation();
            direct.wake();
          }}
        >
          <WakeIcon />
        </button>
      </span>
    </>
  );
}

function BuddyRunningStatus({ item }: { item: BuddySidebarItemData }) {
  const backgroundPath = buddyTabPath(item.buddyId, 'background');
  return (
    <span className="sidebar-buddy-running ui-inline-row ui-muted">
      <Link
        to={buddyTabPath(item.buddyId, 'conversations')}
        className={item.foregroundRunningCount ? 'sidebar-buddy-running-active' : ''}
        aria-label={`${item.foregroundRunningCount} foreground conversations running for ${item.buddyName}`}
        title={`${item.foregroundRunningCount} foreground conversations running`}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M4 4h16v12H9l-5 4V4Z" />
        </svg>
        {item.foregroundRunningCount}
      </Link>
      <span aria-hidden="true">/</span>
      <Link
        to={backgroundPath}
        className={item.backgroundRunningCount ? 'sidebar-buddy-running-active' : ''}
        aria-label={`${item.backgroundRunningCount} background tasks running for ${item.buddyName}`}
        title={`${item.backgroundRunningCount} background tasks running · View background conversations`}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M4 16H2V2h14v2M7 7h15v15H7Z" />
        </svg>
        {item.backgroundRunningCount}
      </Link>
    </span>
  );
}

function FolderRunningStatus({ count }: { count: number }) {
  if (count === 0) return null;
  const label = `${count} running`;
  return (
    <span
      className="folder-group-running ui-inline-row"
      aria-label={`${label} in this project`}
      title={label}
    >
      <span className="conversation-row__dot" data-status="running" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}
