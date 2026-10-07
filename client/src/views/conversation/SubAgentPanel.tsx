import type { SubAgent, SubAgentStatus } from '@unleashd/shared';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ContextBadge, type ContextBadgeTone, ContextSection } from './ContextSection';
import './SubAgentPanel.css';

/**
 * Active sub-agents from all providers, plus the last three finished ones.
 *
 * `tree` (desktop): a collapsible CLI-style tree. Expands on hover, toggles on
 * click or Ctrl+O, auto-collapses when every agent finishes.
 * `cards` (mobile pane): one card per agent under a "Sub-agents" section.
 */
export type SubAgentPanelProps =
  | { presentation: 'tree'; subAgents: SubAgent[]; workingDirectory: string }
  | { presentation: 'cards'; subAgents: SubAgent[] };

interface ShownSubAgents {
  active: SubAgent[];
  display: SubAgent[];
  total: number;
}

function isLive(status: SubAgentStatus): boolean {
  return status === 'running' || status === 'pending';
}

function shownSubAgents(subAgents: SubAgent[]): ShownSubAgents {
  const active = subAgents.filter((a) => isLive(a.status));
  const recentlyCompleted = subAgents.filter((a) => !isLive(a.status)).slice(-3);
  return { active, display: [...active, ...recentlyCompleted], total: subAgents.length };
}

// A child conversation (utils/subAgents.ts `projectChildConversationToSubAgent`, id
// `session:<id>`), such as a Buddy chat's background branch, which runs the deliveries for the
// chat (task_01a1153f). Its row comes from the chat's child rows, so the client holds it.
function childLink(agent: SubAgent, label: string) {
  return agent.id.startsWith('session:') ? (
    <Link to={`/chat/${encodeURIComponent(agent.id.slice('session:'.length))}`}>{label}</Link>
  ) : (
    label
  );
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens.toString();
}

export function SubAgentPanel(props: SubAgentPanelProps) {
  const shown = shownSubAgents(props.subAgents);
  if (shown.display.length === 0) return null;
  return props.presentation === 'tree' ? (
    <SubAgentTree shown={shown} workingDirectory={props.workingDirectory} />
  ) : (
    <SubAgentCards shown={shown} />
  );
}

const CARD_BADGE: Record<SubAgentStatus, { tone: ContextBadgeTone; glyph: string }> = {
  pending: { tone: 'active', glyph: '●' },
  running: { tone: 'active', glyph: '●' },
  error: { tone: 'neutral', glyph: '!' },
  completed: { tone: 'accent', glyph: '✓' },
};

