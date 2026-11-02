#!/usr/bin/env node
// The fake Oompa executable for server/test/oompa-mcp.test.ts. A checked-in file on purpose:
// macOS assesses (syspolicyd) every newly written executable on its first exec, one at a time
// machine-wide. The stub used to be written fresh into every fixture, so nine concurrent shards
// queued their first launch behind each other for 10 s and more (2026-11-02, every shard of a
// parallel run timed out waiting for the stub's first worker state).
const fs = require('node:fs'),
  path = require('node:path'),
  { spawn } = require('node:child_process');
const sleeper = spawn('sleep', ['90']);
console.log(process.pid);
console.log(sleeper.pid);
// The test's mode file sits beside the workspace (cwd) it launched in: <scratch>/stub-mode.
const stubMode = path.join(process.cwd(), '..', 'stub-mode');
const config = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
const swarmId = config.resume_swarm_id ? 'renewed-swarm' : 'test-swarm';
const root = path.join(process.cwd(), 'runs', swarmId);
fs.mkdirSync(path.join(root, 'workers'), { recursive: true });
let initialMode = '';
try {
  initialMode = fs.readFileSync(stubMode, 'utf8');
} catch {}
fs.writeFileSync(
  path.join(root, 'started.json'),
  JSON.stringify({
    'swarm-id': swarmId,
    'config-file': process.argv[4],
    pid: process.pid,
    workers: initialMode.startsWith('terminal') ? [{ id: 'w0' }, { id: 'w1' }] : [{ id: 'w0' }],
    'continuation-control-dir': process.env.OOMPA_CONTINUATION_CONTROL_DIR,
  })
);
console.log('Started event written to runs/' + swarmId + '/started.json');
fs.writeFileSync(
  path.join(root, 'owner-window.json'),
  JSON.stringify({
    window: config.task_execution?.owner_window,
    id: process.env.OOMPA_OWNER_WINDOW_AUTHORIZATION_ID,
    expires: process.env.OOMPA_OWNER_WINDOW_EXPIRES_AT_MS,
  })
);
const update = () => {
  let request;
  try {
    request = JSON.parse(
      fs.readFileSync(
        path.join(process.env.OOMPA_CONTINUATION_CONTROL_DIR, 'continuation-request.json'),
        'utf8'
      )
    );
  } catch {}
  let mode = '';
  try {
    mode = fs.readFileSync(stubMode, 'utf8');
  } catch {}
  if (mode === 'exit') process.exit(0);
  const state = {
    'worker-id': 'w0',
    status: mode === 'active' ? 'running' : 'waiting',
    reason: request && mode !== 'noack' ? 'host-continuation' : 'awaiting-buddy-acceptance',
    'updated-at': new Date().toISOString(),
    execution:
      mode === 'active'
        ? { task_id: 'active' }
        : request && mode !== 'noack'
          ? { host_continuation_id: request.id }
          : {},
  };
  if (mode.startsWith('terminal')) {
    state.status = mode === 'terminal-waiting-stale' ? 'waiting' : 'stopped';
    state.reason = 'needs-reconciliation';
    state['updated-at'] = mode === 'terminal-bad-date' ? 'invalid' : '2020-01-01T00:00:00Z';
    state.execution = {
      queue_audit: { state: mode === 'terminal-bad-audit' ? 'accepted' : 'needs-reconciliation' },
    };
    if (mode === 'terminal-active') state.execution.task_id = 'active';
    const peer = {
      'worker-id': 'w1',
      status: 'waiting',
      reason: mode === 'terminal-peer-noack' ? 'awaiting-buddy-acceptance' : 'host-continuation',
      'updated-at': new Date().toISOString(),
      execution: mode === 'terminal-peer-noack' ? {} : { host_continuation_id: request?.id },
    };
    const peerFile = path.join(root, 'workers', 'w1.json');
    fs.writeFileSync(peerFile + '.tmp', JSON.stringify(peer));
    fs.renameSync(peerFile + '.tmp', peerFile);
  }
  const file = path.join(root, 'workers', 'w0.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(state));
  fs.renameSync(file + '.tmp', file);
};
update();
setInterval(update, 30);
