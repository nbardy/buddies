import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { executionProcess, killExecution } from '@nbardy/agent-cli';
import { z } from 'zod';
import { appDataDirectory } from '../app-data';
import { type Execution, holdsGrant } from '../turns/execution-state';
import { type OompaOwner, createExecutionJournals } from '../turns/executions';
import type { BuddiesCore } from './core';
import { decideExecutionGate } from './execution-gate';
import type { BuddyGrant, Grants, TurnGrant } from './grants';
import {
  Amendment,
  Portfolio,
  Prerequisite,
  amendmentDelta,
  portfolioTask,
  stable,
} from './oompa-portfolio';

const exec = promisify(execFile);
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const atomic = (file: string, data: unknown) => {
  fs.writeFileSync(`${file}.tmp`, `${JSON.stringify(data)}\n`, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
};
const read = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8'));
const Validator = z
  .object({
    command: z.array(z.string().min(1)).min(1),
    timeout_seconds: z.number().int().positive().max(43_200),
    reconcile_on_rejection: z.boolean().optional(),
    source_files: z
      .record(z.string().regex(/^[a-f0-9]{64}$/))
      .refine((x) => Object.keys(x).length > 0),
  })
  .strict();
const Backend = z
  .object({
    type: z.literal('buddies'),
    workspace_id: z.string().min(1),
    buddy_id: z.string().min(1),
    task_ids: z.array(z.string().min(1)).min(1),
    url_env: z.literal('OOMPA_BUDDY_MCP_URL').optional(),
    token_env: z.literal('OOMPA_BUDDY_MCP_TOKEN').optional(),
    authorization_env: z.literal('AGENT_CLI_MCP_UNLEASHD_BUDDY__AUTHORIZATION').optional(),
    owner_by_task: z.record(z.string()).optional(),
    dependencies: z.record(z.array(z.string())).optional(),
  })
  .strict();
const Config = z
  .object({
    task_backend: Backend,
    task_execution: z
      .object({ validators: z.record(Validator) })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const OompaAction = z.discriminatedUnion('kind', [
  Amendment,
  Prerequisite,
  z
    .object({
      kind: z.literal('launch'),
      workspaceId: z.string().min(1),
      buddyId: z.string().min(1),
      workspacePath: z.string().min(1),
      configPath: z.string().min(1),
      maxSeconds: z.number().int().positive().max(43_200),
      automationSeconds: z.number().int().positive().max(43_200).optional(),
      priorRunId: z.string().min(1).optional(),
      resumeRunId: z.string().min(1).optional(),
      amendmentId: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      portfolio: Portfolio.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('continue'),
      runId: z.string().min(1),
      swarmId: z.string().regex(/^[a-zA-Z0-9_-]+$/),
      taskId: z.string().min(1),
      baseRevision: z.number().int().positive(),
      workspacePath: z.string().min(1),
      sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
      command: Validator.shape.command,
      sourceFiles: Validator.shape.source_files,
      maxSeconds: z.number().int().positive().max(600),
    })
    .strict(),
  z.object({ kind: z.literal('status'), runId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('stop'), runId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('drain'), runId: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('requeue'),
      runId: z.string().min(1),
      taskId: z.string().min(1),
      baseRevision: z.number().int().positive(),
      reason: z.string().trim().min(1).max(2000),
    })
    .strict(),
]);
export const OompaAccept = z
  .object({
    kind: z.literal('accept'),
    taskId: z.string().min(1),
    baseRevision: z.number().int().positive(),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    workspacePath: z.string().min(1),
  })
  .strict();
type Accept = z.infer<typeof OompaAccept>;
type Continue = Extract<z.infer<typeof OompaAction>, { kind: 'continue' }>;
type Requeue = Extract<z.infer<typeof OompaAction>, { kind: 'requeue' }>;
type RequeueRecord = {
  request: Requeue;
  requestHash: string;
  heldSha256: string;
  deadline: number;
  nextAction: string;
  phase: 'requesting' | 'applied';
  task?: Awaited<ReturnType<BuddiesCore['getTask']>>;
};
const MissingReviewerHold = z
  .object({
    task_id: z.string(),
    claim_revision: z.number().int().positive(),
    held_reason: z.literal('execution-blocked'),
    feedback: z
      .object({
        error: z.literal('Framework prompt not found: config/prompts/_framework/reviewer.md'),
      })
      .passthrough(),
    attempt: z.number().int().positive(),
    attempt_history: z.array(z.unknown()).min(1),
    session_id: z.string().min(1),
    workspace: z.object({ path: z.string().min(1) }).passthrough(),
    deadline_ms: z.number().positive(),
    blocked_result: z.never().optional(),
  })
  .passthrough();
type Continuation = {
  request: Continue;
  key: string;
  requestHash: string;
  deadline: number;
  phase: 'requesting' | 'started' | 'failed';
  reason?: string;
};
type Run = { owner: OompaOwner; execution: Execution };
type Drain = { id: string; key: string; swarmId: string; phase: 'requested' | 'signaling' };
type Validation = {
  request: Accept;
  evidence: string[];
  phase: 'started' | 'accepted' | 'rejected';
  reason?: string;
};

/** Remove owner and turn credentials before either Oompa or an oracle inherits its environment. */
function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/^(UNLEASHD_AUTH_|OOMPA_BUDDY_MCP_|AGENT_CLI_MCP_|OOMPA_CONTINUATION_|OOMPA_OWNER_WINDOW_|BUDDIES_.*TOKEN)/.test(
          name
        )
    )
  );
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', ['-C', cwd, ...args], { maxBuffer: 2_000_000 })).stdout.trim();
}
async function common(cwd: string): Promise<string> {
  return fs.realpathSync(path.resolve(cwd, await git(cwd, 'rev-parse', '--git-common-dir')));
}
async function registered(base: string, candidate: string): Promise<string> {
  const real = fs.realpathSync(candidate);
  if ((await common(base)) !== (await common(real)))
    throw new Error('workspace is not this repository');
  const roots = (await git(base, 'worktree', 'list', '--porcelain'))
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => fs.realpathSync(line.slice(9)));
  if (!roots.includes(real)) throw new Error('workspace is not a registered Git worktree');
  return real;
}
async function cleanCommit(cwd: string): Promise<string> {
  if (await git(cwd, 'status', '--porcelain')) throw new Error('workspace must be clean');
  return git(cwd, 'rev-parse', 'HEAD');
}
async function pins(cwd: string, validator: z.infer<typeof Validator>): Promise<void> {
  const root = fs.realpathSync(cwd);
  for (const [relative, expected] of Object.entries(validator.source_files)) {
    const resolved = fs.realpathSync(path.resolve(root, relative));
    if (
      path.isAbsolute(relative) ||
      relative.split('/').includes('..') ||
      !resolved.startsWith(`${root}${path.sep}`)
    )
      throw new Error('validator pin must be inside the candidate');
    await git(cwd, 'ls-files', '--error-unmatch', '--', relative);
    if (sha(fs.readFileSync(resolved)) !== expected)
      throw new Error(`validator source pin changed: ${relative}`);
  }
}

