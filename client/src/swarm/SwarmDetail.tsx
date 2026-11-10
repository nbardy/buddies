import type { ConversationRow, SwarmRun, SwarmRunSummary } from '@unleashd/shared';
import { useAtomValue } from 'jotai';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { readConversationMessages } from '../atoms/actions';
import { createConversation } from '../atoms/commands';
import { groupsFamily, rowFamily } from '../atoms/conversations';
import { markMessagesSeen } from '../atoms/ui';
import { VirtualizedMessageList } from '../components/VirtualizedMessageList';
import { useConversationBodies } from '../hooks/useConversationBodies';
import { useTimeTick } from '../hooks/useTimeTick';
import { mobileConversationRouteState } from '../utils/conversation-route-state';
import { rowWorker } from '../utils/conversation-row';
import { shortenHomePath } from '../utils/directories';
import { formatTimeAgo } from '../utils/time';
import { GitLogPanel, OompaConfigPanel, SwarmRunsPanel } from './SwarmDetailPanels';
import { type SwarmLayout, SwarmPage } from './SwarmPage';
import {
  type ExecGroup,
  type RunningOf,
  getWorkerVisibilitySummary,
  groupExecWorkers,
  runningFromSnapshot,
} from './swarm-groups';
import { NO_WORKERS, swarmWorkersByProjectAtom } from './swarm-workers';
import { useSwarmRuntimeSnapshots } from './useSwarmRuntimeSnapshots';
import './SwarmDetail.css';

type Verdict = 'approved' | 'needs-changes' | 'rejected' | 'pending';
type SwarmTab = 'workers' | 'runs';
type RouteState = Record<string, unknown>;

/** Desktop opens on the run overview; mobile on the worker list it always showed first. */
const DEFAULT_TAB: Record<SwarmLayout, SwarmTab> = { wide: 'runs', narrow: 'workers' };

/**
 * Workers tab. Wide: roster + the selected exec's transcript beside its latest
 * review. Narrow: stacked exec groups, each worker a link to its chat.
 */
const WORKER_VIEWS: Record<SwarmLayout, (props: WorkerViewProps) => ReactNode> = {
  wide: WorkerPanes,
  narrow: WorkerList,
};

interface WorkerViewProps {
  groups: ExecGroup[];
  isRunning: RunningOf;
  runId: string | null;
  routeState: RouteState;
}

/** Reads a review's verdict. Bodies load only for a review that was opened, so an unopened one is pending. */
function extractVerdict(conv: ConversationRow): Verdict {
  for (const msg of readConversationMessages(conv.id)) {
    if (msg.role !== 'assistant') continue;
    const text =
      msg.body.t === 'text'
        ? msg.body.text
        : msg.body.parts
            .filter((part) => part.t === 'text')
            .map((part) => part.text)
            .join('\n');
    if (text.includes('VERDICT: APPROVED')) return 'approved';
    if (text.includes('VERDICT: NEEDS_CHANGES')) return 'needs-changes';
    if (text.includes('VERDICT: REJECTED')) return 'rejected';
  }
  return 'pending';
}

function latestVerdict(group: ExecGroup): Verdict {
  const review = group.reviews[0];
  return review && rowWorker(review)?.role === 'review' ? extractVerdict(review) : 'pending';
}

