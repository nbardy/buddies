import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  type ShutdownOptions,
  type ShutdownPorts,
  createShutdownController,
} from '../src/lifecycle/shutdown';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

// Graces long enough that only the one under test can fire.
const INERT: ShutdownOptions = {
  forceExitGraceMs: 60_000,
  flushGraceMs: 60_000,
};

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function createFixture(activeInitially: boolean) {
  // `activeInitially` = one scheduler run in flight. Queued messages no longer hold a reload
  // (they are durable rows), so the fixture models only work that is still in memory.
  let activeSchedulerRuns = activeInitially ? 1 : 0;
  let schedulerPauses = 0;
  let schedulerResumes = 0;
  let schedulerStops = 0;
  let flushes = 0;
  let exits = 0;
  const pendingFlush = deferred();
  const ports: ShutdownPorts = {
    activeSchedulerRuns: () => activeSchedulerRuns,
    pauseScheduler: () => {
      schedulerPauses += 1;
    },
    resumeScheduler: () => {
      schedulerResumes += 1;
    },
    stopScheduler: () => {
      schedulerStops += 1;
    },
    flushState: () => {
      flushes += 1;
      return pendingFlush.promise;
    },
    exit: () => {
      exits += 1;
    },
  };
  return {
    pendingFlush,
    ports,
    setActive: (value: boolean) => {
      activeSchedulerRuns = value ? 1 : 0;
    },
    setActiveSchedulerRuns: (value: number) => {
      activeSchedulerRuns = value;
    },
    counts: () => ({
      schedulerPauses,
      schedulerResumes,
      schedulerStops,
      flushes,
      exits,
    }),
  };
}

test('SIGTERM claims shutdown before its single flush can be re-entered', async () => {
  const fixture = createFixture(false);
  const controller = createShutdownController(INERT, fixture.ports);

  controller.handleSigterm();
  controller.handleSigterm();

  assert.equal(controller.state, 'exiting');
  assert.deepEqual(fixture.counts(), {
    schedulerPauses: 0,
    schedulerResumes: 0,
    schedulerStops: 1,
    flushes: 1,
    exits: 0,
  });

  fixture.pendingFlush.resolve();
  await fixture.pendingFlush.promise;
  await Promise.resolve();
  assert.equal(fixture.counts().exits, 1);
  controller.dispose();
});

test('reload waits for memory-only work and coalesces repeated requests', async () => {
  const fixture = createFixture(true);
  const controller = createShutdownController(INERT, fixture.ports);
  assert.equal(controller.beginMutation(), null);
  const startupCreation = controller.beginMutation({ allowDuringStartup: true });
  assert.ok(startupCreation);
  startupCreation();
  assert.equal(controller.completeStartup(), true);
  const admissionProbe = controller.beginMutation();
  assert.ok(admissionProbe);
  admissionProbe();

  controller.handleReload();
  assert.equal(controller.state, 'idle');
  const workDuringDeferral = controller.beginMutation();
  assert.ok(workDuringDeferral);
  workDuringDeferral();
  controller.handleReload();

  assert.deepEqual(fixture.counts(), {
    schedulerPauses: 0,
    schedulerResumes: 0,
    schedulerStops: 0,
    flushes: 0,
    exits: 0,
  });

  fixture.setActive(false);
  await sleep(550);
  assert.equal(fixture.counts().flushes, 1);
  fixture.pendingFlush.resolve();
  await fixture.pendingFlush.promise;
  await Promise.resolve();
  assert.equal(fixture.counts().exits, 1);
  controller.dispose();
});

/**
 * Incident 2026-08-22. A reload used to move into an absorbing state and then
 * either kill an ordinary provider turn or leave the backend permanently
 * read-only. A pending reload is now only intent: the owning server remains
 * fully available until it observes a genuine idle boundary.
 */