/** A concrete Oompa host over existing execution journals and phase transitions, not another task store. */
// Pattern: persisted-state-machine (docs/patterns.md#persisted-state-machine)
export function createOompaHost(options: {
  core: BuddiesCore;
  grants: Grants;
  url(): string;
  root?: string;
  executable?: string;
  wrapper?: string;
  now?: () => number;
}) {
  const root = options.root ?? path.join(appDataDirectory(), 'oompa-executions');
  const journals = createExecutionJournals(root);
  const runs = new Map<string, Run>();
  const accepts = new Map<string, Promise<unknown>>();
  const registering = new Set<string>();
  const draining = new Set<string>();
  const now = options.now ?? Date.now;
  const wrapper = options.wrapper ?? path.resolve(__dirname, '../../relay/oompa-run-host.mjs');
  const executable =
    options.executable ??
    process.env.UNLEASHD_OOMPA_EXECUTABLE ??
    path.join(os.homedir(), 'git/oompa_loompas/swarm.bb');

  function signal(dir: string) {
    const process = executionProcess(dir);
    if (process.t === 'live') killExecution(process.pid, dir);
  }
  function continuations(run: Run) {
    const root = path.join(run.execution.dir, 'continuations');
    return fs.existsSync(root)
      ? fs
          .readdirSync(root)
          .filter((name) => /^[a-f0-9]{64}$/.test(name))
          .map((name) => {
            const dir = path.join(root, name);
            return { dir, record: read<Continuation>(path.join(dir, 'continuation.json')) };
          })
      : [];
  }
  function releaseRequest(run: Run, id: string) {
    const file = path.join(run.execution.dir, 'continuation-request.json');
    if (fs.existsSync(file) && read<{ id: string }>(file).id === id) fs.unlinkSync(file);
  }
  function childActive(dir: string) {
    if (executionProcess(dir).t !== 'ended') return true;
    // exit.json precedes the wrapper's final group kill. Do not resume the
    // task loop in that gap; wait until its exact wrapper is gone.
    try {
      const pid = fs.readFileSync(path.join(dir, 'pid'), 'utf8').trim();
      return execFileSync('ps', ['-p', pid, '-o', 'command='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).includes(dir);
    } catch {
      return false;
    }
  }
  function refreshContinuations(run: Run) {
    for (const { dir, record } of continuations(run)) {
      if (
        !registering.has(run.owner.id) &&
        (!childActive(dir) ||
          (record.phase === 'requesting' && executionProcess(dir).t === 'unstarted'))
      ) {
        if (record.phase === 'requesting')
          atomic(path.join(dir, 'continuation.json'), {
            ...record,
            phase: 'failed',
            reason: 'host restarted before diagnostic spawn',
          });
        releaseRequest(run, path.basename(dir));
      }
    }
  }
  function stopChildren(run: Run) {
    for (const kind of ['validations', 'continuations']) {
      const root = path.join(run.execution.dir, kind);
      if (fs.existsSync(root))
        for (const name of fs.readdirSync(root)) signal(path.join(root, name));
    }
  }
  function automationRoot(run: Run) {
    return run.owner.automation && runs.get(run.owner.automation.rootRunId);
  }
  function revoked(run: Run) {
    const authorization = run.owner.automation;
    // Boot scan order must not briefly re-adopt a successor before its revoked root is loaded.
    return (
      !!authorization &&
      fs.existsSync(path.join(root, authorization.rootRunId, 'automation-revoked.json'))
    );
  }
  // Pattern: capability-grants (docs/patterns.md#capability-grants)
  // Scheduled turns previously needed a fresh owner every chunk. Only the original launch Buddy
  // may exercise this immutable journaled scope; guard: oompa-mcp overnight delegation.
  function delegated(grant: TurnGrant, run: Run, allowOwner = false) {
    const authorization = run.owner.automation;
    if (
      (grant.role !== 'worker' && !(allowOwner && grant.role === 'owner')) ||
      grant.oompa ||
      !authorization ||
      !automationRoot(run) ||
      grant.buddyId !== authorization.buddyId ||
      grant.workspaceId !== authorization.workspaceId ||
      authorization.expiresAt <= now() ||
      revoked(run)
    )
      throw new Error('Oompa operation requires active owner delegation for this launch Buddy');
    return authorization;
  }
  function revokeAutomation(run: Run) {
    const root = automationRoot(run);
    if (!root) return;
    atomic(path.join(root.execution.dir, 'automation-revoked.json'), { revokedAt: now() });
    for (const sibling of runs.values())
      if (sibling !== run && sibling.owner.automation?.rootRunId === root.owner.id)
        stop(sibling, true);
  }
  function stop(run: Run, timeout = false, preserveAutomation = false) {
    if (!timeout && !preserveAutomation) revokeAutomation(run);
    if (run.execution.phase.t === 'running') {
      journals.step(run.execution, {
        t: 'stop',
        intent: timeout
          ? {
              t: 'timeout',
              terminalCause: 'max_runtime_timeout',
              message: 'Oompa execution deadline expired',
            }
          : { t: 'user_stop' },
      });
    }
    options.grants.revokeRun(run.owner.id);
    signal(run.execution.dir);
    stopChildren(run);
  }
  function refresh(run: Run) {
    refreshContinuations(run);
    if (run.execution.phase.t === 'stopping' && executionProcess(run.execution.dir).t !== 'live') {
      journals.step(run.execution, {
        t: 'drained',
        observed: { t: 'complete', text: 'Oompa process drained' },
      });
      return;
    }
    if (run.execution.phase.t !== 'running') {
      stopChildren(run);
      return;
    }
    if (run.owner.grant.expiresAt <= now() || revoked(run)) return stop(run, true);
    if (executionProcess(run.execution.dir).t !== 'live') {
      journals.step(run.execution, {
        t: 'drained',
        observed: { t: 'complete', text: 'Oompa process exited' },
      });
      options.grants.revokeRun(run.owner.id);
      stopChildren(run);
    } else void advanceDrain(run);
  }
  function view(run: Run) {
    refresh(run);
    return {
      runId: run.owner.id,
      status: run.execution.phase.t,
      expiresAt: run.owner.grant.expiresAt,
      originalExpiresAt: run.owner.originalExpiresAt ?? run.owner.grant.expiresAt,
      priorRunId: run.owner.priorRunId,
      resumeRunId: run.owner.resumeRunId,
      automation: run.owner.automation
        ? {
            ...run.owner.automation,
            revoked: revoked(run),
          }
        : undefined,
      workspacePath: run.owner.workspacePath,
      taskIds: run.owner.grant.oompa!.taskIds,
      configSha256: run.owner.configSha256 ?? run.owner.automation?.configSha256,
      queueAudit: graphAudit(run),
      logDirectory: run.execution.dir,
      drain: fs.existsSync(path.join(run.execution.dir, 'drain.json'))
        ? read<Drain>(path.join(run.execution.dir, 'drain.json'))
        : undefined,
      continuations: continuations(run).map(({ dir, record }) => ({
        ...record,
        status: record.phase === 'failed' ? 'failed' : executionProcess(dir).t,
        logDirectory: dir,
        stdoutPath: path.join(dir, 'stdout'),
        stderrPath: path.join(dir, 'stderr'),
        exitPath: path.join(dir, 'exit.json'),
        exit: fs.existsSync(path.join(dir, 'exit.json'))
          ? read<{ status: number }>(path.join(dir, 'exit.json'))
          : null,
      })),
    };
  }
  function spawnOwned(
    dir: string,
    deadline: number,
    argv: string[],
    cwd: string,
    env: NodeJS.ProcessEnv
  ) {
    fs.writeFileSync(path.join(dir, 'stdout'), '', { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'stderr'), '', { mode: 0o600 });
    const out = fs.openSync(path.join(dir, 'stdout'), 'a');
    const err = fs.openSync(path.join(dir, 'stderr'), 'a');
    try {
      const child = spawn(process.execPath, [wrapper, dir, String(deadline), ...argv], {
        cwd,
        env,
        detached: true,
        stdio: ['ignore', out, err],
      });
      child.on('error', () => {
        atomic(path.join(dir, 'exit.json'), { status: 125 });
      });
      if (!child.pid) throw new Error('Could not start Oompa execution host');
      fs.writeFileSync(path.join(dir, 'pid'), String(child.pid), { mode: 0o600 });
      child.unref();
    } finally {
      fs.closeSync(out);
      fs.closeSync(err);
    }
  }

  // Idle snapshots alone raced the task loop. Every original worker must acknowledge
  // the persisted request before argv starts; guard: oompa-mcp bounded continuation.
  async function idle(run: Run, swarmId: string, acknowledgement?: string) {
    const dir = path.join(run.owner.workspacePath, 'runs', swarmId);
    const started = read<{
      'swarm-id': string;
      'config-file': string;
      'continuation-control-dir'?: string;
      pid: number;
      workers: { id: string }[];
    }>(path.join(dir, 'started.json'));
    const log = fs.readFileSync(path.join(run.execution.dir, 'stdout'), 'utf8');
    const parent = executionProcess(run.execution.dir);
    if (
      parent.t !== 'live' ||
      started['swarm-id'] !== swarmId ||
      started['config-file'] !== path.join(run.execution.dir, 'config.json') ||
      !log.includes(`Started event written to runs/${swarmId}/started.json`) ||
      !Number.isInteger(started.pid) ||
      started.pid <= 0 ||
      fs.existsSync(path.join(dir, 'stopped.json'))
    )
      throw new Error('cannot prove the exact active Oompa swarm identity');
    if (started['continuation-control-dir'] !== run.execution.dir)
      throw new Error('Oompa host needs restart with continuation handshake support');
    const group = (await exec('ps', ['-p', String(started.pid), '-o', 'pgid='])).stdout.trim();
    if (Number(group) !== parent.pid) throw new Error('Oompa swarm process is outside its host');
    if (!started.workers?.length) throw new Error('unknown Oompa worker state');
    for (const worker of started.workers) {
      if (!/^[a-zA-Z0-9_-]+$/.test(worker.id)) throw new Error('invalid Oompa worker identity');
      const state = read<{
        status: string;
        reason: string;
        'worker-id': string;
        'updated-at': string;
        execution: {
          task_id?: string;
          phase?: string;
          host_continuation_id?: string;
          queue_audit?: { state?: string };
        };
      }>(path.join(dir, 'workers', `${worker.id}.json`));
      const age = now() - Date.parse(state['updated-at']);
      // A worker that durably stopped for queue reconciliation cannot write a fresh
      // handshake. Its matching audit and empty execution prove it holds no task.
      // Guard: oompa-mcp terminal-worker drain.
      const terminal =
        state.status === 'stopped' &&
        state.reason === 'needs-reconciliation' &&
        state.execution?.queue_audit?.state === 'needs-reconciliation';
      if (
        state['worker-id'] !== worker.id ||
        (!terminal && state.status !== 'waiting') ||
        !Number.isFinite(age) ||
        age < -1000 ||
        (!terminal && age > 5000) ||
        !state.execution ||
        state.execution.task_id ||
        state.execution.phase ||
        (acknowledgement &&
          !terminal &&
          (state.reason !== 'host-continuation' ||
            state.execution.host_continuation_id !== acknowledgement))
      )
        throw new Error('Oompa worker is active, stale or has not acknowledged the diagnostic');
    }
  }
  function resumeSwarm(run: Run) {
    const log = fs.readFileSync(path.join(run.execution.dir, 'stdout'), 'utf8');
    const ids = [
      ...log.matchAll(/Started event written to runs\/([a-zA-Z0-9_-]+)\/started\.json/g),
    ];
    if (ids.length !== 1) throw new Error('cannot prove the prior Oompa swarm identity');
    const id = ids[0][1];
    const started = read<{ 'swarm-id': string; 'config-file': string }>(
      path.join(run.owner.workspacePath, 'runs', id, 'started.json')
    );
    if (
      started['swarm-id'] !== id ||
      started['config-file'] !== path.join(run.execution.dir, 'config.json')
    )
      throw new Error('prior Oompa swarm does not match its pinned host configuration');
    return id;
  }
  // Pattern: persisted-state-machine (docs/patterns.md#persisted-state-machine)
  // Reloading a harness must wait for the current task checkpoint, not kill a live model or
  // revoke overnight renewal. Reuse the worker idle acknowledgement; guard: oompa-mcp drain.
  async function advanceDrain(run: Run) {
    const file = path.join(run.execution.dir, 'drain.json');
    if (draining.has(run.owner.id) || !fs.existsSync(file) || run.execution.phase.t !== 'running')
      return;
    draining.add(run.owner.id);
    try {
      const record = read<Drain>(file);
      const control = path.join(run.execution.dir, 'continuation-request.json');
      // Recover a crash between the durable drain intent and its worker control projection.
      if (!fs.existsSync(control))
        atomic(control, { id: record.id, deadline_ms: run.owner.grant.expiresAt });
      if (registering.has(run.owner.id) || activeChild(run)) return;
      await idle(run, record.swarmId, record.id);
      if (run.execution.phase.t !== 'running' || registering.has(run.owner.id) || activeChild(run))
        return;
      const request = read<{ id: string }>(
        path.join(run.execution.dir, 'continuation-request.json')
      );
      if (request.id !== record.id) return;
      atomic(file, { ...record, phase: 'signaling' });
      // This is the authorized controller's checkpoint cancellation, not an explicit owner Stop.
      // Persist stopping before signaling, retain the original automation for priorRunId renewal.
      stop(run, false, true);
    } catch {
      // Active workers and validators are expected while a drain waits for their checkpoint.
    } finally {
      draining.delete(run.owner.id);
    }
  }
  function requestDrain(run: Run, key: string) {
    const file = path.join(run.execution.dir, 'drain.json');
    if (fs.existsSync(file)) return view(run);
    refresh(run);
    if (run.execution.phase.t !== 'running')
      throw new Error('Oompa execution is no longer running');
    if (
      registering.has(run.owner.id) ||
      fs.existsSync(path.join(run.execution.dir, 'continuation-request.json'))
    )
      throw new Error('Oompa diagnostic handshake is active');
    const record: Drain = {
      id: sha(`drain:${key}`),
      key,
      swarmId: resumeSwarm(run),
      phase: 'requested',
    };
    atomic(file, record);
    atomic(path.join(run.execution.dir, 'continuation-request.json'), {
      id: record.id,
      deadline_ms: run.owner.grant.expiresAt,
    });
    return view(run);
  }
  function activeChild(run: Run) {
    for (const kind of ['validations', 'continuations']) {
      const root = path.join(run.execution.dir, kind);
      if (fs.existsSync(root))
        for (const name of fs.readdirSync(root)) {
          if (kind === 'continuations' && !/^[a-f0-9]{64}$/.test(name)) continue;
          const dir = path.join(root, name);
          if (
            kind === 'continuations' &&
            read<Continuation>(path.join(dir, 'continuation.json')).phase === 'failed' &&
            executionProcess(dir).t === 'unstarted'
          )
            continue;
          if (childActive(dir)) return true;
        }
    }
    return false;
  }
  // Pattern: idempotency-keys (docs/patterns.md#idempotency-keys)
  async function continueRun(run: Run, request: Continue, key: string) {
    const id = sha(key);
    const dir = path.join(run.execution.dir, 'continuations', id);
    const recordPath = path.join(dir, 'continuation.json');
    const requestHash = sha(JSON.stringify(request));
    if (fs.existsSync(recordPath)) {
      if (read<Continuation>(recordPath).requestHash !== requestHash)
        throw new Error('Oompa continuation key was already used for different input');
      return view(run);
    }
    if (fs.existsSync(path.join(run.execution.dir, 'drain.json')))
      throw new Error('Oompa drain is waiting for its checkpoint');
    if (registering.has(run.owner.id) || activeChild(run))
      throw new Error('Oompa implementation, validator or continuation is active');
    registering.add(run.owner.id);
    try {
      refresh(run);
      if (run.execution.phase.t !== 'running')
        throw new Error('Oompa execution is no longer running');
      if (!fs.existsSync(path.join(run.execution.dir, 'continuation-control.json')))
        throw new Error('Oompa host needs restart with continuation handshake support');
      if (!run.owner.grant.oompa!.taskIds.includes(request.taskId))
        throw new Error('task is outside this Oompa execution');
      const config = Config.parse(read<unknown>(path.join(run.execution.dir, 'config.json')));
      const task = await options.core.getTask(request.taskId);
      if (
        task.workspaceId !== run.owner.grant.workspaceId ||
        task.ownerId !==
          (config.task_backend.owner_by_task?.[task.id] ?? config.task_backend.buddy_id)
      )
        throw new Error('task owner or workspace changed');
      if (
        task.revision !== request.baseRevision ||
        task.paused ||
        ['done', 'cancelled'].includes(task.status)
      )
        throw new Error('task revision or status changed');
      const workspacePath = await registered(run.owner.workspacePath, request.workspacePath);
      if ((await cleanCommit(workspacePath)) !== request.sourceCommit)
        throw new Error('diagnostic source commit does not match request');
      const validator = run.owner.validators[request.taskId];
      if (validator) await pins(workspacePath, validator);
      await pins(workspacePath, {
        command: request.command,
        timeout_seconds: request.maxSeconds,
        source_files: request.sourceFiles,
      });
      await idle(run, request.swarmId);
      const deadline = now() + request.maxSeconds * 1000;
      if (deadline > run.owner.grant.expiresAt)
        throw new Error('diagnostic exceeds original Oompa deadline');
      const childJournals = createExecutionJournals(path.dirname(dir));
      const preparing = childJournals.ephemeral(`Oompa diagnostic ${request.taskId}`);
      const record: Continuation = { request, key, requestHash, deadline, phase: 'requesting' };
      atomic(path.join(preparing, 'continuation.json'), record);
      fs.renameSync(preparing, dir);
      atomic(path.join(run.execution.dir, 'continuation-request.json'), {
        id,
        deadline_ms: deadline,
      });
      const end = Math.min(deadline, now() + 5000);
      let acknowledged = false;
      while (now() < end) {
        refresh(run);
        if (run.execution.phase.t !== 'running')
          throw new Error('Oompa stopped during diagnostic handshake');
        try {
          await idle(run, request.swarmId, id);
          acknowledged = true;
          break;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      if (!acknowledged)
        throw new Error(
          'Oompa worker did not acknowledge diagnostic; host needs handshake support'
        );
      const current = await options.core.getTask(request.taskId);
      if (current.revision !== request.baseRevision)
        throw new Error('task changed during diagnostic handshake');
      if ((await cleanCommit(workspacePath)) !== request.sourceCommit)
        throw new Error('diagnostic source changed during handshake');
      await pins(workspacePath, {
        command: request.command,
        timeout_seconds: request.maxSeconds,
        source_files: request.sourceFiles,
      });
      refresh(run);
      if (run.execution.phase.t !== 'running' || deadline <= now())
        throw new Error('Oompa diagnostic deadline expired');
      atomic(recordPath, { ...record, phase: 'started' });
      spawnOwned(dir, deadline, request.command, workspacePath, {
        ...cleanEnv(),
        OOMPA_TASK_ID: request.taskId,
        OOMPA_SOURCE_COMMIT: request.sourceCommit,
        OOMPA_CONTINUATION_CONTROL_DIR: run.execution.dir,
        OOMPA_CONTINUATION_ID: id,
      });
      return view(run);
    } catch (error) {
      if (fs.existsSync(recordPath))
        atomic(recordPath, {
          ...read<Continuation>(recordPath),
          phase: 'failed',
          reason: String(error),
        });
      if (executionProcess(dir).t === 'live') signal(dir);
      else releaseRequest(run, id);
      throw error;
    } finally {
      registering.delete(run.owner.id);
    }
  }

  function workerStates(run: Run) {
    const id = resumeSwarm(run);
    const dir = path.join(run.owner.workspacePath, 'runs', id);
    const started = read<{ workers: { id: string }[] }>(path.join(dir, 'started.json'));
    return started.workers.map(({ id }) => {
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('invalid worker identity');
      return read<{
        execution: {
          task_id?: string;
          deadline_ms?: number;
          held_executions?: Record<
            string,
            { attempt?: number; session_id?: string; attempt_history?: unknown[] }
          >;
          queue_audit?: { state: string; fingerprint: string };
        };
      }>(path.join(dir, 'workers', `${id}.json`));
    });
  }
  function graphAudit(run: Run) {
    try {
      const audits = workerStates(run)
        .map((state) => state.execution.queue_audit)
        .filter(Boolean);
      return audits.length ? { fingerprint: sha(stable(audits)), workers: audits } : undefined;
    } catch {
      return undefined;
    }
  }
  function baseConfig(run: Run) {
    const config = Config.parse(read<unknown>(path.join(run.execution.dir, 'config.json')));
    config.resume_swarm_id = undefined;
    if (config.task_execution) config.task_execution.owner_window = undefined;
    return config;
  }
  async function amend(grant: TurnGrant, run: Run, action: z.infer<typeof Amendment>, key: string) {
    if (action.ownerScale && (grant.role !== 'owner' || grant.principal.kind !== 'owner'))
      throw new Error('scale amendment requires an owner-authored turn');
    const auth = delegated(grant, run, true);
    if (!auth.portfolio) throw new Error('owner launch has no portfolio delegation');
    latestDrained(run);
    const id = sha(key);
    const dir = path.join(run.execution.dir, 'config-revisions', id);
    const requestHash = sha(stable(action));
    if (fs.existsSync(path.join(dir, 'revision.json'))) {
      const receipt = read<{ requestHash: string }>(path.join(dir, 'revision.json'));
      if (receipt.requestHash !== requestHash)
        throw new Error('amendment key reused with different input');
      return read<unknown>(path.join(dir, 'revision.json'));
    }
    const baseSha = run.owner.configSha256 ?? auth.configSha256;
    if (action.baseConfigSha256 !== baseSha) throw new Error('stale base configuration revision');
    const raw = fs.readFileSync(action.configPath, 'utf8');
    if (raw.length > 1_000_000 || sha(raw) !== action.configSha256)
      throw new Error('amendment configuration digest mismatch');
    if (action.configSha256 === baseSha)
      throw new Error('unchanged configuration; no new reconciliation work');
    const source = await registered(run.owner.workspacePath, action.workspacePath);
    if ((await cleanCommit(source)) !== action.sourceCommit)
      throw new Error('amendment source is not the reviewed clean commit');
    const config = Config.parse(JSON.parse(raw));
    const executed = new Set<string>();
    for (const state of workerStates(run)) {
      if (state.execution.task_id) executed.add(state.execution.task_id);
      for (const [taskId, held] of Object.entries(state.execution.held_executions ?? {}))
        if (held.attempt || held.session_id || held.attempt_history?.length) executed.add(taskId);
    }
    const taskOwners: Record<string, string> = {};
    for (const taskId of config.task_backend.task_ids) {
      const task = await portfolioTask(options.core, auth.portfolio, auth.workspaceId, taskId);
      if (task.status === 'done') executed.add(taskId);
      if (task.revision !== action.taskRevisions[taskId])
        throw new Error('amended canonical task revision changed');
      const owner = config.task_backend.owner_by_task?.[taskId] ?? config.task_backend.buddy_id;
      if (owner !== task.ownerId) throw new Error('amended canonical task owner mismatch');
      taskOwners[taskId] = owner;
    }
    const original = baseConfig(run);
    if (stable(original) === stable(config))
      throw new Error('unchanged semantic configuration; suppress duplicate reconciliation');
    const { changed, readiness } = amendmentDelta(
      original,
      config,
      executed,
      action.ownerScale === true
    );
    for (const [taskId, item] of Object.entries(readiness))
      if (!taskOwners[taskId] || item.required_owner !== taskOwners[taskId])
        throw new Error('readiness ownership mismatch');
    const review = await portfolioTask(
      options.core,
      auth.portfolio,
      auth.workspaceId,
      action.reviewTaskId
    );
    const reviewBinding = `oompa.config-review/v1 ${action.baseConfigSha256} ${action.configSha256} ${action.sourceCommit}`;
    if (
      review.status !== 'done' ||
      review.paused ||
      review.revision !== action.reviewRevision ||
      !auth.portfolio.reviewerIds.includes(review.ownerId) ||
      review.ownerId === auth.buddyId ||
      !review.evidence.includes(reviewBinding)
    )
      throw new Error('missing canonical independent delta review binding');
    for (const taskId of changed) await pins(source, config.task_execution!.validators[taskId]);
    delegated(grant, run, true);
    latestDrained(run);
    if ((await cleanCommit(source)) !== action.sourceCommit)
      throw new Error('reviewed source changed during amendment');
    for (const [taskId, revision] of Object.entries(action.taskRevisions))
      if ((await options.core.getTask(taskId)).revision !== revision)
        throw new Error('reviewed graph changed during amendment');
    if ((await options.core.getTask(action.reviewTaskId)).revision !== action.reviewRevision)
      throw new Error('review changed during amendment');
    delegated(grant, run, true);
    latestDrained(run);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'config.json'), raw, { mode: 0o600 });
    const receipt = {
      amendmentId: id,
      requestHash,
      action,
      taskOwners,
      configSha256: sha(raw),
      configPath: path.join(dir, 'config.json'),
      queueFingerprint: graphAudit(run)?.fingerprint,
    };
    atomic(path.join(dir, 'revision.json'), receipt);
    return receipt;
  }
  async function prerequisite(
    grant: TurnGrant,
    run: Run,
    action: z.infer<typeof Prerequisite>,
    key: string
  ) {
    const auth = delegated(grant, run, true);
    if (!auth.portfolio) throw new Error('owner launch has no portfolio delegation');
    latestDrained(run);
    const receiptPath = path.join(run.execution.dir, 'prerequisites', `${sha(key)}.json`);
    const requestHash = sha(stable(action));
    if (fs.existsSync(receiptPath)) {
      const receipt = read<{ requestHash: string; task: unknown }>(receiptPath);
      if (receipt.requestHash !== requestHash)
        throw new Error('prerequisite key reused with different input');
      return receipt.task;
    }
    await portfolioTask(options.core, auth.portfolio, auth.workspaceId, action.parentTaskId);
    if (
      !(action.role === 'review' ? auth.portfolio.reviewerIds : auth.portfolio.ownerIds).includes(
        action.ownerId
      )
    )
      throw new Error('prerequisite owner outside approved portfolio');
    const buddy = await options.core.getBuddy(action.ownerId);
    if (buddy.workspaceId !== auth.workspaceId || buddy.status === 'archived')
      throw new Error('foreign prerequisite owner');
    delegated(grant, run, true);
    latestDrained(run);
    const task = await options.core.upsertTask(run.owner.grant.principal, {
      kind: 'create',
      parentId: action.parentTaskId,
      ownerId: action.ownerId,
      title: action.title,
      doneCriteria: action.doneCriteria,
      key: `oompa-prerequisite-${auth.rootRunId}-${sha(stable({ ...action, runId: undefined }))}`,
    });
    fs.mkdirSync(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
    atomic(receiptPath, { requestHash, task });
    return task;
  }
  function latestDrained(run: Run) {
    refresh(run);
    if (
      run.execution.phase.t !== 'ended' ||
      childActive(run.execution.dir) ||
      activeChild(run) ||
      [...runs.values()].some((other) => other.owner.priorRunId === run.owner.id)
    )
      throw new Error('requeue requires the latest fully drained Oompa host');
  }
  // Pattern: idempotency-keys (docs/patterns.md#idempotency-keys)
  // Internal missing-reviewer errors left canonical tasks in_progress forever. The owner-delegated
  // controller may reopen only this proven infrastructure hold; guard: oompa-mcp requeue.
  async function requeue(grant: TurnGrant, run: Run, request: Requeue, key: string) {
    const authorization = delegated(grant, run, true);
    if (
      !run.owner.grant.oompa!.taskIds.includes(request.taskId) ||
      !Object.hasOwn(run.owner.taskOwners ?? authorization.taskOwners, request.taskId)
    )
      throw new Error('requeue task is outside the owner delegation');
    const id = sha(key);
    const file = path.join(run.execution.dir, 'requeues', `${id}.json`);
    const requestHash = sha(JSON.stringify(request));
    let record = fs.existsSync(file) ? read<RequeueRecord>(file) : undefined;
    if (record && record.requestHash !== requestHash)
      throw new Error('Oompa requeue key was already used for different input');
    if (record?.phase === 'applied') return { kind: 'requeued', task: record.task, logPath: file };
    if (registering.has(run.owner.id)) throw new Error('Oompa host operation is active');
    registering.add(run.owner.id);
    try {
      latestDrained(run);
      if (!record) {
        const swarmId = resumeSwarm(run);
        const swarmDir = path.join(run.owner.workspacePath, 'runs', swarmId);
        const started = z
          .object({
            workers: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]+$/) })).min(1),
          })
          .parse(read<unknown>(path.join(swarmDir, 'started.json')));
        const held: unknown[] = [];
        for (const worker of started.workers) {
          const state = z
            .object({
              'worker-id': z.literal(worker.id),
              execution: z
                .object({
                  held_executions: z.record(z.unknown()).optional(),
                })
                .passthrough(),
            })
            .passthrough()
            .parse(read<unknown>(path.join(swarmDir, 'workers', `${worker.id}.json`)));
          const candidate = state.execution.held_executions?.[request.taskId];
          if (candidate) held.push(candidate);
        }
        if (held.length !== 1)
          throw new Error('requeue requires one exact persisted internal hold');
        const proof = MissingReviewerHold.parse(held[0]);
        if (
          proof.task_id !== request.taskId ||
          proof.claim_revision !== request.baseRevision ||
          proof.deadline_ms <= now()
        )
          throw new Error('held task claim revision or original deadline changed');
        const candidate = await registered(run.owner.workspacePath, proof.workspace.path);
        const validator = run.owner.validators[request.taskId];
        if (validator) await pins(candidate, validator);
        const task = await options.core.getTask(request.taskId);
        if (
          task.workspaceId !== authorization.workspaceId ||
          task.ownerId !== (run.owner.taskOwners ?? authorization.taskOwners)[task.id] ||
          task.status !== 'in_progress' ||
          task.paused ||
          task.revision !== request.baseRevision
        )
          throw new Error('requeue requires the exact unpaused in_progress task claim and owner');
        record = {
          request,
          requestHash,
          heldSha256: sha(JSON.stringify(held[0])),
          deadline: proof.deadline_ms,
          nextAction: `Retry known missing reviewer framework prompt after repair: ${request.reason} [${run.owner.id}/${id}]`,
          phase: 'requesting',
        };
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        atomic(file, record);
      }
      delegated(grant, run, true);
      latestDrained(run);
      if (record.deadline <= now()) throw new Error('original held task deadline expired');
      const task = await options.core.upsertTask(run.owner.grant.principal, {
        kind: 'update',
        taskId: request.taskId,
        baseRevision: request.baseRevision,
        changes: { status: 'open', nextAction: record.nextAction },
        key: `oompa-requeue-${run.owner.id}-${id}`,
      });
      atomic(file, { ...record, phase: 'applied', task });
      return { kind: 'requeued', task, logPath: file };
    } finally {
      registering.delete(run.owner.id);
    }
  }

  // Restore only the original capability of a live running execution, with its original deadline.
  // A Stop is persisted before signaling; an outage can never restore its authority.
  const gate = decideExecutionGate();
  if (gate.t === 'enabled')
    for (const found of journals.scan()) {
      if (found.t !== 'oompa') continue;
      const run = { owner: found.owner, execution: { dir: found.dir, phase: found.phase } };
      runs.set(found.owner.id, run);
      if (
        holdsGrant(found.phase, found.process.t === 'live' ? 'live' : 'ended') &&
        found.owner.grant.expiresAt > now() &&
        !revoked(run)
      )
        options.grants.adopt(found.owner.grant);
      else if (found.phase.t === 'stopping' || found.owner.grant.expiresAt <= now())
        stop(run, true);
      refresh(run);
    }
  const poll = setInterval(() => {
    for (const run of runs.values()) refresh(run);
  }, 1000);
  poll.unref();

  function forGrant(grant: BuddyGrant): Run {
    const run = grant.oompa && runs.get(grant.oompa.executionId);
    if (!run || run.owner.grant.token !== grant.token) throw new Error('unknown Oompa execution');
    refresh(run);
    if (run.execution.phase.t !== 'running')
      throw new Error('Oompa execution is no longer running');
    return run;
  }

  return {
    guard: forGrant,
    close: () => clearInterval(poll),
    async action(grant: TurnGrant, action: z.infer<typeof OompaAction>, key: string) {
      const ownerInput =
        (grant.role === 'owner' || grant.role === 'builder') && grant.principal.kind === 'owner';
      if (gate.t !== 'enabled') throw new Error(`Oompa execution disabled: ${gate.reason}`);
      if (action.kind !== 'launch') {
        // The scheduled launch Buddy can monitor/stop its own execution after the owner turn
        // settles. A peer or task-scoped child cannot inherit that control. Guard: oompa-mcp.
        if (!ownerInput && (grant.role !== 'worker' || grant.oompa))
          throw new Error('Oompa control requires the launch Buddy or an owner-authored turn');
        const run = runs.get(action.runId);
        if (!run) throw new Error('unknown Oompa run');
        if (grant.role !== 'builder' && run.owner.grant.workspaceId !== grant.workspaceId)
          throw new Error('Oompa run is outside this workspace');
        if (!ownerInput && grant.role !== 'builder' && run.owner.grant.buddyId !== grant.buddyId)
          throw new Error('Oompa run belongs to another Buddy');
        if (action.kind === 'amend' || action.kind === 'prerequisite') {
          if (registering.has(run.owner.id)) throw new Error('portfolio reconciliation is active');
          registering.add(run.owner.id);
          try {
            return await (action.kind === 'amend'
              ? amend(grant, run, action, key)
              : prerequisite(grant, run, action, key));
          } finally {
            registering.delete(run.owner.id);
          }
        }
        if (action.kind === 'requeue') return requeue(grant, run, action, key);
        if (action.kind === 'drain') {
          if (!ownerInput) delegated(grant, run);
          return requestDrain(run, key);
        }
        if (action.kind === 'continue') {
          if (!ownerInput) delegated(grant, run);
          return continueRun(run, action, key);
        }
        if (action.kind === 'stop') stop(run);
        return view(run);
      }
      if ((action.resumeRunId || action.portfolio) && (!ownerInput || action.priorRunId))
        throw new Error('new portfolio/window policy requires a new owner-authored launch');
      if (action.amendmentId && !action.priorRunId)
        throw new Error('amendment requires explicit prior host');
      const previous = action.priorRunId ? runs.get(action.priorRunId) : undefined;
      if (action.priorRunId && !previous) throw new Error('unknown prior Oompa run');
      if (!ownerInput && !previous) throw new Error('Oompa launch requires an owner-authored turn');
      if (previous && action.automationSeconds !== undefined)
        throw new Error('new automation policy requires a new owner launch');
      const authorization =
        previous && (ownerInput ? previous.owner.automation : delegated(grant, previous));
      if (previous && (!authorization || authorization.expiresAt <= now() || revoked(previous)))
        throw new Error('prior Oompa run has no active owner delegation');
      if (
        authorization &&
        (action.buddyId !== authorization.buddyId ||
          action.workspaceId !== authorization.workspaceId ||
          fs.realpathSync(action.workspacePath) !== authorization.workspacePath)
      )
        throw new Error('Oompa renewal is outside the owner delegation');
      if (grant.role !== 'builder' && grant.workspaceId !== action.workspaceId)
        throw new Error('Oompa launch is outside this workspace');
      const workspace = (await options.core.listWorkspaces()).find(
        (x) => x.id === action.workspaceId
      );
      if (!workspace) throw new Error('unknown Oompa workspace');
      const workspacePath = await registered(workspace.rootPath, action.workspacePath);
      const buddy = await options.core.getBuddy(action.buddyId);
      if (buddy.workspaceId !== workspace.id || buddy.status === 'archived')
        throw new Error('invalid Oompa Buddy');
      const configPath = fs.realpathSync(action.configPath);
      const raw = fs.readFileSync(configPath, 'utf8');
      const config = Config.parse(JSON.parse(raw));
      const revision =
        previous && action.amendmentId
          ? read<{
              configSha256: string;
              taskOwners: Record<string, string>;
              action: z.infer<typeof Amendment>;
            }>(
              path.join(
                previous.execution.dir,
                'config-revisions',
                action.amendmentId,
                'revision.json'
              )
            )
          : undefined;
      const expectedSha =
        revision?.configSha256 ?? previous?.owner.configSha256 ?? authorization?.configSha256;
      if (authorization && sha(raw) !== expectedSha)
        throw new Error('Oompa renewal configuration changed from owner-pinned scope');
      const backend = config.task_backend;
      if (backend.workspace_id !== workspace.id || backend.buddy_id !== buddy.id)
        throw new Error('Oompa config workspace/Buddy does not match launch');
      const taskIds = [...new Set(backend.task_ids)];
      const taskOwners: Record<string, string> = {};
      for (const id of taskIds) {
        const task = await options.core.getTask(id);
        if (task.workspaceId !== workspace.id)
          throw new Error('Oompa task is outside the launch workspace');
        if (task.ownerId !== (backend.owner_by_task?.[id] ?? backend.buddy_id))
          throw new Error('Oompa task owner does not match the explicit configuration');
        taskOwners[id] = task.ownerId!;
        if (revision && task.revision !== revision.action.taskRevisions[id])
          throw new Error('reviewed amended task revision changed before renewal');
        if (
          authorization &&
          (revision?.taskOwners ?? previous?.owner.taskOwners ?? authorization.taskOwners)[id] !==
            task.ownerId
        )
          throw new Error('Oompa task owner changed from owner delegation');
      }
      const launchHash = sha(JSON.stringify({ ...action, raw }));
      const prior = [...runs.values()].find(
        (run) => run.owner.key === key && run.owner.grant.workspaceId === workspace.id
      );
      if (prior) {
        if (prior.owner.launchHash !== launchHash)
          throw new Error('Oompa launch key was already used for different input');
        return view(prior);
      }
      let resumeSwarmId: string | undefined;
      let priorDeadline: number | undefined;
      if (action.resumeRunId) {
        const resumed = runs.get(action.resumeRunId);
        if (
          !resumed ||
          resumed.owner.workspacePath !== workspacePath ||
          resumed.owner.grant.buddyId !== buddy.id ||
          resumed.owner.grant.workspaceId !== workspace.id
        )
          throw new Error('foreign owner resume source');
        if (registering.has(resumed.owner.id))
          throw new Error('portfolio reconciliation is active');
        latestDrained(resumed);
        resumeSwarmId = resumeSwarm(resumed);
        priorDeadline = Math.min(
          ...workerStates(resumed).map(
            (state) => state.execution.deadline_ms ?? Number.POSITIVE_INFINITY
          )
        );
        if (!Number.isFinite(priorDeadline)) throw new Error('cannot prove prior task window');
      }
      if (action.portfolio) {
        if (
          !action.automationSeconds ||
          action.portfolio.reviewerIds.some((id) => !action.portfolio!.ownerIds.includes(id))
        )
          throw new Error('portfolio needs a fixed owner horizon and approved reviewer ownership');
        for (const taskId of action.portfolio.rootTaskIds) {
          const task = await options.core.getTask(taskId);
          if (task.workspaceId !== workspace.id) throw new Error('foreign portfolio root');
        }
        if (action.portfolio.reviewerIds.includes(buddy.id))
          throw new Error('portfolio reviewer must be independent of launch Buddy');
        for (const ownerId of [...action.portfolio.ownerIds, ...action.portfolio.reviewerIds]) {
          const owner = await options.core.getBuddy(ownerId);
          if (owner.workspaceId !== workspace.id || owner.status === 'archived')
            throw new Error('foreign portfolio owner');
        }
        for (const taskId of taskIds)
          await portfolioTask(options.core, action.portfolio, workspace.id, taskId);
      }
      if (previous) {
        if (revoked(previous) || authorization!.expiresAt <= now())
          throw new Error('owner automation delegation expired or was revoked');
        refresh(previous);
        if (
          previous.execution.phase.t !== 'ended' ||
          registering.has(previous.owner.id) ||
          childActive(previous.execution.dir) ||
          activeChild(previous)
        )
          throw new Error('prior Oompa execution has not drained');
        if ([...runs.values()].some((run) => run.owner.priorRunId === previous.owner.id))
          throw new Error('prior Oompa run already renewed; reference its successor');
        if (
          [...runs.values()].some(
            (run) =>
              run.owner.automation?.rootRunId === authorization!.rootRunId &&
              (run.execution.phase.t === 'running' || run.execution.phase.t === 'stopping')
          )
        )
          throw new Error('an Oompa execution under this delegation is active');
        if (now() + action.maxSeconds * 1000 > authorization!.expiresAt)
          throw new Error('Oompa renewal exceeds owner automation horizon');
        const audit = graphAudit(previous);
        if (
          !revision &&
          !ownerInput &&
          audit &&
          audit.workers.every((item) => item && !['ready', 'running'].includes(item.state))
        ) {
          const items = audit.workers.flatMap(
            (item) =>
              (item as unknown as { items?: { task_id: string; revision: number }[] }).items ?? []
          );
          if (
            items.length &&
            (
              await Promise.all(
                items.map(
                  async (item) =>
                    (await options.core.getTask(item.task_id)).revision === item.revision
                )
              )
            ).every(Boolean)
          )
            throw new Error(
              'unchanged queue fingerprint requires reconciliation, not another scheduled launch'
            );
        }
        resumeSwarmId = resumeSwarm(previous);
      }
      const id = `oompa-${randomUUID()}`;
      const startedAt = now();
      const automation =
        authorization ??
        (action.automationSeconds
          ? {
              rootRunId: id,
              buddyId: buddy.id,
              workspaceId: workspace.id,
              workspacePath,
              configSha256: sha(raw),
              portfolio: action.portfolio,
              taskOwners,
              expiresAt: startedAt + action.automationSeconds * 1000,
            }
          : undefined);
      const expiresAt = automation?.expiresAt ?? startedAt + action.maxSeconds * 1000;
      const issued = options.grants.issueOompa({
        executionId: id,
        buddyId: buddy.id,
        workspaceId: workspace.id,
        taskIds,
        principal: previous?.owner.grant.principal ?? grant.principal,
        expiresAt,
      });
      const { observe: _, ...record } = issued;
      const owner: OompaOwner = {
        version: 1,
        kind: 'oompa',
        id,
        key,
        launchHash,
        workspacePath,
        configPath,
        originalExpiresAt: startedAt + action.maxSeconds * 1000,
        priorRunId: previous?.owner.id,
        resumeRunId: action.resumeRunId,
        configSha256: sha(raw),
        taskOwners,
        automation,
        grant: record,
        validators: config.task_execution?.validators ?? {},
      };
      const execution = journals.forOompa(owner);
      const run = { owner, execution };
      runs.set(id, run);
      try {
        // Pin configuration at owner launch; later model edits cannot change the oracle or scope.
        const pinnedConfig = path.join(execution.dir, 'config.json');
        // Resume the existing Oompa execution state, including attempts/session/task deadlines.
        // A plain run here silently reset those budgets. Guard: overnight delegation renewal.
        if (action.resumeRunId) {
          if (!config.task_execution)
            throw new Error('owner resumed window requires selected task execution');
          config.task_execution.owner_window = {
            authorization_id: id,
            expires_at_ms: expiresAt,
            prior_deadline_ms: priorDeadline,
          };
        }
        const pinnedRaw = resumeSwarmId
          ? JSON.stringify({ ...config, resume_swarm_id: resumeSwarmId })
          : raw;
        fs.writeFileSync(pinnedConfig, pinnedRaw, { mode: 0o600 });
        atomic(path.join(execution.dir, 'continuation-control.json'), { version: 1 });
        spawnOwned(
          execution.dir,
          record.expiresAt,
          [executable, 'run', '--config', pinnedConfig],
          workspacePath,
          {
            ...cleanEnv(),
            ...(action.resumeRunId
              ? {
                  OOMPA_OWNER_WINDOW_AUTHORIZATION_ID: id,
                  OOMPA_OWNER_WINDOW_EXPIRES_AT_MS: String(expiresAt),
                }
              : {}),
            OOMPA_CONTINUATION_CONTROL_DIR: execution.dir,
            OOMPA_BUDDY_MCP_URL: options.url(),
            OOMPA_BUDDY_MCP_TOKEN: record.token,
            AGENT_CLI_MCP_UNLEASHD_BUDDY__AUTHORIZATION: `Bearer ${record.token}`,
          }
        );
        console.log(
          `[oompa] launched ${id}, ${taskIds.length} tasks, deadline ${new Date(record.expiresAt).toISOString()}`
        );
        return view(run);
      } catch (error) {
        stop(run);
        throw error;
      }
    },

    async accept(grant: BuddyGrant, request: Accept) {
      const lockKey = `${grant.oompa?.executionId}:${sha(JSON.stringify(request))}`;
      const previous = accepts.get(lockKey);
      if (previous) return previous;
      const run = forGrant(grant);
      if (
        registering.has(run.owner.id) ||
        continuations(run).some(
          ({ dir, record }) =>
            (record.phase !== 'failed' || executionProcess(dir).t !== 'unstarted') &&
            childActive(dir)
        )
      )
        throw new Error('Oompa continuation is active');
      const perform = async () => {
        registering.add(run.owner.id);
        if (!grant.oompa!.taskIds.includes(request.taskId))
          throw new Error('task is outside this Oompa execution');
        const validator = run.owner.validators[request.taskId];
        if (!validator) throw new Error('no owner-pinned validator for this task');
        const task = await options.core.getTask(request.taskId);
        if (task.workspaceId !== grant.workspaceId)
          throw new Error('task moved outside this execution');
        const name = sha(JSON.stringify(request));
        const dir = path.join(run.execution.dir, 'validations', name);
        const recordPath = path.join(dir, 'validation.json');
        const resultPath = path.join(dir, 'accepted.json');
        const result = (kind: 'rejected' | 'blocked', reason: string) => ({
          kind,
          task,
          validation: { status: kind, reason, logDirectory: dir },
        });
        let record: Validation;
        if (!fs.existsSync(recordPath)) {
          if (
            task.revision !== request.baseRevision ||
            task.paused ||
            !['in_progress', 'review'].includes(task.status)
          )
            return result('blocked', 'task revision or status changed before validation');
          try {
            await registered(run.owner.workspacePath, request.workspacePath);
            if ((await cleanCommit(request.workspacePath)) !== request.sourceCommit)
              throw new Error('candidate commit does not match request');
            await cleanCommit(run.owner.workspacePath);
            await git(
              run.owner.workspacePath,
              'merge-base',
              '--is-ancestor',
              await git(run.owner.workspacePath, 'rev-parse', 'HEAD'),
              request.sourceCommit
            );
            await pins(request.workspacePath, validator);
          } catch (error) {
            return result('blocked', String(error));
          }
          const validationJournals = createExecutionJournals(path.dirname(dir));
          // This child has no Buddy bearer. Its ordinary ephemeral journal owns only the oracle.
          const createdDir = validationJournals.ephemeral(`Oompa oracle ${request.taskId}`);
          fs.renameSync(createdDir, dir);
          forGrant(grant);
          record = { request, evidence: task.evidence, phase: 'started' };
          atomic(recordPath, record);
          spawnOwned(
            dir,
            Math.min(grant.expiresAt, now() + validator.timeout_seconds * 1000),
            validator.command,
            request.workspacePath,
            {
              ...cleanEnv(),
              OOMPA_TASK_ID: request.taskId,
              OOMPA_SOURCE_COMMIT: request.sourceCommit,
            }
          );
        } else record = read<Validation>(recordPath);
        if (record.phase === 'rejected') return result('rejected', record.reason ?? record.phase);
        if (record.phase === 'accepted' && fs.existsSync(resultPath))
          return read<unknown>(resultPath);
        if (executionProcess(dir).t === 'live')
          return {
            kind: 'validating',
            taskId: request.taskId,
            validation: { status: 'running', logDirectory: dir },
          };
        let stdout: string;
        try {
          const exit = read<{ status: number }>(path.join(dir, 'exit.json'));
          if (exit.status !== 0) throw new Error(`validator exited ${exit.status}`);
          if (fs.statSync(path.join(dir, 'stdout')).size > 1_000_000)
            throw new Error('validator output exceeds 1 MB');
          stdout = fs.readFileSync(path.join(dir, 'stdout'), 'utf8');
          z.object({
            schema: z.literal('oompa.task-validation/v1'),
            task_id: z.literal(request.taskId),
            source_commit: z.literal(request.sourceCommit),
            accepted: z.literal(true),
          })
            .passthrough()
            .parse(JSON.parse(stdout));
          await pins(request.workspacePath, validator);
          if ((await cleanCommit(request.workspacePath)) !== request.sourceCommit)
            throw new Error('candidate changed during validation');
        } catch (error) {
          const reason = String(error);
          atomic(recordPath, { ...record, phase: 'rejected', reason });
          return result('rejected', reason);
        }
        try {
          forGrant(grant);
          const currentTask = await options.core.getTask(request.taskId);
          const receipt = `Host independent validator accepted ${request.sourceCommit}; receipt ${dir}`;
          const landed = currentTask.status === 'done' && currentTask.evidence.includes(receipt);
          if (
            !landed &&
            (currentTask.revision !== request.baseRevision ||
              currentTask.paused ||
              !['in_progress', 'review'].includes(currentTask.status))
          )
            throw new Error('task changed during independent validation');
          const launchHead = await cleanCommit(run.owner.workspacePath);
          // A host restart after merge, before CAS, resumes from the identical accepted commit.
          if (launchHead !== request.sourceCommit)
            await git(run.owner.workspacePath, 'merge', '--ff-only', request.sourceCommit);
          if ((await cleanCommit(run.owner.workspacePath)) !== request.sourceCommit)
            throw new Error('integration does not match validated commit');
          forGrant(grant);
          const validation = {
            status: 'accepted' as const,
            sourceCommit: request.sourceCommit,
            command: validator.command,
            sourceFiles: validator.source_files,
            stdoutSha256: sha(stdout),
            logDirectory: dir,
          };
          const accepted = await options.core.upsertTask(grant.principal, {
            kind: 'update',
            taskId: request.taskId,
            baseRevision: request.baseRevision,
            changes: {
              status: 'done',
              evidence: [...record.evidence, receipt],
            },
            key: `oompa-accept-${run.owner.id}-${name}`,
          });
          const acceptedResult = { kind: 'accepted', task: accepted, validation };
          atomic(resultPath, acceptedResult);
          atomic(recordPath, { ...record, phase: 'accepted' });
          return acceptedResult;
        } catch (error) {
          return result('blocked', String(error));
        }
      };
      const pending = perform();
      accepts.set(lockKey, pending);
      try {
        return await pending;
      } finally {
        accepts.delete(lockKey);
        registering.delete(run.owner.id);
      }
    },
  };
}
export type OompaHost = ReturnType<typeof createOompaHost>;