async function sendSwarmSignal(projectRoot: string, signal: 'stop' | 'kill') {
  const res = await fetch('/api/swarm-signal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir: projectRoot, signal }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new Error(body.error ?? body.message ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as { ok: boolean; message: string };
}

/**
 * The hidden system prefix of a swarm debug conversation: prepended to the first
 * CLI message so the agent has swarm context, rendered by SwarmConvoPrefix.
 */
function buildSwarmDebugPrefix(
  projectRoot: string,
  configPath: string | null,
  swarmId: string | null,
  run: SwarmRun | undefined
): string {
  const runsDir = `${projectRoot}/runs/${swarmId ?? 'unknown'}`;
  const lines = [
    'You are debugging an oompa swarm run. Here is the full context:',
    '',
    '## Swarm Context',
    `- Project: ${projectRoot}`,
    `- Config: ${configPath ?? `${projectRoot}/oompa.json`}`,
    `- Swarm ID: ${swarmId ?? 'unknown'}`,
  ];
  if (run?.run) lines.push(`- Started: ${new Date(run.run['started-at']).toLocaleString()}`);
  if (run?.summary) lines.push(...summaryLines(run.summary));
  lines.push(
    '',
    '## Agent Output Visibility',
    `Oompa run files are saved to: ${runsDir}/`,
    'Key files:',
    '- started.json — swarm config, worker definitions, planner/reviewer setup',
    '- cycles/<worker>-c<N>.json — per-cycle outcomes (merged/rejected/error/done)',
    '- reviews/<worker>-c<N>-r<round>.json — reviewer verdicts with full output',
    '- stopped.json — final exit status and reason',
    '',
    `To list run artifacts: ls ${runsDir}/`,
    `To read a review: cat ${runsDir}/reviews/<file>.json`,
    '',
    'Given this context, help the user debug and investigate the swarm run.'
  );
  return lines.join('\n');
}

function summaryLines(summary: SwarmRunSummary): string[] {
  const total = (key: 'merges' | 'rejections' | 'errors') =>
    summary.workers.reduce((s, w) => s + w[key], 0);
  return [
    '',
    '## Run Summary',
    `- Completed: ${summary['total-completed']}`,
    `- Total Cycles: ${summary['total-iterations']}`,
    `- Merges: ${total('merges')}`,
    `- Rejections: ${total('rejections')}`,
    `- Errors: ${total('errors')}`,
    '',
    '## Worker Status',
    'Worker | Harness | Status | Done | Merges | Rej | Err | Reviews',
    '-------|---------|--------|------|--------|-----|-----|--------',
    ...summary.workers.map(
      (w) =>
        `${w.id} | ${w.harness}:${w.model ?? 'default'} | ${w.status} | ${w.completed}/${w.iterations} | ${w.merges} | ${w.rejections} | ${w.errors} | ${w['review-rounds-total']}`
    ),
  ];
}

export function SwarmDetail({ layout }: { layout: SwarmLayout }) {
  const [searchParams] = useSearchParams();
  const projectRoot = searchParams.get('project') ?? '';
  const navigate = useNavigate();
  const location = useLocation();
  // Origin for the mobile chat's back button; inert on desktop, which ignores it.
  const routeState = useMemo(() => mobileConversationRouteState(location), [location]);

  const projectWorkers = useAtomValue(swarmWorkersByProjectAtom).get(projectRoot) ?? NO_WORKERS;
  const runtimeSnapshots = useSwarmRuntimeSnapshots(projectRoot ? [projectRoot] : []);
  const runtime = runtimeSnapshots[projectRoot] ?? null;
  const isRunning = useMemo(() => runningFromSnapshot(runtime), [runtime]);
  useTimeTick();

  const [tab, setTab] = useState<SwarmTab>(DEFAULT_TAB[layout]);
  // The run picked in Run Overview; it scopes the worker list and the debug context.
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const runId = selectedRunId ?? runtime?.run?.swarmId ?? runtime?.run?.runId ?? null;

  const grouping = useMemo(
    () => groupExecWorkers(projectWorkers, isRunning, runId),
    [projectWorkers, isRunning, runId]
  );
  const visibility = getWorkerVisibilitySummary(grouping.all, runtime, isRunning);
  const earliest =
    grouping.all.length > 0 ? Math.min(...grouping.all.map((w) => w.createdAt)) : null;

  const startDebugConversation = useCallback(async () => {
    const runs = await fetch(`/api/swarm-runs?dir=${encodeURIComponent(projectRoot)}`)
      .then((res) => (res.ok ? (res.json() as Promise<{ runs: SwarmRun[] }>) : { runs: [] }))
      // Non-critical: the prefix still works without the run summary.
      .catch(() => ({ runs: [] as SwarmRun[] }));
    const run = runId ? runs.runs.find((r) => r.swarmId === runId) : runs.runs[0];
    const id = createConversation({
      workingDirectory: projectRoot,
      config: { provider: 'claude', model: { mode: 'default' }, reasoning: { mode: 'default' } },
      swarmDebugPrefix: buildSwarmDebugPrefix(
        projectRoot,
        runtime?.run?.configPath ?? null,
        runId,
        run
      ),
      kind: { t: 'chat' },
    });
    void navigate(`/chat/${id}`, { state: routeState });
  }, [projectRoot, runId, runtime, navigate, routeState]);

  const back = { to: '/workers', label: 'Swarms' };
  if (!projectRoot) {
    return (
      <SwarmPage
        layout={layout}
        className="swarm-detail"
        back={back}
        title="No project selected"
        subtitle={null}
        actions={null}
      >
        {null}
      </SwarmPage>
    );
  }

  const WorkerView = WORKER_VIEWS[layout];
  const running = visibility.runningWorkers;
  return (
    <SwarmPage
      layout={layout}
      className="swarm-detail"
      back={back}
      title={<span title={projectRoot}>{shortenHomePath(projectRoot)}</span>}
      subtitle={
        <>
          {visibility.totalWorkers} workers · {grouping.all.length} sessions ({grouping.workCount}{' '}
          exec, {grouping.reviewCount} review, {grouping.fixCount} fix)
          {earliest !== null && ` · started ${formatTimeAgo(new Date(earliest))}`}
        </>
      }
      actions={
        <>
          <span className="swarm-badge ui-inline-row" data-running={running > 0}>
            <span className="swarm-dot" data-running={running > 0} />
            {running > 0
              ? `${running} running · ${visibility.totalWorkers - running} idle`
              : 'All idle'}
          </span>
          <button
            type="button"
            className="swarm-btn ui-control"
            onClick={startDebugConversation}
            title="Start a debug conversation about this swarm"
          >
            Debug Conversation
          </button>
          {running > 0 && <SignalControls projectRoot={projectRoot} />}
        </>
      }
    >
      <div className="swarm-detail-tabs ui-row" role="tablist">
        <button
          type="button"
          role="tab"
          className="swarm-detail-tab"
          aria-selected={tab === 'workers'}
          onClick={() => setTab('workers')}
        >
          Workers ({grouping.all.length})
        </button>
        <button
          type="button"
          role="tab"
          className="swarm-detail-tab"
          aria-selected={tab === 'runs'}
          onClick={() => setTab('runs')}
        >
          Run Overview
        </button>
      </div>

      {tab === 'workers' ? (
        <WorkerView
          groups={grouping.groups}
          isRunning={isRunning}
          runId={runId}
          routeState={routeState}
        />
      ) : (
        <SwarmRunsPanel
          projectRoot={projectRoot}
          selectedRunId={selectedRunId}
          onSelectRunId={setSelectedRunId}
        />
      )}

      <div className="swarm-detail-bottom">
        <GitLogPanel projectRoot={projectRoot} />
        <OompaConfigPanel projectRoot={projectRoot} />
      </div>
    </SwarmPage>
  );
}

const SIGNAL_PROMPT = {
  stop: 'Stop swarm? Workers will finish their current cycle.',
  kill: 'Kill swarm immediately? This forcibly terminates all workers.',
};

/** Stop / Kill with an inline confirm (no window.confirm). */
function SignalControls({ projectRoot }: { projectRoot: string }) {
  const [confirm, setConfirm] = useState<'stop' | 'kill' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ask = (action: 'stop' | 'kill') => {
    setError(null);
    setConfirm(action);
  };
  const send = (action: 'stop' | 'kill') => {
    setConfirm(null);
    sendSwarmSignal(projectRoot, action)
      .then((r) => r.ok || setError(`${action} failed: ${r.message}`))
      .catch((e: Error) => setError(`${action} failed: ${e.message}`));
  };
  return (
    <span className="swarm-detail-signals ui-row">
      {confirm === null ? (
        <>
          <button
            type="button"
            className="swarm-btn swarm-detail-signal ui-control"
            data-signal="stop"
            title="Stop swarm gracefully (finish current cycle)"
            onClick={() => ask('stop')}
          >
            Stop
          </button>
          <button
            type="button"
            className="swarm-btn swarm-detail-signal ui-control"
            data-signal="kill"
            title="Kill swarm immediately (SIGKILL)"
            onClick={() => ask('kill')}
          >
            Kill
          </button>
        </>
      ) : (
        <>
          <span className="ui-muted">{SIGNAL_PROMPT[confirm]}</span>
          <button
            type="button"
            className="swarm-btn swarm-detail-signal ui-control"
            data-signal={confirm}
            data-confirm="true"
            onClick={() => send(confirm)}
          >
            Confirm
          </button>
          <button type="button" className="swarm-btn ui-control" onClick={() => setConfirm(null)}>
            Cancel
          </button>
        </>
      )}
      {error && <span className="swarm-error">{error}</span>}
    </span>
  );
}

// =============================================================================
// Wide: roster + parallel transcript panes
// =============================================================================

function WorkerPanes({ groups, isRunning, runId }: WorkerViewProps) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  // On first render and on every run change, jump to the running exec (else the
  // first); otherwise keep the user's pick while it still exists.
  const lastRunIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const reselect = lastRunIdRef.current !== runId;
    lastRunIdRef.current = runId;
    setSelectedIdx((current) => {
      if (!reselect && current < groups.length) return current;
      return Math.max(
        groups.findIndex((g) => isRunning(g.exec)),
        0
      );
    });
  }, [runId, groups, isRunning]);

  const selected = groups[selectedIdx] ?? null;
  const review = selected?.reviews[0] ?? null;

  return (
    <div className="swarm-detail-workers ui-row">
      <div className="swarm-detail-roster ui-stack">
        {groups.map((group, i) => {
          const verdict = latestVerdict(group);
          return (
            <button
              type="button"
              key={group.exec.id}
              className="swarm-detail-roster-row ui-row"
              aria-pressed={i === selectedIdx}
              onClick={() => setSelectedIdx(i)}
            >
              <span className="swarm-dot" data-running={isRunning(group.exec)} />
              <span className="swarm-detail-mono ui-truncate">
                {rowWorker(group.exec)?.workerId ?? group.exec.id.substring(0, 8)}
              </span>
              <span className="ui-muted">{group.exec.messageCount}m</span>
              {group.reviews.length > 0 && (
                <span className="swarm-detail-review-count">{group.reviews.length}r</span>
              )}
              {verdict !== 'pending' && (
                <span className="swarm-verdict-pip" data-verdict={verdict} title={verdict} />
              )}
            </button>
          );
        })}
      </div>
      <div className="swarm-detail-panes ui-row">
        <WorkerChatPane
          conversationId={selected?.exec.id ?? null}
          accent="task"
          running={selected !== null && isRunning(selected.exec)}
        />
        <WorkerChatPane
          conversationId={review?.id ?? null}
          accent="review"
          running={review !== null && isRunning(review)}
        />
      </div>
    </div>
  );
}

