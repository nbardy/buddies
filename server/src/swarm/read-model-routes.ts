import fs from 'node:fs';
import path from 'node:path';
import type { OompaCycle, OompaReviewLog, OompaStarted } from '@unleashd/shared';
import type { Application, Request, Response } from 'express';
import type { OompaContextCommand } from './commands';
import { buildSwarmContext } from './context';

export interface SwarmReadModelPorts {
  isUnderKnownProject(resolvedPath: string): boolean;
  resolveWorkingDirectory(input: string): string;
  captureOompaCommand(command: OompaContextCommand, cwd: string): Promise<string>;
  executeGit(args: string[], cwd: string, timeoutMs: number): Promise<string>;
  isProcessAlive(pid: number): boolean;
  now(): number;
}

export function registerSwarmReadModelRoutes(app: Application, ports: SwarmReadModelPorts): void {
  app.get('/api/oompa-swarm-context', async (request, response) => {
    const input = queryString(request.query.dir);
    if (!input?.trim()) {
      response.status(400).json({ error: 'Directory path required' });
      return;
    }
    const projectRoot = ports.resolveWorkingDirectory(input);
    if (!ports.isUnderKnownProject(projectRoot)) {
      response.status(403).json({ error: 'Directory not associated with any conversation' });
      return;
    }
    try {
      if (!(await fs.promises.stat(projectRoot)).isDirectory()) {
        response.status(400).json({ error: 'Path must be a directory' });
        return;
      }
    } catch {
      response.status(404).json({ error: 'Directory does not exist' });
      return;
    }
    try {
      response.json({
        prefix: await buildSwarmContext(projectRoot, {
          captureCommand: ports.captureOompaCommand,
          now: () => new Date(ports.now()),
        }),
      });
    } catch (error) {
      console.error('[swarm-read-model] Failed to build swarm context:', error);
      response.status(500).json({ error: errorMessage(error) });
    }
  });

  app.get('/api/git-log', async (request, response) => {
    const projectRoot = authorizeDirectory(request, response, ports);
    if (!projectRoot) return;
    try {
      const raw = (
        await ports.executeGit(['log', '-20', '--format=%H\t%s\t%aI\t%an'], projectRoot, 5_000)
      ).trim();
      const entries = raw
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const parts = line.split('\t');
          if (parts.length < 4) {
            return { hash: parts[0] ?? '', message: line, date: '', author: '' };
          }
          return { hash: parts[0], message: parts[1], date: parts[2], author: parts[3] };
        });
      response.json(entries);
    } catch (error) {
      console.warn('[swarm-read-model] Failed to read git log:', error);
      response.json([]);
    }
  });

  app.get('/api/swarm-runs', async (request, response) => {
    const projectRoot = authorizeDirectory(request, response, ports);
    if (!projectRoot) return;
    const runsDirectory = path.join(projectRoot, 'runs');
    try {
      await fs.promises.access(runsDirectory);
    } catch {
      response.json({ runs: [] });
      return;
    }

    try {
      const entries = await fs.promises.readdir(runsDirectory, { withFileTypes: true });
      const runs = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map(async (entry) => {
            const runDirectory = path.join(runsDirectory, entry.name);
            const run =
              (await readJson<OompaStarted>(path.join(runDirectory, 'started.json'))) ??
              (await readJson<OompaStarted>(path.join(runDirectory, 'run.json')));
            const storedSummary = await readJson<Record<string, unknown>>(
              path.join(runDirectory, 'summary.json')
            );
            const summary =
              storedSummary ??
              (run ? await synthesizeSwarmRunSummary(runDirectory, entry.name, run, ports) : null);
            return { swarmId: entry.name, run, summary };
          })
      );
      runs.sort((left, right) => {
        const leftTime = left.run?.['started-at'] ?? '';
        const rightTime = right.run?.['started-at'] ?? '';
        return rightTime.localeCompare(leftTime);
      });
      response.json({ runs });
    } catch (error) {
      console.error('[swarm-read-model] Failed to read swarm runs:', error);
      response.status(500).json({ error: errorMessage(error) });
    }
  });

  app.get('/api/swarm-new-files', async (request, response) => {
    const projectRoot = authorizeDirectory(request, response, ports);
    if (!projectRoot) return;
    const swarmId = queryString(request.query.swarmId);
    if (!swarmId) {
      response.status(400).json({ error: 'Absolute directory path and swarmId required' });
      return;
    }
    const runDirectory = resolveRunDirectory(projectRoot, swarmId);
    if (!runDirectory) {
      response.status(400).json({ error: 'Invalid swarmId' });
      return;
    }

    const startedAt = await firstTimestamp(runDirectory, [
      ['started.json', 'started-at'],
      ['run.json', 'started-at'],
    ]);
    if (!startedAt) {
      response.json({ count: 0, files: [] });
      return;
    }
    const finishedAt = await firstTimestamp(runDirectory, [
      ['summary.json', 'finished-at'],
      ['stopped.json', 'stopped-at'],
    ]);
    try {
      const args = ['log', '--merges', `--after=${sanitizeTimestamp(startedAt)}`];
      if (finishedAt) args.push(`--before=${sanitizeTimestamp(finishedAt)}`);
      args.push('--diff-filter=A', '--name-only', '--pretty=format:', '--', '*.json');
      const raw = (await ports.executeGit(args, projectRoot, 10_000)).trim();
      const files = raw.split('\n').filter((line) => line.trim().length > 0);
      response.json({ count: files.length, files });
    } catch (error) {
      console.warn('[swarm-read-model] Failed to list newly added swarm files:', error);
      response.json({ count: 0, files: [] });
    }
  });

  app.get('/api/read-file', async (request, response) => {
    const filePath = queryString(request.query.path);
    if (!filePath || !path.isAbsolute(filePath)) {
      response.status(400).json({ error: 'Absolute path required' });
      return;
    }
    const resolved = path.resolve(filePath);
    if (!ports.isUnderKnownProject(resolved)) {
      response.status(403).json({ error: 'Path not under any known project directory' });
      return;
    }
    try {
      if (!(await fs.promises.stat(resolved)).isFile()) {
        response.status(400).json({ error: 'Path must be a file' });
        return;
      }
      response.json({ content: await fs.promises.readFile(resolved, 'utf8') });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        response.status(404).json({ error: 'File not found' });
        return;
      }
      console.error('[swarm-read-model] Failed to read file:', error);
      response.status(500).json({ error: errorMessage(error) });
    }
  });
}

