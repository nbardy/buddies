import { execFile, spawn } from 'node:child_process';
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
  z
    .object({
      kind: z.literal('launch'),
      workspaceId: z.string().min(1),
      buddyId: z.string().min(1),
      workspacePath: z.string().min(1),
      configPath: z.string().min(1),
      maxSeconds: z.number().int().positive().max(43_200),
    })
    .strict(),
  z.object({ kind: z.literal('status'), runId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('stop'), runId: z.string().min(1) }).strict(),
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
type Run = { owner: OompaOwner; execution: Execution };
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
      ([name]) => !/^(UNLEASHD_AUTH_|OOMPA_BUDDY_MCP_|AGENT_CLI_MCP_|BUDDIES_.*TOKEN)/.test(name)
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
  if (await git(cwd, 'status', '--porcelain'))
    throw new Error('workspace must be clean for acceptance');
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
  function stop(run: Run, timeout = false) {
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
    const validationRoot = path.join(run.execution.dir, 'validations');
    if (fs.existsSync(validationRoot))
      for (const name of fs.readdirSync(validationRoot)) signal(path.join(validationRoot, name));
  }
  function refresh(run: Run) {
    if (run.execution.phase.t === 'stopping' && executionProcess(run.execution.dir).t !== 'live') {
      journals.step(run.execution, {
        t: 'drained',
        observed: { t: 'complete', text: 'Oompa process drained' },
      });
      return;
    }
    if (run.execution.phase.t !== 'running') return;
    if (run.owner.grant.expiresAt <= now()) return stop(run, true);
    if (executionProcess(run.execution.dir).t !== 'live') {
      journals.step(run.execution, {
        t: 'drained',
        observed: { t: 'complete', text: 'Oompa process exited' },
      });
      options.grants.revokeRun(run.owner.id);
    }
  }
  function view(run: Run) {
    refresh(run);
    return {
      runId: run.owner.id,
      status: run.execution.phase.t,
      expiresAt: run.owner.grant.expiresAt,
      workspacePath: run.owner.workspacePath,
      taskIds: run.owner.grant.oompa!.taskIds,
      logDirectory: run.execution.dir,
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
        found.owner.grant.expiresAt > now()
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
        if (action.kind === 'stop') stop(run);
        return view(run);
      }
      if (!ownerInput) throw new Error('Oompa launch requires an owner-authored turn');
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
      const backend = config.task_backend;
      if (backend.workspace_id !== workspace.id || backend.buddy_id !== buddy.id)
        throw new Error('Oompa config workspace/Buddy does not match launch');
      const taskIds = [...new Set(backend.task_ids)];
      for (const id of taskIds) {
        const task = await options.core.getTask(id);
        if (task.workspaceId !== workspace.id)
          throw new Error('Oompa task is outside the launch workspace');
        if (task.ownerId !== (backend.owner_by_task?.[id] ?? backend.buddy_id))
          throw new Error('Oompa task owner does not match the explicit configuration');
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
      const id = `oompa-${randomUUID()}`;
      const issued = options.grants.issueOompa({
        executionId: id,
        buddyId: buddy.id,
        workspaceId: workspace.id,
        taskIds,
        principal: grant.principal,
        ttlMs: action.maxSeconds * 1000,
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
        grant: record,
        validators: config.task_execution?.validators ?? {},
      };
      const execution = journals.forOompa(owner);
      const run = { owner, execution };
      runs.set(id, run);
      try {
        // Pin configuration at owner launch; later model edits cannot change the oracle or scope.
        const pinnedConfig = path.join(execution.dir, 'config.json');
        fs.writeFileSync(pinnedConfig, raw, { mode: 0o600 });
        spawnOwned(
          execution.dir,
          record.expiresAt,
          [executable, 'run', '--config', pinnedConfig],
          workspacePath,
          {
            ...cleanEnv(),
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
      const perform = async () => {
        const run = forGrant(grant);
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
      }
    },
  };
}
export type OompaHost = ReturnType<typeof createOompaHost>;