function SubAgentCards({ shown }: { shown: ShownSubAgents }) {
  return (
    <ContextSection
      title="Sub-agents"
      meta={`${shown.active.length} running · ${shown.total} total`}
    >
      <div className="subagent-cards">
        {shown.display.map((agent) => (
          <div key={agent.id} className="ui-surface ui-card ui-row context-card">
            <ContextBadge tone={CARD_BADGE[agent.status].tone} className="subagent-card__badge">
              {CARD_BADGE[agent.status].glyph}
            </ContextBadge>
            <div className="context-card__body">
              <div className="context-card__title ui-truncate">
                {childLink(agent, agent.description || agent.id)}
              </div>
              {agent.currentAction ? (
                <div className="context-card__meta ui-truncate">{agent.currentAction}</div>
              ) : null}
              <div className="subagent-card__stats">
                {agent.toolUses ? <span>{agent.toolUses} tools</span> : null}
                {agent.tokens ? <span>{formatTokens(agent.tokens)} tokens</span> : null}
                <span className="subagent-card__status">{agent.status}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </ContextSection>
  );
}

function SubAgentTree({
  shown,
  workingDirectory,
}: {
  shown: ShownSubAgents;
  workingDirectory: string;
}) {
  const [isExpanded, setIsExpanded] = useState(true);
  // Track whether the user has manually toggled — if so, don't auto-collapse/expand on hover
  const userToggledRef = useRef(false);
  const displayAgents = shown.display;
  const runningCount = shown.active.length;

  // Auto-collapse when all agents complete (unless user manually toggled)
  const hasRunning = runningCount > 0;
  const hadRunningRef = useRef(hasRunning);
  useEffect(() => {
    if (hadRunningRef.current && !hasRunning && !userToggledRef.current) {
      setIsExpanded(false);
    }
    if (hasRunning && !hadRunningRef.current) {
      // New agents started — reset manual toggle flag but stay collapsed by default
      userToggledRef.current = false;
    }
    hadRunningRef.current = hasRunning;
  }, [hasRunning]);

  const handleMouseEnter = () => {
    if (!userToggledRef.current) setIsExpanded(true);
  };

  const handleMouseLeave = () => {
    if (!userToggledRef.current) setIsExpanded(false);
  };

  const toggleExpanded = () => {
    userToggledRef.current = true;
    setIsExpanded((prev) => !prev);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Ctrl+O to toggle expansion (matches Claude CLI behavior)
    if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
      e.preventDefault();
      toggleExpanded();
    }
  };

  return (
    <div
      className="subagent-panel"
      onKeyDown={handleKeyDown}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <button
        type="button"
        className="subagent-header ui-row"
        onClick={toggleExpanded}
        aria-expanded={isExpanded}
      >
        <span className={`subagent-indicator ${runningCount > 0 ? 'running' : 'done'}`} />
        <span className="subagent-summary">
          {runningCount > 0 ? (
            <>
              <strong>{runningCount}</strong> sub-agent{runningCount !== 1 ? 's' : ''} running
            </>
          ) : (
            <>Sub-agents completed</>
          )}
        </span>
        <span className="subagent-shortcut ui-muted">Ctrl+O</span>
        <svg
          className={`subagent-chevron ui-muted${isExpanded ? ' expanded' : ''}`}
          aria-hidden="true"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      <div className={`subagent-tree-wrapper ${isExpanded ? 'expanded' : ''}`}>
        <div className="subagent-tree">
          {displayAgents.map((agent, index) => {
            const isLast = index === displayAgents.length - 1;
            const isRunning = isLive(agent.status);

            return (
              <div key={agent.id} className="subagent-item">
                <span className="tree-connector ui-muted">{isLast ? '└─' : '├─'}</span>

                <span className={`subagent-status ui-inline-row ${agent.status}`}>
                  {isRunning ? (
                    <span className="status-spinner" />
                  ) : agent.status === 'completed' ? (
                    '✓'
                  ) : (
                    '✗'
                  )}
                </span>

                <div className="subagent-info">
                  <span className="subagent-description ui-truncate">
                    {agent.id.startsWith('swarm-') ? (
                      <Link
                        to={`/workers/detail?project=${encodeURIComponent(workingDirectory)}`}
                        className="swarm-link"
                      >
                        {truncateDescription(agent.description)}
                      </Link>
                    ) : (
                      childLink(agent, truncateDescription(agent.description))
                    )}
                  </span>
                  <span className="subagent-stats ui-row">
                    {agent.toolUses > 0 && (
                      <>
                        <span className="ui-muted">{'·'}</span>
                        <span className="stat">
                          {agent.toolUses} tool use{agent.toolUses !== 1 ? 's' : ''}
                        </span>
                      </>
                    )}
                    {agent.tokens > 0 && (
                      <>
                        <span className="ui-muted">{'·'}</span>
                        <span className="stat">{formatTokens(agent.tokens)} tokens</span>
                      </>
                    )}
                  </span>
                </div>

                {agent.currentAction && (
                  <div className="subagent-current-action ui-row">
                    <span className="tree-connector-sub ui-muted">{isLast ? '   ' : '│  '}</span>
                    <span className="action-connector ui-muted">{'└'}</span>
                    <span className={`current-action ui-truncate ${isRunning ? 'active' : 'done'}`}>
                      {agent.currentAction}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function truncateDescription(description: string, maxLength = 60): string {
  const normalized = description.trim().replace(/\s+/g, ' ');
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.substring(0, maxLength - 3)}...`;
}