export async function synthesizeSwarmRunSummary(
  runDirectory: string,
  swarmId: string,
  run: OompaStarted,
  ports: Pick<SwarmReadModelPorts, 'isProcessAlive' | 'now'>
): Promise<Record<string, unknown>> {
  const cycleDirectory = await firstExistingDirectory([
    path.join(runDirectory, 'cycles'),
    path.join(runDirectory, 'iterations'),
  ]);
  const cyclesByWorker = new Map<string, OompaCycle[]>();
  if (cycleDirectory) {
    await readGroupedJsonFiles<OompaCycle>(
      cycleDirectory,
      (cycle) => cycle['worker-id'],
      cyclesByWorker
    );
  }

  const reviewsByWorker = new Map<string, OompaReviewLog[]>();
  await readGroupedJsonFiles<OompaReviewLog>(
    path.join(runDirectory, 'reviews'),
    (review) => review['worker-id'],
    reviewsByWorker
  );

  const isStopped = await exists(path.join(runDirectory, 'stopped.json'));
  const isLive = !isStopped && typeof run.pid === 'number' ? ports.isProcessAlive(run.pid) : false;
  const startedAt = Date.parse(String(run['started-at'] ?? ''));
  const workers = (run.workers ?? []).map((worker) => {
    const cycles = cyclesByWorker.get(worker.id) ?? [];
    const reviews = reviewsByWorker.get(worker.id) ?? [];
    let merges = 0;
    let rejections = 0;
    let errors = 0;
    let latestOutcome: OompaCycle['outcome'] | null = null;
    let latestCycle = 0;
    for (const cycle of cycles) {
      const cycleNumber = cycle.cycle ?? 0;
      if (cycleNumber > latestCycle) {
        latestCycle = cycleNumber;
        latestOutcome = cycle.outcome;
      }
      if (cycle.outcome === 'merged') merges += 1;
      else if (cycle.outcome === 'rejected') rejections += 1;
      else if (['error', 'sync-failed', 'merge-failed'].includes(cycle.outcome ?? '')) errors += 1;
    }

    let status: string;
    if (cycles.length === 0 && !isLive) status = 'unknown';
    else if (cycles.length === 0) {
      status =
        !Number.isFinite(startedAt) || ports.now() - startedAt > 60_000 ? 'running' : 'starting';
    } else if (latestOutcome === 'done' || latestOutcome === 'executor-done') status = 'completed';
    else if (latestOutcome === 'error') status = 'error';
    else if (isLive) status = 'running';
    else if (isStopped) status = 'completed';
    else status = 'unknown';

    const verdicts = new Map<number, OompaReviewLog['verdict']>();
    for (const review of reviews) verdicts.set(review.cycle, review.verdict);
    const needsChanges = Array.from(verdicts.values()).filter(
      (verdict) => verdict === 'needs-changes'
    ).length;
    return {
      id: worker.id,
      harness: worker.harness ?? 'default',
      model: worker.model ?? 'unknown',
      status,
      completed: merges + rejections,
      iterations: worker.iterations ?? 0,
      merges,
      rejections,
      'needs-changes': needsChanges,
      errors,
      'review-rounds-total': reviews.length,
    };
  });

  const latestTimestamp = [...cyclesByWorker.values(), ...reviewsByWorker.values()]
    .flat()
    .reduce(
      (latest, event) => (event.timestamp && event.timestamp > latest ? event.timestamp : latest),
      ''
    );
  return {
    'swarm-id': swarmId,
    'finished-at': isStopped ? latestTimestamp || null : isLive ? null : latestTimestamp || null,
    'total-workers': workers.length,
    'total-completed': workers.reduce((sum, worker) => sum + worker.completed, 0),
    'total-iterations': workers.reduce((sum, worker) => sum + worker.iterations, 0),
    'status-counts': {},
    workers,
  };
}

