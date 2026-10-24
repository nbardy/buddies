import type { UnifiedAgentEvent } from '@nbardy/agent-cli';
import type { Provider, SubAgent } from '@unleashd/shared';
import { getSubagentDescription, isSubagentSpawnTool } from '../subagent-tools';

/**
 * Sub-agent tracking for one turn's tool stream. Harnesses differ only here,
 * so the fold is chosen ONCE per turn from `SUB_AGENT_FOLDS` (a harness
 * capability table) and the turn fold never asks "which provider?" again.
 * Codex collab threads (spawn_agent / wait / send_input) are the one native
 * sub-agent protocol; every other harness uses the generic Task-style fold.
 */

type ToolUseEvent = Extract<UnifiedAgentEvent, { type: 'tool.use' }>;
type NativeStateEvent = Extract<UnifiedAgentEvent, { type: 'subagent.state' }>;
type TaskStartedEvent = Extract<UnifiedAgentEvent, { type: 'task.started' }>;
type TaskFinishedEvent = Extract<UnifiedAgentEvent, { type: 'task.finished' }>;

export interface SubAgentHost {
  readonly conversationId: string;
  /** The conversation's live list; folds mutate it in place. */
  readonly agents: SubAgent[];
  /** One agent changed: its whole record goes out as a `subagent` patch. */
  changed(agent: SubAgent): void;
  newId(): string;
}

/** Whether the tool still renders as a transcript line after the sub-agent fold saw it. */
export type ToolLine = 'show' | 'hide';

interface ToolFold {
  toolUse(host: SubAgentHost, event: ToolUseEvent): ToolLine;
  /** The harness started a task: bind it to the sub-agent its tool call spawned. */
  taskStarted(host: SubAgentHost, event: TaskStartedEvent): void;
  /** The harness says a task ended: that is the sub-agent's real end. */
  taskFinished(host: SubAgentHost, event: TaskFinishedEvent): void;
  /** The parent turn completed: settle the agents this harness only infers. */
  parentCompleted(host: SubAgentHost, completedAt: Date): void;
}

export interface SubAgentFold extends ToolFold {
  state(host: SubAgentHost, event: NativeStateEvent): void;
}

/**
 * A background `Agent` returns its tool_result ("Async agent launched") at once and keeps running;
 * only the harness's task events say when it ends (agent-cli `task.started` / `task.finished`,
 * Claude's task_started / task_notification). The spawn tool.use carries no tool-call id, so
 * `task.started` is bound to the spawn by the launch description it repeats verbatim, and the
 * sub-agent keeps the call id as `providerThreadId` for `task.finished`. A sub-agent whose task
 * never finishes settles by the turn-end rule (`parentCompleted` / `failRunningSubAgents`).
 * Guard: conversation-runtime.test.ts "a recorded background agent stays running until its task
 * finishes".
 */
function genericFold(provider: Provider): ToolFold {
  // This turn's spawns still waiting for their task.started, keyed by launch description.
  const launches: { description: unknown; agent: SubAgent }[] = [];
  return {
    toolUse(host, event) {
      if (isSubagentSpawnTool(provider, event.name)) {
        const agent = spawnGenericAgent(host, provider, event);
        launches.push({ description: event.input.description, agent });
        return 'hide';
      }
      noteActiveAgentTool(host, event);
      return 'show';
    },
    taskStarted(_host, event) {
      const index = launches.findIndex((launch) => launch.description === event.description);
      if (index < 0) return; // a task no spawn launched (a shell, a nested agent's tool)
      const [{ agent }] = launches.splice(index, 1);
      agent.providerThreadId = event.toolUseId;
    },
    taskFinished(host, event) {
      const agent = host.agents.find((a) => a.providerThreadId === event.toolUseId);
      if (!agent || agent.status !== 'running') return;
      agent.status = event.status === 'completed' ? 'completed' : 'error';
      agent.rawStatus = event.status;
      agent.statusSource = 'native';
      agent.completedAt = new Date();
      agent.currentAction = agent.status === 'completed' ? 'Done' : 'Error';
      host.changed(agent);
    },
    parentCompleted(host, completedAt) {
      completeRunning(host, completedAt, () => true);
    },
  };
}

function spawnGenericAgent(host: SubAgentHost, provider: Provider, event: ToolUseEvent): SubAgent {
  const description = getSubagentDescription(provider, event.name, event.input);
  const blockId = (event.input as { _blockId?: string })._blockId || host.newId();
  const subAgent: SubAgent = {
    id: blockId,
    description,
    status: 'running',
    toolUses: 0,
    tokens: 0,
    currentAction: undefined,
    startedAt: new Date(),
  };
  host.agents.push(subAgent);
  console.log(
    `[${host.conversationId}] Sub-agent started: ${blockId.substring(0, 8)} - "${description.substring(0, 50)}"`
  );
  host.changed(subAgent);
  return subAgent;
}