test('a pending reload remains fully available without interrupting its live turn', async () => {
  const fixture = createFixture(true);
  const controller = createShutdownController(INERT, fixture.ports);
  assert.equal(controller.completeStartup(), true);

  controller.handleReload();
  assert.equal(controller.state, 'idle');
  const admittedDuringDeferral = controller.beginMutation();
  assert.ok(admittedDuringDeferral);
  admittedDuringDeferral();

  await sleep(650);
  assert.equal(controller.state, 'idle');
  const admittedLater = controller.beginMutation();
  assert.ok(admittedLater, 'pending reload never turns the old owner read-only');
  admittedLater();
  assert.equal(fixture.counts().schedulerPauses, 0, 'scheduler remains live while work is active');
  assert.equal(fixture.counts().flushes, 0);

  fixture.setActive(false);
  await sleep(550);
  assert.equal(fixture.counts().flushes, 1);
  fixture.pendingFlush.resolve();
  await fixture.pendingFlush.promise;
  await Promise.resolve();
  assert.equal(fixture.counts().exits, 1);
  controller.dispose();
});

test('pending reload waits for admitted mutations and active automation wrappers', async () => {
  const fixture = createFixture(false);
  fixture.setActiveSchedulerRuns(1);
  const controller = createShutdownController(INERT, fixture.ports);
  assert.equal(controller.completeStartup(), true);
  const releaseMutation = controller.beginMutation();
  assert.ok(releaseMutation);

  controller.handleReload();
  await sleep(650);

  assert.equal(controller.state, 'idle');
  assert.equal(fixture.counts().schedulerStops, 0, 'reload never cancels an active automation');
  assert.equal(fixture.counts().schedulerPauses, 0);
  assert.equal(fixture.counts().flushes, 0);

  fixture.setActiveSchedulerRuns(0);
  await sleep(550);
  assert.equal(fixture.counts().flushes, 0, 'admitted mutation still owns the process');

  releaseMutation();
  await sleep(550);
  assert.equal(fixture.counts().flushes, 1);
  fixture.pendingFlush.resolve();
  await fixture.pendingFlush.promise;
  controller.dispose();
});

test('reload resumes the scheduler when pausing reveals newly active work', async () => {
  let schedulerWork = 0;
  let revealWorkOnPause = true;
  let pauses = 0;
  let resumes = 0;
  let exits = 0;
  const controller = createShutdownController(INERT, {
    activeSchedulerRuns: () => schedulerWork,
    pauseScheduler: () => {
      pauses += 1;
      if (revealWorkOnPause) schedulerWork = 1;
    },
    resumeScheduler: () => {
      resumes += 1;
      schedulerWork = 0;
    },
    stopScheduler: () => undefined,
    flushState: () => undefined,
    exit: () => {
      exits += 1;
    },
  });
  assert.equal(controller.completeStartup(), true);

  controller.handleReload();

  assert.equal(controller.state, 'idle');
  assert.equal(pauses, 1);
  assert.equal(resumes, 1);
  assert.equal(exits, 0);

  revealWorkOnPause = false;
  await sleep(550);
  await Promise.resolve();
  assert.equal(pauses, 2);
  assert.equal(resumes, 1);
  assert.equal(exits, 1);
  controller.dispose();
});

// 2026-09-30: reload used to wait for every running turn (it starved for 20+ minutes under steady
// Buddy work) and SIGTERM stopped them all. A running provider is journaled and adopted by the next
// backend, so no exit waits for it or signals it, and it finishes its work after the exit.
for (const exit of ['reload', 'SIGTERM'] as const) {
  test(`${exit} exits at once and leaves a real running provider process to finish`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'unleashd-reload-provider-'));
    const marker = join(directory, 'completed');
    const child = spawn(
      process.execPath,
      [
        '-e',
        "setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'ok'), 650)",
        marker,
      ],
      { detached: true, stdio: 'ignore' }
    );
    let flushed = 0;
    let exited = 0;
    // A conversation whose only work is that running turn.
    const controller = createShutdownController(INERT, {
      activeSchedulerRuns: () => 0,
      pauseScheduler: () => undefined,
      resumeScheduler: () => undefined,
      stopScheduler: () => undefined,
      flushState: () => {
        flushed += 1;
      },
      exit: () => {
        exited += 1;
      },
    });
    t.after(() => {
      controller.dispose();
      if (child.exitCode === null && child.pid != null) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
      }
      rmSync(directory, { recursive: true, force: true });
    });
    assert.equal(controller.completeStartup(), true);

    if (exit === 'reload') controller.handleReload();
    else controller.handleSigterm();
    await sleep(100);

    assert.equal(flushed, 1, 'the exit did not wait for the running turn');
    assert.equal(exited, 1);
    assert.equal(child.exitCode, null, 'the provider is still running after the exit');
    await new Promise<void>((resolve) => child.once('close', () => resolve()));
    assert.equal(existsSync(marker), true, 'the provider finished its work');
  });
}