function authorizeDirectory(
  request: Request,
  response: Response,
  ports: SwarmReadModelPorts
): string | undefined {
  const directory = queryString(request.query.dir);
  if (!directory || !path.isAbsolute(directory)) {
    response.status(400).json({ error: 'Absolute directory path required' });
    return undefined;
  }
  const resolved = path.resolve(directory);
  if (!ports.isUnderKnownProject(resolved)) {
    response.status(403).json({ error: 'Directory not associated with any conversation' });
    return undefined;
  }
  return resolved;
}

function resolveRunDirectory(projectRoot: string, swarmId: string): string | undefined {
  const runsDirectory = path.resolve(projectRoot, 'runs');
  const candidate = path.resolve(runsDirectory, swarmId);
  const relative = path.relative(runsDirectory, candidate);
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return undefined;
  }
  return candidate;
}

async function firstTimestamp(
  directory: string,
  candidates: Array<[fileName: string, key: string]>
): Promise<string | null> {
  for (const [fileName, key] of candidates) {
    const value = await readJson<Record<string, unknown>>(path.join(directory, fileName));
    if (typeof value?.[key] === 'string') return value[key] as string;
  }
  return null;
}

async function readGroupedJsonFiles<T>(
  directory: string,
  groupKey: (value: T) => string | undefined,
  groups: Map<string, T[]>
): Promise<void> {
  let files: string[];
  try {
    files = (await fs.promises.readdir(directory)).filter((file) => file.endsWith('.json'));
  } catch {
    return;
  }
  await Promise.all(
    files.map(async (file) => {
      const value = await readJson<T>(path.join(directory, file));
      if (!value) return;
      const key = groupKey(value);
      if (!key) return;
      const values = groups.get(key) ?? [];
      values.push(value);
      groups.set(key, values);
    })
  );
}

async function firstExistingDirectory(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      if ((await fs.promises.stat(candidate)).isDirectory()) return candidate;
    } catch {
      // Try the next compatible event directory.
    }
  }
  return null;
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.promises.readFile(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sanitizeTimestamp(value: string): string {
  return value.replace(/[^0-9T:Z.+-]/g, '');
}

function queryString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