/** A non-spawn tool is attributed to the running sub-agent as its current action. */
function noteActiveAgentTool(host: SubAgentHost, event: ToolUseEvent): void {
  const activeAgent = host.agents.find((a) => a.status === 'running');
  if (!activeAgent) return;
  const input = event.input as { file_path?: string; path?: string };
  const filePath = input.file_path || input.path;
  activeAgent.toolUses += 1;
  activeAgent.currentAction = filePath
    ? `${event.name}: ${filePath.split('/').pop() || filePath}`
    : event.name;
  host.changed(activeAgent);
}

function completeRunning(
  host: SubAgentHost,
  completedAt: Date,
  inferred: (agent: SubAgent) => boolean
): void {
  for (const agent of host.agents) {
    if (agent.status !== 'running' || !inferred(agent)) continue;
    agent.status = 'completed';
    agent.completedAt = completedAt;
    if (!agent.statusSource) agent.statusSource = 'inferred_parent_completion';
    agent.currentAction = 'Done';
    console.log(`[${host.conversationId}] Sub-agent completed: ${agent.id.substring(0, 8)}`);
    host.changed(agent);
  }
}

/** A timed-out parent turn fails every sub-agent still running under it. */
export function failRunningSubAgents(agents: SubAgent[], completedAt: Date): void {
  for (const agent of agents) {
    if (agent.status !== 'running') continue;
    agent.status = 'error';
    agent.completedAt = completedAt;
    agent.currentAction = 'Parent turn timed out';
  }
}

// Pattern: parse-dont-validate (docs/patterns.md#parse-dont-validate)
/** agent-cli owns raw status, child IDs and display text; this handler owns the live row. */
function applyNativeState(host: SubAgentHost, event: NativeStateEvent): void {
  let agent = host.agents.find((a) => a.id === event.id || a.providerThreadId === event.id);
  if (!agent) {
    agent = {
      id: event.id,
      description: event.description,
      status: event.status,
      toolUses: 0,
      tokens: 0,
      startedAt: new Date(),
    };
    host.agents.push(agent);
  }
  if (event.operation === 'spawn') {
    agent.description = event.description;
  }
  const wasTerminal = agent.status === 'completed' || agent.status === 'error';
  agent.providerThreadId = event.id;
  agent.status = event.status;
  agent.rawStatus = event.rawStatus;
  agent.statusSource = 'native';
  if (event.operation !== 'spawn') agent.toolUses += 1;
  const terminal = event.status === 'completed' || event.status === 'error';
  if (terminal) {
    agent.completedAt ??= new Date();
    agent.currentAction = event.status === 'error' ? 'Error' : 'Done';
  } else {
    agent.completedAt = undefined;
    agent.currentAction = event.message ?? (wasTerminal ? undefined : agent.currentAction);
  }
  host.changed(agent);
}

function nativeFold(): ToolFold {
  return {
    // Parent tool calls do not identify work by a particular native child.
    // A childless completion still reaches no-tools guards; its started line already rendered.
    // Guard: conversation-runtime.test.ts "a childless Codex collab completion keeps one visible attempt".
    toolUse: (_host, event) => (event.phase === 'completed' ? 'hide' : 'show'),
    taskStarted() {},
    taskFinished() {},
    parentCompleted(host, completedAt) {
      completeRunning(host, completedAt, (agent) => !agent.providerThreadId);
    },
  };
}

// Pattern: table-driven (docs/patterns.md#table-driven)
/** Harness capability table: which sub-agent protocol each harness speaks. One fold per turn. */
const SUB_AGENT_FOLDS: Record<Provider, () => ToolFold> = {
  claude: () => genericFold('claude'),
  codex: nativeFold,
  gemini: () => genericFold('gemini'),
  opencode: () => genericFold('opencode'),
  cursor: () => genericFold('cursor'),
  muse: () => genericFold('muse'),
  pi: () => genericFold('pi'),
};

/** A fresh fold for one turn of `provider`. */
export function subAgentFoldFor(provider: Provider): SubAgentFold {
  const applied = new Set<string>();
  return {
    ...SUB_AGENT_FOLDS[provider](),
    state(host, event) {
      // A replay must not double-count or reopen a child. IDs are only unique within this turn.
      // Guard: conversation-runtime.test.ts "native sub-agent operations are applied once".
      const key = event.operationId && JSON.stringify([event.id, event.operationId]);
      if (key && applied.has(key)) return;
      if (key) applied.add(key);
      applyNativeState(host, event);
    },
  };
}