/**
 * Incident 2026-09-23: a backend started at 01:31 outlived the dev runner that
 * spawned it, kept the port, and served a stale Buddies package for hours.
 * Losing the parent's IPC channel must shut the backend down.
 */
test('a backend exits when its dev runner goes away', async (t) => {
  const shutdownModule = join(__dirname, '..', 'src', 'lifecycle', 'shutdown.ts');
  // An agent shell spawned under the dev runner inherits WATCH_REPORT_DEPENDENCIES=1.
  // With it, Node reports every module load over this child's IPC channel, and the
  // report sent after disconnect() throws EPIPE, failing the test on a healthy build
  // (2026-09-25). The child must not act as a watched backend.
  const { WATCH_REPORT_DEPENDENCIES: _watched, ...env } = process.env;
  const backend = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '-e',
      `const { registerShutdownHandlers } = require(${JSON.stringify(shutdownModule)});
       const controller = registerShutdownHandlers({ forceExitGraceMs: 1000, flushGraceMs: 1000 }, {
         activeSchedulerRuns: () => 0, pauseScheduler() {},
         resumeScheduler() {}, stopScheduler() {}, flushState() {},
         exit: (code) => process.exit(code),
       });
       controller.completeStartup();
       setInterval(() => {}, 1000);
       process.send('ready');`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], env }
  );
  t.after(() => {
    if (backend.exitCode === null) backend.kill('SIGKILL');
  });
  await new Promise<void>((resolve) => backend.once('message', () => resolve()));
  const exited = new Promise<number | null>((resolve) =>
    backend.once('exit', (code) => resolve(code))
  );
  backend.disconnect();
  const code = await Promise.race([exited, sleep(5000).then(() => 'still running' as const)]);
  assert.equal(code, 0);
});

/**
 * Incident 2026-08-20. exitOnce() clears every drain timer before awaiting
 * flushState(), so a flush that never settles left the process alive in
 * `exiting` with nothing armed to rescue it — same user-visible symptom, but
 * permanent. flushState() awaits turnAttemptJournal.flush(), which queues behind
 * every in-flight journal write, so "never settles" is reachable in production.
 */
test('a state flush that never settles still exits the process', async () => {
  const fixture = createFixture(false);
  const controller = createShutdownController({ ...INERT, flushGraceMs: 200 }, fixture.ports);
  assert.equal(controller.completeStartup(), true);

  controller.handleSigterm();
  assert.equal(controller.state, 'exiting');
  assert.equal(fixture.counts().flushes, 1);
  assert.equal(fixture.counts().exits, 0, 'exit is still waiting on the flush');

  await sleep(350);
  assert.equal(fixture.counts().exits, 1, 'watchdog exits despite the hung flush');
  controller.dispose();
});

/**
 * handleShutdown used to call waitForDrain (which arms the force-exit timer) and
 * then immediately overwrite the handle with its own timer, leaking one that
 * clearTimers()/dispose() could never reach. The shutdown path must force-exit on
 * forceExitGraceMs, never on the much longer reload grace.
 */
test('shutdown force-exits on the shutdown grace, not the reload grace', async () => {
  const fixture = createFixture(false);
  // A scheduler run is work the exit waits for, so the drain is still open when the grace
  // expires.
  fixture.setActiveSchedulerRuns(1);
  const controller = createShutdownController({ ...INERT, forceExitGraceMs: 300 }, fixture.ports);
  assert.equal(controller.completeStartup(), true);

  controller.handleSigterm();
  assert.equal(controller.state, 'shutting_down');
  assert.equal(fixture.counts().flushes, 0, 'still draining the scheduler run');

  await sleep(450);
  assert.equal(fixture.counts().flushes, 1, 'forced at forceExitGraceMs');
  fixture.pendingFlush.resolve();
  await fixture.pendingFlush.promise;
  await Promise.resolve();
  assert.equal(fixture.counts().exits, 1);
  controller.dispose();
});