const NO_OP_SCROLL = () => {};

function WorkerChatPane({
  conversationId,
  accent,
  running,
}: {
  conversationId: string | null;
  accent: 'task' | 'review';
  running: boolean;
}) {
  const id = conversationId ?? '';
  const conversation = useAtomValue(rowFamily(id));
  const messageGroups = useAtomValue(groupsFamily(id));
  useConversationBodies(conversationId);
  const lastMessageRef = useRef<HTMLDivElement>(null);
  const scrollToBottomRef = useRef<(() => void) | null>(null);

  if (!conversation) {
    return (
      <div className="swarm-detail-pane ui-stack" data-accent={accent}>
        <div className="swarm-empty ui-muted">No {accent} log</div>
      </div>
    );
  }
  const role = rowWorker(conversation)?.role ?? 'work';
  return (
    <div className="swarm-detail-pane ui-stack" data-accent={accent}>
      <div className="swarm-detail-pane-head ui-row">
        <span className="swarm-detail-mono ui-muted">{conversation.id.substring(0, 8)}</span>
        {role !== 'work' && <span className="swarm-detail-role">{role}</span>}
        <span className="swarm-badge ui-inline-row" data-running={running}>
          <span className="swarm-dot" data-running={running} />
          {running ? 'Running' : 'Idle'}
        </span>
      </div>
      <div className="swarm-detail-pane-messages ui-stack">
        <VirtualizedMessageList
          messageGroups={messageGroups}
          isRunning={conversation.run === 'streaming'}
          lastMessageRef={lastMessageRef}
          onScrollStateChange={NO_OP_SCROLL}
          conversationId={conversation.id}
          markMessagesSeen={markMessagesSeen}
          totalMessageCount={conversation.messageCount}
          scrollToBottomRef={scrollToBottomRef}
          workingDirectory={conversation.cwd}
        />
      </div>
    </div>
  );
}

