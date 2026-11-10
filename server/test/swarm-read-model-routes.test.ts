import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import express from 'express';
import { captureOompaCommand, executeGit } from '../src/swarm/commands';
import {
  type SwarmReadModelPorts,
  registerSwarmReadModelRoutes,
  synthesizeSwarmRunSummary,
} from '../src/swarm/read-model-routes';

const execFileAsync = promisify(execFile);

test('summary synthesis derives worker outcomes from cycles and reviews', async (context) => {
  const runDirectory = await mkdtemp(path.join(os.tmpdir(), 'swarm-read-model-'));
  context.after(() => rm(runDirectory, { recursive: true, force: true }));
  await mkdir(path.join(runDirectory, 'cycles'));
  await mkdir(path.join(runDirectory, 'reviews'));
  await writeFile(
    path.join(runDirectory, 'cycles', 'worker-1.json'),
    JSON.stringify({
      'worker-id': 'worker-1',
      cycle: 1,
      outcome: 'merged',
      timestamp: '2026-01-01T00:01:00.000Z',
    })
  );
  await writeFile(
    path.join(runDirectory, 'reviews', 'worker-1.json'),
    JSON.stringify({
      'worker-id': 'worker-1',
      cycle: 1,
      verdict: 'approved',
      timestamp: '2026-01-01T00:02:00.000Z',
    })
  );

  const summary = await synthesizeSwarmRunSummary(
    runDirectory,
    'swarm-1',
    {
      'swarm-id': 'swarm-1',
      'started-at': '2026-01-01T00:00:00.000Z',
      'config-file': '/tmp/oompa.json',
      pid: 123,
      workers: [
        {
          id: 'worker-1',
          harness: 'codex',
          model: 'gpt-5.6-sol',
          iterations: 2,
          'can-plan': false,
          prompts: [],
        },
      ],
    },
    { isProcessAlive: () => true, now: () => Date.parse('2026-01-01T00:03:00.000Z') }
  );

  assert.equal(summary['finished-at'], null);
  assert.equal(summary['total-completed'], 1);
  assert.deepEqual(summary.workers, [
    {
      id: 'worker-1',
      harness: 'codex',
      model: 'gpt-5.6-sol',
      status: 'running',
      completed: 1,
      iterations: 2,
      merges: 1,
      rejections: 0,
      'needs-changes': 0,
      errors: 0,
      'review-rounds-total': 1,
    },
  ]);
});

test('read-model routes reject unknown projects before commands or file reads', async (context) => {
  let commandCalls = 0;
  const ports: SwarmReadModelPorts = {
    isUnderKnownProject: () => false,
    resolveWorkingDirectory: (input) => path.resolve(input),
    captureOompaCommand: async () => {
      commandCalls += 1;
      return 'should not execute';
    },
    executeGit: async () => {
      commandCalls += 1;
      return 'should not execute';
    },
    isProcessAlive: () => false,
    now: Date.now,
  };
  const app = express();
  registerSwarmReadModelRoutes(app, ports);
  const server = await listen(app);
  context.after(() => close(server));
  const address = server.address();
  assert(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  const contextResponse = await fetch(
    `${base}/api/oompa-swarm-context?dir=${encodeURIComponent('/tmp/unknown')}`
  );
  const fileResponse = await fetch(
    `${base}/api/read-file?path=${encodeURIComponent('/tmp/unknown/secret')}`
  );

  assert.equal(contextResponse.status, 403);
  assert.equal(fileResponse.status, 403);
  assert.equal(commandCalls, 0);
});

test('swarm-new-files rejects run-directory traversal before invoking git', async (context) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'swarm-project-'));
  context.after(() => rm(projectRoot, { recursive: true, force: true }));
  let gitCalls = 0;
  const app = express();
  registerSwarmReadModelRoutes(app, {
    isUnderKnownProject: (candidate) => candidate.startsWith(projectRoot),
    resolveWorkingDirectory: path.resolve,
    captureOompaCommand: async () => '',
    executeGit: async () => {
      gitCalls += 1;
      return '';
    },
    isProcessAlive: () => false,
    now: Date.now,
  });
  const server = await listen(app);
  context.after(() => close(server));
  const address = server.address();
  assert(address && typeof address === 'object');
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/swarm-new-files?dir=${encodeURIComponent(projectRoot)}&swarmId=${encodeURIComponent('../outside')}`
  );

  assert.equal(response.status, 400);
  assert.equal(gitCalls, 0);
});

// Regression guard (2026-09-25): the swarm-context route ran `oompa status` and
// `oompa info` through execSync, back to back, freezing the whole backend for up
// to 16s. A real `oompa` executable that sleeps proves both that the event loop
// keeps serving other requests meanwhile and that the two commands overlap.
test('swarm context runs oompa without blocking the server and runs both commands at once', async (context) => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'swarm-context-'));
  context.after(() => rm(sandbox, { recursive: true, force: true }));
  const binDirectory = path.join(sandbox, 'bin');
  const projectRoot = path.join(sandbox, 'project');
  await mkdir(binDirectory);
  await mkdir(projectRoot);
  const oompaSleepSeconds = 1;
  await writeFile(
    path.join(binDirectory, 'oompa'),
    `#!/bin/sh\n[ "$1" = warm ] && exit 0\nsleep ${oompaSleepSeconds}\necho "fake oompa $1 output"\n`,
    { mode: 0o755 }
  );
  // macOS scans a freshly written executable on its first exec; measured 2026-11-10 at ~5 s
  // for this script, which made the two overlapping 1 s runs read as sequential (2.0 s). One
  // untimed run first keeps the timing about overlap, not about the scan.
  await execFileAsync(path.join(binDirectory, 'oompa'), ['warm']);
  const originalPath = process.env.PATH;
  process.env.PATH = `${binDirectory}${path.delimiter}${originalPath}`;
  context.after(() => {
    process.env.PATH = originalPath;
  });

  const app = express();
  app.get('/ping', (_request, response) => {
    response.send('pong');
  });
  registerSwarmReadModelRoutes(app, {
    isUnderKnownProject: (candidate) => candidate.startsWith(projectRoot),
    resolveWorkingDirectory: path.resolve,
    captureOompaCommand: (command, cwd) => captureOompaCommand(command, cwd, 5_000),
    executeGit,
    isProcessAlive: () => false,
    now: Date.now,
  });
  const server = await listen(app);
  context.after(() => close(server));
  const address = server.address();
  assert(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;

  const startedAt = Date.now();
  const contextRequest = fetch(
    `${base}/api/oompa-swarm-context?dir=${encodeURIComponent(projectRoot)}`
  ).then(async (response) => ({
    status: response.status,
    body: (await response.json()) as { prefix: string },
    elapsedMs: Date.now() - startedAt,
  }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  const ping = await fetch(`${base}/ping`);
  const pingElapsedMs = Date.now() - startedAt;
  const contextResult = await contextRequest;

  assert.equal(await ping.text(), 'pong');
  assert.equal(contextResult.status, 200);
  assert.ok(
    pingElapsedMs < oompaSleepSeconds * 1_000,
    `ping sent at 200ms was answered at ${pingElapsedMs}ms: oompa blocked the event loop`
  );
  assert.ok(
    contextResult.elapsedMs < oompaSleepSeconds * 2_000 - 50,
    `context took ${contextResult.elapsedMs}ms; oompa status and info ran sequentially`
  );
  assert.match(contextResult.body.prefix, /fake oompa status output/);
  assert.match(contextResult.body.prefix, /fake oompa info output/);
});

function listen(app: express.Application): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