// =============================================================================
// Narrow: stacked exec groups, each worker a link to its chat
// =============================================================================

function WorkerList({ groups, isRunning, routeState }: WorkerViewProps) {
  if (groups.length === 0) {
    return <div className="swarm-empty ui-muted">No workers for this run.</div>;
  }
  return (
    <div className="swarm-detail-groups ui-stack">
      {groups.map((group) => {
        const verdict = latestVerdict(group);
        return (
          <div key={group.exec.id} className="swarm-detail-group ui-stack ui-card">
            <WorkerLink row={group.exec} running={isRunning(group.exec)} routeState={routeState} />
            {verdict !== 'pending' && (
              <span className="swarm-verdict" data-verdict={verdict}>
                {verdict}
              </span>
            )}
            <div className="swarm-detail-snippet ui-muted">
              {group.exec.messageCount > 0 ? group.exec.label : '— no messages —'}
            </div>
            {group.reviews.length > 0 && (
              <div className="swarm-detail-group-reviews ui-stack">
                <span className="ui-muted">
                  {group.reviews.length} review{group.reviews.length === 1 ? '' : 's'} paired
                </span>
                {group.reviews.map((r) => (
                  <WorkerLink key={r.id} row={r} running={isRunning(r)} routeState={routeState} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function WorkerLink({
  row,
  running,
  routeState,
}: {
  row: ConversationRow;
  running: boolean;
  routeState: RouteState;
}) {
  const role = rowWorker(row)?.role ?? 'work';
  return (
    <Link
      className="swarm-detail-worker-link ui-row ui-card"
      to={`/chat/${encodeURIComponent(row.id)}`}
      state={routeState}
    >
      <span className="swarm-dot" data-running={running} />
      <span className="swarm-detail-mono ui-truncate">
        {rowWorker(row)?.workerId ?? row.id.slice(0, 8)}
      </span>
      <span className="ui-muted">{row.messageCount}m</span>
      {role !== 'work' && <span className="swarm-detail-role">{role}</span>}
      <span className="swarm-detail-worker-state ui-muted">{running ? 'Running' : 'Idle'}</span>
    </Link>
  );
}
